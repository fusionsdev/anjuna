/**
 * Brand runtime config (BR-5): the JSON inside `<script type="application/json" id="cfg">`
 * that the brand Worker writes into the form page and the form reads on boot.
 *
 * It holds only what the page needs to render: brand display name, amount, ZIP, keyword, label,
 * formRoute, A/B variant and the first-party proxy paths. Strict: an unknown key (for example
 * `brand_id`, a token, a PostHog key, a DSN) fails validation, so it cannot leak by accident.
 */
import { z } from "zod";
import { isBrandClean, Zip5 } from "./common.js";

/** BR-4 keyword: safe charset, at most 60 chars, title case. */
export const KEYWORD_MAX_LENGTH = 60;
const KEYWORD_RE = /^[\p{L}\p{N}&'-]+(?: [\p{L}\p{N}&'-]+)*$/u;

/**
 * BR-4 keyword cleaning, as proven in the spike brand Worker: drop anything outside letters,
 * digits, space, `&`, `'`, `-`; collapse spaces; cap at 60; title-case each word.
 * Returns null when nothing usable is left (the template keeps its default text).
 */
export function cleanKeyword(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEYWORD_MAX_LENGTH)
    .trim();
  if (!s) return null;
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export const Keyword = z
  .string()
  .max(KEYWORD_MAX_LENGTH)
  .regex(KEYWORD_RE, "Keyword must be cleaned text")
  .refine((k) => cleanKeyword(k) === k, "Keyword must be the output of cleanKeyword");

/** Paths the form route may not shadow (BR-1 allowlist entries owned by the runtime). */
export const RESERVED_ROUTES = ["/go", "/_f", "/api", "/privacy", "/terms", "/do-not-sell", "/disclosures"] as const;

export const FormRoute = z
  .string()
  .regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, "formRoute must be a lowercase absolute path without trailing slash")
  .refine((r) => !RESERVED_ROUTES.some((p) => r === p || r.startsWith(p + "/")), "formRoute collides with a reserved route");

/** Same-origin proxy paths (BR-11). Paths only; the real key and DSN stay server-side. */
export const ProxyPaths = z.strictObject({
  posthog: z.string().regex(/^\/[A-Za-z0-9/_-]+$/).optional(),
  sentry: z.string().regex(/^\/[A-Za-z0-9/_-]+$/).optional(),
});

const cleanText = (max: number) =>
  z.string().min(1).max(max).refine(isBrandClean, "Contains a forbidden platform string");

export const RuntimeConfig = z.strictObject({
  /** Display brand shown in the form header and consent text. Replaces V1 BRAND_BY_HOST. */
  brand: cleanText(80),
  /** Validated handoff amount (one of the brand's buckets). */
  amount: z.number().int().positive(),
  zip: Zip5,
  /** Cleaned ad keyword, or null when the URL had none. Reported to analytics and the lead; never displayed. */
  keyword: Keyword.nullable(),
  /** The brand's own keyword (keyword_default), set only when the URL carried a keyword. Shown in the form header and tab title. */
  label: Keyword.nullable().optional(),
  formRoute: FormRoute,
  /** A/B arm for this visitor (BR-9). A neutral slug, never a platform name. */
  variant: z.string().regex(/^[a-z0-9_-]{1,32}$/).refine(isBrandClean, "Contains a forbidden platform string"),
  proxies: ProxyPaths.optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;

/** The element the brand Worker fills and the form reads. */
export const RUNTIME_CONFIG_SELECTOR = 'script[type="application/json"]#cfg';

/**
 * Serialize for injection into the `#cfg` script element. `<` is escaped so the payload can
 * never close the script tag (same escaping as the spike brand Worker).
 */
export function encodeRuntimeConfig(cfg: RuntimeConfig): string {
  return JSON.stringify(RuntimeConfig.parse(cfg)).replace(/</g, "\\u003c");
}

/** Parse the `#cfg` text on the client. Returns null instead of throwing on bad input. */
export function parseRuntimeConfig(text: string | null | undefined): RuntimeConfig | null {
  if (!text) return null;
  try {
    const r = RuntimeConfig.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
