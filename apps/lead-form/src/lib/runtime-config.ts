// Runtime config injected by the brand Worker into <script type="application/json" id="cfg">
// (BR-5). It is the ONLY source of brand-specific data for this bundle: the bundle itself is
// shared by every brand and must not contain any brand's name, domain or keys (FO-4).
//
// Allowed fields (BR-5): brand name, amount, ZIP, keyword, formRoute, A/B variant and the
// first-party proxy paths. Never secrets, never brand_id, never data about other brands.
export interface RuntimeProxies {
  /** First-party PostHog proxy path, e.g. "/_ph". Absent = PostHog stays off. */
  posthog?: string;
  /** First-party Sentry tunnel path, e.g. "/_st". Absent = Sentry stays off. */
  sentry?: string;
}

export interface RuntimeConfig {
  amount?: number;
  zip?: string;
  keyword?: string | null;
  formRoute?: string;
  brand?: string;
  /** Server-assigned A/B arm (BR-9), e.g. "lite_v1" or "full_v1". */
  variant?: string;
  proxies?: RuntimeProxies;
}

const KEYWORD_MAX = 60;

// A proxy path must be a same-origin absolute path. Anything else (a full URL, protocol-relative
// "//host", a path with a query) is dropped so the config can never point telemetry off-origin.
function sameOriginPath(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!/^\/[A-Za-z0-9_\-/]*$/.test(s) || s.startsWith("//")) return undefined;
  return s.replace(/\/+$/, "") || undefined;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

/** Parse and normalise an untrusted JSON value into a RuntimeConfig. Never throws. */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: RuntimeConfig = {};

  if (typeof r.amount === "number" || typeof r.amount === "string") {
    const amount = Number(r.amount);
    if (Number.isFinite(amount) && amount > 0) out.amount = amount;
  }
  const zip = str(r.zip, 5);
  if (zip && /^\d{5}$/.test(zip)) out.zip = zip;
  const keyword = str(r.keyword, KEYWORD_MAX);
  if (keyword) out.keyword = keyword;
  const formRoute = sameOriginPath(r.formRoute);
  if (formRoute) out.formRoute = formRoute;
  const brand = str(r.brand, 80);
  if (brand) out.brand = brand;
  const variant = str(r.variant, 64);
  if (variant) out.variant = variant;

  if (r.proxies && typeof r.proxies === "object" && !Array.isArray(r.proxies)) {
    const p = r.proxies as Record<string, unknown>;
    const proxies: RuntimeProxies = {};
    const ph = sameOriginPath(p.posthog);
    if (ph) proxies.posthog = ph;
    const st = sameOriginPath(p.sentry);
    if (st) proxies.sentry = st;
    if (proxies.posthog || proxies.sentry) out.proxies = proxies;
  }
  return out;
}

/** Read the config from the document. Missing or malformed config yields {} (neutral defaults). */
export function readRuntimeConfig(
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
): RuntimeConfig {
  if (!doc) return {};
  try {
    return parseRuntimeConfig(JSON.parse(doc.getElementById("cfg")?.textContent || "{}"));
  } catch {
    return {};
  }
}

export const RUNTIME_CONFIG: RuntimeConfig = readRuntimeConfig();
