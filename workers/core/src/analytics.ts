import {
  ANALYTICS_FORWARD_PATHS, ANALYTICS_KINDS, ANALYTICS_LIMITS, AnalyticsForwardRequest, type AnalyticsKind,
} from "@anjuna/contracts";
import { ownsBrand } from "./auth.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import type { RpcHandler } from "./index.js";
import { getRuntime, ownsHostname } from "./rpc/runtime.js";

const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
/** Ingest endpoints only. Static assets, replay and the admin API are never reachable through the proxy. */
const POSTHOG_PATHS = /^\/(?:e|i\/v0\/e|batch|capture|flags|decide)\/?$/;
const UPSTREAM_TIMEOUT_MS = 2500;

// V1 allowlists (functions/api/[[path]].ts). The endpoint is public, so this is the boundary
// that decides what reaches D1.
const TRAFFIC_EVENTS = new Set([
  "gate_viewed", "landing_viewed", "form_started", "form_step_viewed", "form_step_completed",
  "form_validation_failed", "lead_submission_started", "lead_submitted", "redirect_started", "redirect_failed",
]);
const TRAFFIC_ERROR_CODES = new Set([
  "field_validation", "consent_missing", "zip_lookup_failed", "zip_lookup_timeout", "submit_timeout",
  "submit_http_error", "submit_network_error", "submit_rejected", "state_unsupported", "duplicate_lead", "storage_unavailable",
]);
const TRAFFIC_DEVICE_CLASSES = new Set(["mobile", "tablet", "desktop", "unknown"]);
const TRAFFIC_BROWSERS = new Set(["chrome", "safari", "firefox", "edge", "other", "unknown"]);

class InvalidPayload extends Error {}

const accepted = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
const rejected = (status: 400 | 413) => json({ error: "invalid" }, status);

const warned = new Set<string>();
/** One line per message and kind per isolate: a dropped kind is visible in logs without a line per event. */
function warnOnce(msg: string, kind: AnalyticsKind): void {
  if (warned.has(`${msg}:${kind}`)) return;
  warned.add(`${msg}:${kind}`);
  console.warn(JSON.stringify({ msg, kind }));
}
function notConfigured(kind: AnalyticsKind): Response {
  warnOnce("analytics_not_configured", kind);
  return accepted();
}

/**
 * Ceiling per brand and kind in `period` seconds. The rate limit bindings in the three core wrangler
 * configs declare the same numbers (a test keeps them equal); `namespace_id` is any integer unique in
 * the account. V1 allowed 3000 telemetry events an hour per IP (50 a minute), but core never sees the
 * visitor IP, so these cap a whole brand. All four sit far above today's volume (V1 took about 1,000
 * leads in total) and bound what a flood can write or spend.
 * - telemetry 600: one finished application emits about 32 events, so 600 a minute is 18 applications
 *   a minute on one brand; a flood adds at most 600 small D1 rows a minute.
 * - errors 30: one row per failed submit, so 30 a minute is a core outage burst, not normal traffic.
 * - posthog 300: each request is a billed PostHog event, kept below telemetry because quota costs money.
 * - sentry 60: Sentry's quota is the smallest and errors are rare; 60 envelopes a minute is 1 a second.
 */
export const ANALYTICS_RATE_LIMITS = {
  posthog: { binding: "POSTHOG_LIMITER", namespace_id: "4101", limit: 300, period: 60 },
  sentry: { binding: "SENTRY_LIMITER", namespace_id: "4102", limit: 60, period: 60 },
  telemetry: { binding: "TELEMETRY_LIMITER", namespace_id: "4103", limit: 600, period: 60 },
  errors: { binding: "ERRORS_LIMITER", namespace_id: "4104", limit: 30, period: 60 },
} as const satisfies Record<AnalyticsKind, { binding: string; namespace_id: string; limit: number; period: 10 | 60 }>;

/** Fails open: an absent or failing binding must not stop analytics, which is best effort. */
async function withinLimit(kind: AnalyticsKind, brandId: string, env: Env): Promise<boolean> {
  const limiter = env[ANALYTICS_RATE_LIMITS[kind].binding];
  if (!limiter) { warnOnce("analytics_rate_limit_not_configured", kind); return true; }
  try {
    // Core never sees the visitor IP, so one flood throttles one brand's one kind and nothing else.
    return (await limiter.limit({ key: `${kind}:${brandId}` })).success;
  } catch { return true; }
}

