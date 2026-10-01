/**
 * Constants and pure helpers copied from V1 (`fusion_formv_v1@8404ec2`), so every Anjuna
 * component shares one definition of the money-path numbers. Each value names its V1 source.
 */

/** Port provenance. Tests check the vendored V1 files against these. */
export const V1_SOURCE = {
  core: { repo: "fusionsdev/fusion_formv_v1", branch: "anjuna-port-base", commit: "8404ec27d95985b4eb3ff980a833a1b2f2fbeb05" },
  form: { repo: "fusionsdev/aurum-form", branch: "anjuna-port-base", commit: "8ba11d3db04ab605846b6b055b111da059aa7e26" },
} as const;

/** `functions/api/[[path]].ts` MAX_PAYOUT_USD. */
export const MAX_PAYOUT_USD = 230;
/** `functions/api/[[path]].ts` CONV_MAX_ATTEMPTS: after this many failed tries a row goes 'dead'. */
export const CONV_MAX_ATTEMPTS = 6;
/** `functions/api/[[path]].ts` CONV_RETRY_BASE_MS: 5m, 10m, 20m, ... */
export const CONV_RETRY_BASE_MS = 5 * 60_000;
/** `functions/api/[[path]].ts` CONV_RETRY_MAX_MS: a single backoff is capped at 6h. */
export const CONV_RETRY_MAX_MS = 6 * 60 * 60_000;
/** `functions/api/[[path]].ts` CONV_LEASE_STALE_MS: stale 'processing' reclaim; also the 'deferred' delay. */
export const CONV_LEASE_STALE_MS = 30 * 60_000;
/** `functions/api/[[path]].ts` pending `limit`: default, min, max. */
export const PENDING_LIMIT = { default: 100, min: 1, max: 500 } as const;
/** `functions/_middleware.ts` CLICK_MAX_AGE (seconds): matches the Google click window. */
export const CLICK_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** `functions/api/[[path]].ts` validateLeadPayload requested_amount range. */
export const REQUESTED_AMOUNT_RANGE = { min: 100, max: 5000 } as const;
/** `aurum-form/src/App.tsx` REQUESTED_AMOUNT_BUCKETS: amounts a landing may hand off. */
export const V1_AMOUNT_BUCKETS = [350, 500, 750, 1000, 1500, 1750, 2000, 2500, 3000, 3250, 4500, 5000] as const;
/** CO-1: `STATE_MODE=block`, `UNSUPPORTED_STATES`. */
export const V1_UNSUPPORTED_STATES = ["NY", "AR", "VT", "WV"] as const;

/** `functions/api/[[path]].ts` convBackoffMs: backoff for the Nth (1-based) failed attempt. */
export function convBackoffMs(attempt: number): number {
  return Math.min(CONV_RETRY_MAX_MS, CONV_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * `functions/api/[[path]].ts` handleLead: our click id is the lead_id without hyphens
 * (LeadsGate's `{click_id}` accepts letters and digits only). LeadsGate echoes it back as `cid`.
 */
export function clickIdFromLeadId(leadId: string): string {
  return leadId.replace(/-/g, "");
}

/**
 * `functions/api/[[path]].ts` clean(): strip control characters, collapse whitespace, trim, cap.
 * Used by V1 on every inbound string (postback query, ack rows, lead fields).
 */
export function v1Clean(value: unknown, maxLength: number): string {
  const s = String(value ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += s[i];
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** `functions/api/[[path]].ts` isUuidLike: crypto.randomUUID() or the form's fallback id. */
export const V1_UUID_LIKE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|fallback-\d+-[0-9a-z]+)$/i;
