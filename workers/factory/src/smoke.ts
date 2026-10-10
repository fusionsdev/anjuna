import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";

// Nine attempts, 200s of durable waits and at most 90s of step execution.
export const SMOKE_RETRY_CONFIG = {
  retries: { limit: 8, delay: "25 seconds", backoff: "constant" },
  timeout: "10 seconds",
} satisfies WorkflowStepConfig;

// The pause page served by brand-runtime for an operator-paused brand.
const PAUSE_PAGE_MARKER = /temporarily unavailable/i;
const FORBIDDEN_BRAND_BYTES = /anjuna|aurum/i;

async function checkEndpoint(hostname: string, host: "apex" | "www", apex: string, paused: boolean): Promise<number> {
  const url = `https://${hostname}/`;
  let response: Response;
  let body = "";
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    if (host === "apex" && response.status === (paused ? 503 : 200)) body = await response.text();
    else await response.body?.cancel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(?:ENOTFOUND|EAI_AGAIN)\b|DNS (?:lookup|resolution) failed|could not resolve host/i.test(message)) {
      throw new Error(`Smoke: ${host} DNS resolution failed`);
    }
    // Do not hide application exceptions or arbitrary fetch failures as propagation.
    throw new NonRetryableError(`Smoke: ${host} request failed: ${message}`);
  }

  const expected = host === "www" ? 301 : paused ? 503 : 200;
  if (response.status !== expected) {
    const message = `Smoke: ${host} returned ${response.status} (expected ${expected}; cf-ray=${response.headers.get("cf-ray") ?? "unknown"})`;
    if (response.status >= 520 && response.status <= 530) throw new Error(message);
    throw new NonRetryableError(message);
  }
  if (host === "apex" && paused) {
    if (FORBIDDEN_BRAND_BYTES.test(body)) throw new NonRetryableError("Smoke: pause page contains a forbidden brand string");
    if (!PAUSE_PAGE_MARKER.test(body)) throw new NonRetryableError("Smoke: apex 503 is not the pause page");
  } else if (host === "apex" && (!/<span\b[^>]*\sdata-kw(?:\s|=|>)/i.test(body) || !/<form\b[^>]*\sdata-cta(?:\s|=|>)/i.test(body))) {
    throw new NonRetryableError("Smoke: apex missing expected landing content (data-kw/data-cta)");
  }
  if (host === "www" && response.headers.get("location") !== `https://${apex}/`) {
    throw new NonRetryableError("Smoke: www redirect does not target the apex");
  }
  return response.status;
}

/**
 * Smokes the brand hostnames: the first is the brand apex (200 with landing content), a
 * second is its www (301 to the apex). Subdomain brands pass a single hostname. A paused
 * brand serves the pause page instead, so its apex must answer 503 with that page.
 */
export async function smokeBrand(hostnames: string[], { paused = false }: { paused?: boolean } = {}): Promise<{ apex_status: number; www_status?: number }> {
  const apex = hostnames[0]!;
  const results = await Promise.allSettled(
    hostnames.map((hostname, index) => checkEndpoint(hostname, index === 0 ? "apex" : "www", apex, paused)),
  );
  // An application failure wins even if the other hostname is still propagating.
  for (const result of results) {
    if (result.status === "rejected" && result.reason instanceof NonRetryableError) throw result.reason;
  }
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const statuses = results.map((result) => (result as PromiseFulfilledResult<number>).value);
  return hostnames.length > 1 ? { apex_status: statuses[0]!, www_status: statuses[1]! } : { apex_status: statuses[0]! };
}
