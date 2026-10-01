// Same-origin, best-effort traffic/funnel telemetry -> D1 `traffic_events`
// (see POST /api/telemetry in functions/api/[[path]].ts).
//
// Deliberately separate from lib/analytics.ts (PostHog): this is AURUM's own operational
// store, so funnel drop-off stays visible even when PostHog is not. As of 2026-09-07 it is
// not: the PostHog browser SDK loads on production (`__loaded: true`, not opted out, remote
// config and /flags healthy) but emits zero ingest requests — reproduced on a clean page with
// minimal init options, headed and headless, and with a bogus token. This path must therefore
// stand entirely on its own.
//
// WHY PER-STEP EVENTS EXIST: between 2026-08-20 and 2026-08-26 the blended click->lead rate
// fell from ~25% to ~16% and nobody could say where in the 14 steps the loss happened, because
// `leads` records only completions and `client_errors` produced one row in 14 days. The
// question was eventually answered by diffing archived Cloudflare deployment bundles — which
// worked only because those artifacts happened to still exist, and Cloudflare keeps just 75.
// That must not be the instrument next time.
//
// Fire-and-forget and fail-open by construction — nothing here may ever throw into caller code
// or delay the funnel. The server enforces the same allowlist/bounds independently; this
// client-side allowlist only avoids a pointless network call for an event the server would
// drop anyway.
//
// PRIVACY: only coarse, non-identifying signals are sent. Never PII, never a raw click id
// (gclid/msclkid/fbclid), never a full URL or query string, and never a free-text error
// message — only an allowlisted error CODE. `session_id` is the same opaque per-tab id already
// used for PostHog and already stored on the lead row; on its own it identifies nobody.

const ALLOWED_TRAFFIC_EVENTS = new Set([
  "landing_viewed",
  "form_started",
  "form_step_viewed",
  "form_step_completed",
  "form_validation_failed",
  "lead_submission_started",
  "lead_submitted",
  "redirect_started",
  "redirect_failed",
]);

// Closed set of non-PII failure codes. A code not on this list is dropped rather than
// forwarded, so a future caller cannot smuggle a validation message — which can contain what
// the applicant typed — into the operational store.
const ALLOWED_ERROR_CODES = new Set([
  "field_validation",
  "consent_missing",
  "zip_lookup_failed",
  "zip_lookup_timeout",
  "submit_timeout",
  "submit_http_error",
  "submit_network_error",
  "submit_rejected",
  "state_unsupported",
  "duplicate_lead",
  "storage_unavailable",
]);

function classifyDevice(): "mobile" | "tablet" | "desktop" | "unknown" {
  if (typeof window === "undefined") return "unknown";
  const w = window.innerWidth;
  if (!Number.isFinite(w)) return "unknown";
  if (w < 640) return "mobile";
  if (w < 1024) return "tablet";
  return "desktop";
}

function classifyBrowser(): "chrome" | "safari" | "firefox" | "edge" | "other" | "unknown" {
  if (typeof navigator === "undefined" || !navigator.userAgent) return "unknown";
  const ua = navigator.userAgent;
  if (/edg\//i.test(ua)) return "edge";
  if (/firefox|fxios/i.test(ua)) return "firefox";
  if (/chrome|crios/i.test(ua)) return "chrome";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}

function isTouchCapable(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
}

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// NOTE: hostname is deliberately NOT part of this payload. The endpoint is public and this
// bundle is editable by anyone, so a client-supplied host is forgeable — and a forged host in
// the operational store would silently misattribute a brand's funnel. The worker derives it
// from `request.url` instead, which the client cannot influence. Keeping a client copy here
// would only invite a reader to trust the wrong column.

let _endpoint: string | undefined;
let _formVersion: string | undefined;
let _formVariant: string | undefined;
let _buildId: string | undefined;

/**
 * Called once from main.tsx alongside initPostHog/initSentry.
 *
 * The previous version of this module exported this function and nothing called it, so
 * `_endpoint` was permanently undefined and every sendTraffic() returned at the first guard.
 * The build then tree-shook it out entirely: the shipped bundle contained no reference to it
 * at all and the compiled sendTraffic reduced to `if(!e)return`. Silent, total, and invisible
 * for as long as it existed. Any change here must keep a real caller.
 */
export function initTrafficTelemetry(
  endpoint: string,
  meta: { formVersion?: string; formVariant?: string; buildId?: string } = {},
) {
  _endpoint = endpoint;
  _formVersion = meta.formVersion;
  _formVariant = meta.formVariant;
  // Never leave this null. A row that cannot name the bundle it came from is useless for the
  // one question this table exists to answer — "did that deploy change the funnel?" — and
  // VITE_SENTRY_RELEASE is unset in plenty of build environments.
  _buildId = meta.buildId || "unknown";
}

/** Test seam: lets a test assert the "never initialised" behaviour explicitly. */
export function __resetTrafficTelemetryForTests() {
  _endpoint = undefined;
  _formVersion = undefined;
  _formVariant = undefined;
  _buildId = undefined;
}

export function sendTraffic(
  eventType: string,
  sessionId: string,
  extra: {
    source?: string;
    campaign?: string;
    brand?: string;
    form_step?: number;
    error_code?: string;
  } = {},
): void {
  try {
    if (!_endpoint || typeof window === "undefined" || !sessionId) return;
    if (!ALLOWED_TRAFFIC_EVENTS.has(eventType)) return;

    const errorCode =
      extra.error_code && ALLOWED_ERROR_CODES.has(extra.error_code) ? extra.error_code : undefined;
    const step =
      typeof extra.form_step === "number" && Number.isFinite(extra.form_step)
        ? Math.trunc(extra.form_step)
        : undefined;

    const payload = {
      event_type: eventType,
      session_id: sessionId,
      occurred_at: new Date().toISOString(),
      form_version: _formVersion,
      form_variant: _formVariant,
      build_id: _buildId,
      device_class: classifyDevice(),
      browser_family: classifyBrowser(),
      browser_timezone: browserTimezone(),
      touch_capable: isTouchCapable(),
      brand: extra.brand,
      source: extra.source,
      campaign: extra.campaign,
      form_step: step,
      error_code: errorCode,
    };
    const body = JSON.stringify(payload);

    // sendBeacon survives page unload (critical for redirect_started, fired right before
    // window.location.assign()); fetch+keepalive is the fallback for browsers without it.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(_endpoint, new Blob([body], { type: "application/json" }));
    } else {
      fetch(_endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        /* fail open */
      });
    }
  } catch {
    // Fail open: telemetry must never throw into caller code or affect the funnel.
  }
}
