import { installPostHogStub } from "./posthog-stub";

// PostHog typed analytics gateway - the stub (lib/posthog-stub.ts) is installed on init and loads
// the SDK through the brand's first-party proxy path; init is called from main.tsx. Only allowlisted events and properties are ever transmitted.
// Never call posthog.identify() for loan applicants.

declare global {
  interface Window {
    posthog?: {
      init(key: string, opts: Record<string, unknown>): void;
      capture(event: string, props?: Record<string, unknown>): void;
      register(props: Record<string, unknown>): void;
      opt_out_capturing(): void;
    };
  }
}

const ALLOWED_EVENTS = new Set([
  "landing_viewed",
  "form_started",
  "form_step_viewed",
  "form_step_completed",
  "form_validation_failed",
  "lead_submission_started",
  "lead_submitted",
  "redirect_started",
  "redirect_succeeded",
  "redirect_failed",
]);
// experiment_assigned (and its experiment_provider/experiment_id/variant_id properties) was
// allowlisted with no real experiment system behind it and no call site anywhere in this
// codebase — an event nothing ever fires is not a capability, it's a trap for a future caller
// to wire up incorrectly. Removed rather than kept as dead surface; re-add alongside whatever
// actually assigns variants if/when a real experiment system exists.

const ALLOWED_PROPS = new Set([
  "anonymous_session_id",
  "opaque_click_session_id",
  "domain",
  "route",
  "campaign_id",
  "adgroup_id",
  "ad_id",
  "keyword",
  "aid",
  "entry_source",
  "requested_amount_bucket",
  "form_step",
  "submission_stage",
  "failure_category",
  "http_status",
]);

// A key allowlist alone doesn't bound what rides inside an allowed key's VALUE. Several allowed
// props (entry_source, keyword, campaign_id, ...) are ultimately sourced from the landing URL's
// query string — cap length and reject anything URL/query-shaped so a malformed or hostile
// tracking param can't smuggle a full URL, another tracker's payload, or an oversized blob into
// PostHog under a legitimate-looking key.
const MAX_PROP_VALUE_LENGTH = 128;
function sanitizePropValue(value: unknown): unknown {
  if (typeof value !== "string") return value; // numbers/booleans pass through unchanged
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!stripped) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)) return undefined; // any-scheme URL => reject
  if (/[?&]\S+=/.test(stripped)) return undefined; // query-string-shaped => reject
  return stripped.slice(0, MAX_PROP_VALUE_LENGTH);
}

// Set to true after initPostHog() — gates all trackEvent() calls.
let _initialized = false;

// FO-3 / BR-11: the bundle never carries a real project key. The client sends this placeholder
// to the brand's first-party PostHog proxy path, and the brand Worker swaps in the real key
// server-side. `disable_compression` keeps request bodies plain JSON so the Worker can do that.
export const POSTHOG_PLACEHOLDER_KEY = "placeholder";

/**
 * Start PostHog only when the brand Worker provided a proxy path (runtime config). No proxy
 * path = PostHog stays off, so nothing ever goes straight to a third-party origin.
 */
export function initPostHog(proxyPath: string | undefined) {
  if (!proxyPath) return;
  if (typeof window === "undefined") return;
  if (!window.posthog) installPostHogStub(proxyPath);
  if (!window.posthog) return;
  _initialized = true;
  window.posthog.init(POSTHOG_PLACEHOLDER_KEY, {
    api_host: proxyPath,
    disable_compression: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    persistence: "sessionStorage",
    // Explicit: the CDN bundle is unpinned, so never inherit a future default
    // that would create person profiles for applicants.
    person_profiles: "identified_only",
  });
}

export function registerSessionContext(
  sessionId: string,
  trackingParams: Record<string, string>
) {
  if (!_initialized || typeof window === "undefined" || !window.posthog) return;
  const safe: Record<string, unknown> = {
    anonymous_session_id: sessionId,
    domain: window.location.hostname,
  };
  // Only forward approved, non-PII tracking dimensions (raw gclid/msclkid/fbclid blocked)
  const fwd = ["campaign_id", "adgroup_id", "ad_id", "keyword", "aid"] as const;
  for (const k of fwd) {
    if (trackingParams[k]) safe[k] = trackingParams[k];
  }
  window.posthog.register(safe);
}

function stripUnsafe(props: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(k)) {
      if (import.meta.env.DEV) console.warn(`[analytics] blocked prop: "${k}"`);
      continue;
    }
    const sanitized = sanitizePropValue(v);
    if (sanitized === undefined) {
      if (import.meta.env.DEV) console.warn(`[analytics] blocked value for prop: "${k}"`);
      continue;
    }
    safe[k] = sanitized;
  }
  return safe;
}

export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  if (!_initialized) return;
  if (!ALLOWED_EVENTS.has(event)) {
    if (import.meta.env.DEV) console.warn(`[analytics] blocked event: "${event}"`);
    return;
  }
  if (typeof window === "undefined" || !window.posthog) return;
  window.posthog.capture(event, stripUnsafe(props));
}

// Dedup guard — form_started fires at most once per page load.
let _formStartedSent = false;
export function trackFormStarted(sessionId: string) {
  if (_formStartedSent) return;
  _formStartedSent = true;
  trackEvent("form_started", { anonymous_session_id: sessionId });
}
