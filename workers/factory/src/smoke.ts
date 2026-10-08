import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";

// Nine attempts, 200s of durable waits and at most 90s of step execution.
export const SMOKE_RETRY_CONFIG = {
  retries: { limit: 8, delay: "25 seconds", backoff: "constant" },
  timeout: "10 seconds",
} satisfies WorkflowStepConfig;

async function checkEndpoint(domain: string, host: "apex" | "www"): Promise<number> {
  const url = `https://${host === "www" ? "www." : ""}${domain}/`;
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
  if (host === "www" && response.headers.get("location") !== `https://${domain}/`) {
    throw new NonRetryableError("Smoke: www redirect does not target the apex");
  }
  return response.status;
}

export async function smokeBrand(domain: string): Promise<{ apex_status: number; www_status: number }> {
  const results = await Promise.allSettled([checkEndpoint(domain, "apex"), checkEndpoint(domain, "www")]);
  // An application failure wins even if the other hostname is still propagating.
  for (const result of results) {
    if (result.status === "rejected" && result.reason instanceof NonRetryableError) throw result.reason;
  }
  const [apex, www] = results;
  if (apex.status === "rejected") throw apex.reason;
  if (www.status === "rejected") throw www.reason;
  return { apex_status: apex.value, www_status: www.value };
}
