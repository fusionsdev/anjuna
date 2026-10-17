/**
 * Site text a brand serves: brand name, page title, meta description. The template supplies defaults
 * (extracted at submit time); the dashboard can override them per brand; the brand Worker writes them.
 */
import { z } from "zod";
import { isBrandClean } from "./common.js";
import { TEMPLATE_RULES } from "./template.js";

export const SITE_TEXT_LIMITS = { brand_name: 80, title: 70, description: 160 } as const;
export type SiteTextField = keyof typeof SITE_TEXT_LIMITS;

/**
 * One line of visitor-facing text. Control characters and <, >, " are refused so the value is safe in
 * text nodes and double-quoted attributes. Brand clean, and no "personal loan" wording (compliance).
 */
export function siteTextValue(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f<>"]/.test(value), 'Use plain text without <, > or " characters')
    .refine(isBrandClean, "Contains a forbidden platform string")
    .refine((value) => !TEMPLATE_RULES.forbiddenWording.test(value), 'Do not use the words "personal loan"');
}

export const SiteBrandName = siteTextValue(SITE_TEXT_LIMITS.brand_name);
export const SiteTitle = siteTextValue(SITE_TEXT_LIMITS.title);
export const SiteDescription = siteTextValue(SITE_TEXT_LIMITS.description);

const SCHEMAS = { brand_name: SiteBrandName, title: SiteTitle, description: SiteDescription } as const;

/** Defaults extracted from a template version's index.html. Null = the template has none. */
export const TemplateTextDefaults = z.strictObject({
  brand_name: SiteBrandName.nullable(),
  title: SiteTitle.nullable(),
  description: SiteDescription.nullable(),
});
export type TemplateTextDefaults = z.infer<typeof TemplateTextDefaults>;

/** Collapse whitespace and cut to the field's limit; null when nothing valid is left. */
export function normalizeSiteText(raw: string | null | undefined, field: SiteTextField): string | null {
  if (!raw) return null;
  const cut = raw.replace(/\s+/g, " ").trim().slice(0, SITE_TEXT_LIMITS[field]).trim();
  const parsed = SCHEMAS[field].safeParse(cut);
  return parsed.success ? parsed.data : null;
}

/**
 * A brand revision's config_json with the template version's text defaults: the fallback the brand
 * Worker serves when core is unreachable. Missing or invalid defaults remove the key.
 */
export function withTextDefaults(configJson: string, textDefaultsJson: string | null): string {
  const config = JSON.parse(configJson) as Record<string, unknown>;
  delete config.text_defaults;
  if (textDefaultsJson) {
    try {
      const parsed = TemplateTextDefaults.safeParse(JSON.parse(textDefaultsJson));
      if (parsed.success) config.text_defaults = parsed.data;
    } catch {
      /* invalid JSON: no defaults */
    }
  }
  return JSON.stringify(config);
}

export const SiteTextDefaultsResponse = z.strictObject({
  brand_id: z.string().min(1).max(128),
  defaults: TemplateTextDefaults.nullable(),
});
export type SiteTextDefaultsResponse = z.infer<typeof SiteTextDefaultsResponse>;
