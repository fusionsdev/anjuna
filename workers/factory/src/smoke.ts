import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";

// Nine attempts, 200s of durable waits and at most 90s of step execution.
export const SMOKE_RETRY_CONFIG = {
  retries: { limit: 8, delay: "25 seconds", backoff: "constant" },
  timeout: "10 seconds",
} satisfies WorkflowStepConfig;

async function checkEndpoint(hostname: string, host: "apex" | "www", apex: string): Promise<number> {
  const url = `https://${hostname}/`;
  let response: Response;
  let body = "";
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    if (host === "apex" && response.status === 200) body = await response.text();
    else await response.body?.cancel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(?:ENOTFOUND|EAI_AGAIN)\b|DNS (?:lookup|resolution) failed|could not resolve host/i.test(message)) {
      throw new Error(`Smoke: ${host} DNS resolution failed`);
    }
    // Do not hide application exceptions or arbitrary fetch failures as propagation.
    throw new NonRetryableError(`Smoke: ${host} request failed: ${message}`);
  }

  const expected = host === "apex" ? 200 : 301;
  if (response.status !== expected) {
    const message = `Smoke: ${host} returned ${response.status} (expected ${expected}; cf-ray=${response.headers.get("cf-ray") ?? "unknown"})`;
    if (response.status >= 520 && response.status <= 530) throw new Error(message);
    throw new NonRetryableError(message);
  }
  if (host === "apex" && (!/<span\b[^>]*\sdata-kw(?:\s|=|>)/i.test(body) || !/<form\b[^>]*\sdata-cta(?:\s|=|>)/i.test(body))) {
    throw new NonRetryableError("Smoke: apex missing expected landing content (data-kw/data-cta)");
  }
  if (host === "www" && response.headers.get("location") !== `https://${apex}/`) {
    throw new NonRetryableError("Smoke: www redirect does not target the apex");
  }
  return response.status;
}

/**
 * Smokes the brand hostnames: the first is the brand apex (200 with landing content), a
 * second is its www (301 to the apex). Subdomain brands pass a single hostname.
 */
export async function smokeBrand(hostnames: string[]): Promise<{ apex_status: number; www_status?: number }> {
  const apex = hostnames[0]!;
  const results = await Promise.allSettled(
    hostnames.map((hostname, index) => checkEndpoint(hostname, index === 0 ? "apex" : "www", apex)),
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
