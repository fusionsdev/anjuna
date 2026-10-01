/**
 * Template contract (TP-1, TP-2). What every landing template must provide so the brand runtime
 * can serve it and T11 certification can lint it.
 *
 * Two parts:
 *  - `TemplateManifest`: the JSON a template ships at the root of its static `dist/`
 *    (TEMPLATE_MANIFEST_FILE, a neutral name because it is served) describing its framework,
 *    KeywordSlot default, CTA amounts and legal pages.
 *  - `TEMPLATE_RULES`: the markup rules the lint applies to the built HTML.
 */
import { z } from "zod";
import { isBrandClean } from "./common.js";
import { cleanKeyword } from "./runtime-config.js";

/** File name of the manifest at the root of a template's `dist/`. Neutral: it is served. */
export const TEMPLATE_MANIFEST_FILE = "template.json";

/** TP-1: static export only. We never build templates or run template server code. */
export const TemplateFramework = z.enum(["astro", "next-export", "vite-spa"]);
export type TemplateFramework = z.infer<typeof TemplateFramework>;

/** TP-2 required legal pages: privacy, terms, do-not-sell, disclosures. */
export const LEGAL_PAGES = ["privacy", "terms", "do_not_sell", "disclosures"] as const;

const sitePath = z.string().regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?$/, "Must be a root-relative lowercase path");

export const TemplateManifest = z.strictObject({
  contract_version: z.literal(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Semver x.y.z"),
  framework: TemplateFramework,
  /** Built entry page, relative to dist/. */
  entry: z.literal("index.html"),
  keyword_slot: z.strictObject({
    /** Text the H1 slot shows when the ad URL has no keyword. Must survive cleanKeyword unchanged. */
    default: z
      .string()
      .min(1)
      .max(60)
      .refine((d) => cleanKeyword(d) === d, "Default keyword must already be clean title-case text"),
  }),
  cta: z.strictObject({
    action: z.literal("/go"),
    method: z.literal("get"),
    fields: z.tuple([z.literal("requested_amount"), z.literal("zip")]),
    /** Amount options the CTA offers. The brand's amount buckets must contain every one. */
    amounts: z.array(z.number().int().positive()).min(1),
  }),
  legal_pages: z.strictObject({
    privacy: sitePath,
    terms: sitePath,
    do_not_sell: sitePath,
    disclosures: sitePath,
  }),
}).superRefine((m, ctx) => {
  for (const [k, v] of Object.entries({ name: m.name, default: m.keyword_slot.default })) {
    if (!isBrandClean(v)) ctx.addIssue({ code: "custom", path: [k], message: "Contains a forbidden platform string" });
  }
});
export type TemplateManifest = z.infer<typeof TemplateManifest>;

/** Markup rules applied to built HTML (TP-2). T11 implements the lint; these are the facts it checks. */
export const TEMPLATE_RULES = {
  /** Exactly one, inside the single <h1>. KeywordSlot renders this element. */
  keywordSlotSelector: "h1 [data-kw]",
  keywordSlotMarkup: "<span data-kw>",
  /** The CTA form; the brand Worker appends hidden ad-param inputs to it. */
  ctaSelector: "form[data-cta]",
  ctaAction: "/go",
  ctaFields: ["requested_amount", "zip"] as const,
  /** Compliance: no "Personal Loan(s)" wording anywhere. */
  forbiddenWording: /personal\s+loans?/i,
  /** No PII inputs on the landing; PII is collected only by the form. */
  forbiddenInputNames: [
    "first_name", "last_name", "name", "email", "phone", "home_phone", "work_phone",
    "birth_date", "dob", "ssn", "address", "street", "city", "state",
    "bank_account", "routing_number", "account_number", "income", "monthly_income",
  ] as const,
  /** No external scripts or analytics: every <script src> must be root-relative. */
  allowExternalScripts: false,
  /** Astro: shared styles must be `<style is:global>` (scoped styles broke the spike). */
  astroGlobalStyles: true,
} as const;

/** True when `src` points off-origin (absolute URL or protocol-relative). */
export function isExternalUrl(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src.trim());
}