// Same cleaning as V1: control characters out, whitespace collapsed, capped.
function clean(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function pick(value: unknown, allowed: Set<string>): string | null {
  const v = clean(value, 32);
  return v && allowed.has(v) ? v : null;
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch { return {}; }
}

/** Client clocks are wrong. Keep a plausible timestamp, otherwise use server time and flag it (V1). */
function resolveOccurredAt(raw: unknown, nowMs: number): { at: string; skewed: 0 | 1 } {
  const text = clean(raw, 40);
  const t = text ? Date.parse(text) : NaN;
  const age = nowMs - t;
  if (!Number.isFinite(t) || age > 86_400_000 || age < -300_000) return { at: new Date(nowMs).toISOString(), skewed: 1 };
  return { at: new Date(t).toISOString(), skewed: 0 };
}

/** V1 handleTrafficTelemetry. Answers 204 whatever breaks: telemetry must never gate the funnel. */
async function telemetry(request: AnalyticsForwardRequest, env: Env): Promise<Response> {
  try {
    const body = parseObject(request.body);
    const eventType = clean(body.event_type, 40);
    const sessionId = clean(body.session_id, 64);
    if (!TRAFFIC_EVENTS.has(eventType) || !sessionId) return accepted();
    const rawStep = Number(body.form_step);
    const formStep = Number.isFinite(rawStep) && rawStep >= 1 && rawStep <= 40 ? Math.trunc(rawStep) : null;
    // From the authenticated envelope, never the body: a client-supplied host is forgeable.
    const hostname = request.hostname.replace(/^www\./, "");
    const nowMs = Date.now();
    const occurred = resolveOccurredAt(body.occurred_at, nowMs);
    // The click cookie is not forwarded, so click_session_id stays NULL.
    await env.LEADS.prepare(`INSERT INTO traffic_events (
        event_type, session_id, click_session_id, hostname, brand, form_version, form_variant,
        build_id, form_step, error_code, device_class, browser_family, browser_timezone,
        touch_capable, source, campaign, occurred_at, clock_skew, created_at
      ) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`).bind(
      eventType, sessionId, hostname, clean(body.brand, 40) || null, clean(body.form_version, 32) || null,
      clean(body.form_variant, 40) || null, clean(body.build_id, 64) || "unknown", formStep,
      pick(body.error_code, TRAFFIC_ERROR_CODES), pick(body.device_class, TRAFFIC_DEVICE_CLASSES),
      pick(body.browser_family, TRAFFIC_BROWSERS), clean(body.browser_timezone, 64) || null,
      body.touch_capable === true ? 1 : 0, clean(body.source, 64) || null, clean(body.campaign, 64) || null,
      occurred.at, occurred.skewed, new Date(nowMs).toISOString(),
    ).run();
  } catch (error) {
    // Only the error name: a D1 error can echo bound values.
    console.warn(JSON.stringify({ msg: "telemetry_write_failed", err_kind: (error as { name?: string })?.name || "Error" }));
  }
  return accepted();
}

/** V1 handleErrorLog. A storage failure is a 503 here, as it was a 500 in V1. */
async function errors(request: AnalyticsForwardRequest, env: Env): Promise<Response> {
  const body = parseObject(request.body);
  const errorType = clean(body.error_type, 64);
  if (!errorType) return accepted();
  await env.LEADS.prepare(`INSERT INTO client_errors (session_id, error_type, error_message, screen_id, occurred_at)
    VALUES (?1, ?2, ?3, ?4, ?5)`).bind(
    clean(body.session_id, 64), errorType, clean(body.error_message, 200), clean(body.screen_id, 64),
    clean(body.occurred_at, 40) || new Date().toISOString(),
  ).run();
  return accepted();
}

async function send(url: string, contentType: string, body: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body, redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch { return json({ error: "internal" }, 502); }
  await response.body?.cancel();
  // Nothing the upstream says is reflected, not even its status.
  return response.ok ? accepted() : json({ error: "internal" }, 502);
}

/** PostHog reads the project key from `api_key`, `token` and `properties.token`. Swap it where the client put the placeholder. */
function swapPostHogKey(root: Record<string, unknown>, key: string, top: boolean): void {
  if ("token" in root) root.token = key;
  if (isObject(root.properties) && "token" in root.properties) root.properties.token = key;
  if (top || "api_key" in root) root.api_key = key;
}

async function posthog(request: AnalyticsForwardRequest, env: Env): Promise<Response> {
  if (!POSTHOG_PATHS.test(request.path)) return rejected(400);
  let payload: unknown;
  try { payload = JSON.parse(request.body); } catch { return rejected(400); }
  const roots = Array.isArray(payload) ? payload : [payload];
  if (roots.length === 0 || !roots.every(isObject)) return rejected(400);
  let origin: string | null = null;
  try {
    const host = new URL(env.POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST);
    if (host.protocol === "https:" && !host.username && host.pathname === "/") origin = host.origin;
  } catch { /* unusable host: handled as not configured */ }
  if (!env.POSTHOG_KEY || !origin) return notConfigured("posthog");
  for (const root of roots) {
    swapPostHogKey(root, env.POSTHOG_KEY, true);
    if (Array.isArray(root.batch)) for (const item of root.batch) if (isObject(item)) swapPostHogKey(item, env.POSTHOG_KEY, false);
  }
  return send(origin + request.path, "application/json", JSON.stringify(payload));
}

/** https://<key>@<host>[/<prefix>]/<project> -> the envelope endpoint of that project. */
function sentryEnvelopeUrl(dsn: string | undefined): string | null {
  try {
    const url = new URL(dsn ?? "");
    const segments = url.pathname.split("/").filter(Boolean);
    const project = segments.pop();
    if (url.protocol !== "https:" || !url.username || !project || !/^\d+$/.test(project)) return null;
    return `${url.origin}${segments.map((segment) => `/${segment}`).join("")}/api/${project}/envelope/`;
  } catch { return null; }
}

async function sentry(request: AnalyticsForwardRequest, env: Env): Promise<Response> {
  if (request.path !== "/") return rejected(400);
  // An envelope is one JSON header line followed by items; only the header carries the DSN.
  const newline = request.body.indexOf("\n");
  const rest = newline < 0 ? "" : request.body.slice(newline);
  let header: unknown;
  try { header = JSON.parse(newline < 0 ? request.body : request.body.slice(0, newline)); } catch { return rejected(400); }
  if (!isObject(header)) return rejected(400);
  const url = sentryEnvelopeUrl(env.SENTRY_DSN);
  if (!env.SENTRY_DSN || !url) return notConfigured("sentry");
  return send(url, "application/x-sentry-envelope", JSON.stringify({ ...header, dsn: env.SENTRY_DSN }) + rest);
}

// Read cap for the envelope request itself: JSON escaping can grow a body up to 6x.
const readCap = (kind: AnalyticsKind) => 6 * ANALYTICS_LIMITS[kind] + 4096;

async function readEnvelope(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function handler(kind: AnalyticsKind): RpcHandler {
  return async (request, env, account) => {
    let raw: unknown;
    try { raw = JSON.parse(await readEnvelope(request, readCap(kind))); }
    catch (error) { return rejected(error instanceof RangeError ? 413 : 400); }
    const parsed = AnalyticsForwardRequest.safeParse(raw);
    if (!parsed.success) return rejected(parsed.error.issues.some((issue) => issue.path[0] === "body" && issue.code === "custom") ? 413 : 400);
    const envelope = parsed.data;
    if (envelope.kind !== kind) return rejected(400);
    try {
      if (!await ownsBrand(env, account, envelope.brand_id)) return json({ error: "forbidden_brand" }, 403);
      const brand = await getRuntime(env, envelope.brand_id);
      if (!brand || !ownsHostname(brand, envelope.hostname)) return json({ error: "forbidden_brand" }, 403);
      // After authentication, parsing and ownership; before any D1 write or outbound call.
      if (!await withinLimit(kind, envelope.brand_id, env)) return json({ error: "rate_limited" }, 429);
      switch (kind) {
        case "telemetry": return await telemetry(envelope, env);
        case "errors": return await errors(envelope, env);
        case "posthog": return await posthog(envelope, env);
        case "sentry": return await sentry(envelope, env);
      }
    } catch {
      // Never reflect SQL, configuration or upstream detail through a failed forward.
      return json({ error: "internal" }, 503);
    }
  };
}

export const analyticsRoutes: ReadonlyMap<string, RpcHandler> = new Map(
  ANALYTICS_KINDS.map((kind) => [ANALYTICS_FORWARD_PATHS[kind], handler(kind)]),
);
