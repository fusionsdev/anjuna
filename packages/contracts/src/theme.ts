/**
 * Brand colors (FUS-381): a brand picks a primary and a secondary color; the brand Worker writes them over
 * the template's CSS variables. The theme lives on the brand (settings), the variable map on the template
 * version. themeCss validates both again and returns null on any failure, so no unvalidated byte reaches CSS.
 */
import { z } from "zod";
import { isBrandClean } from "./common.js";

/** `#rrggbb` in any case, stored and output lowercase. Short hex, names and functional colors fail. */
export const HexColor = z
  .string()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Use a #rrggbb hex color");
export type HexColor = z.infer<typeof HexColor>;

/** A brand's two colors. Both required when present; absent or null means the template's own colors. */
export const BrandTheme = z.strictObject({
  primary: HexColor,
  secondary: HexColor,
});
export type BrandTheme = z.infer<typeof BrandTheme>;

/** One CSS custom property name a template maps to a color role. Brand clean (AGENTS.md hard rule 4). */
export const ThemeVarName = z
  .string()
  .regex(/^--[a-z0-9-]{1,64}$/, "Invalid CSS variable name")
  .refine(isBrandClean, "Contains a forbidden platform string");
export type ThemeVarName = z.infer<typeof ThemeVarName>;

/** Which CSS variables a template version maps to each color role, at most 8 names per role. */
export const TemplateThemeVars = z.strictObject({
  primary: z.array(ThemeVarName).max(8),
  primary_dark: z.array(ThemeVarName).max(8),
  secondary: z.array(ThemeVarName).max(8),
});
export type TemplateThemeVars = z.infer<typeof TemplateThemeVars>;

export const EMPTY_THEME_VARS: TemplateThemeVars = { primary: [], primary_dark: [], secondary: [] };

/** True when every role is empty. */
export function isEmptyThemeVars(vars: TemplateThemeVars): boolean {
  return vars.primary.length + vars.primary_dark.length + vars.secondary.length === 0;
}

/** Owner saves a corrected map on a sealed template version. */
export const TemplateThemeVarsRequest = z.strictObject({ theme_vars: TemplateThemeVars });
export type TemplateThemeVarsRequest = z.infer<typeof TemplateThemeVarsRequest>;

/** A template version's detected or saved map. */
export const TemplateThemeVarsResponse = z.strictObject({ template_version_id: z.string().min(1), theme_vars: TemplateThemeVars });
export type TemplateThemeVarsResponse = z.infer<typeof TemplateThemeVarsResponse>;

/** A brand's baked map (`deployed`) beside its template's effective map (`template`); null when absent. */
export const BrandThemeVarsResponse = z.strictObject({
  brand_id: z.string().min(1),
  deployed: TemplateThemeVars.nullable(),
  template: TemplateThemeVars.nullable(),
});
export type BrandThemeVarsResponse = z.infer<typeof BrandThemeVarsResponse>;

/** Each RGB channel times 0.88, rounded. The hover/active shade derived from primary. */
export function darkenHex(hex: string): string {
  const channel = (from: number) => Math.round(parseInt(hex.slice(from, from + 2), 16) * 0.88);
  return `#${[channel(1), channel(3), channel(5)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The `:root{…}` rule text (no style tag) writing the theme over the mapped variables, in the order
 * primary names, primary_dark names, secondary names. Null when there is no theme, no mapped name, or
 * either input fails validation; the brand Worker then injects nothing and serves today's bytes.
 */
export function themeCss(theme: unknown, vars: unknown): string | null {
  const parsedTheme = BrandTheme.safeParse(theme);
  if (!parsedTheme.success) return null;
  const parsedVars = TemplateThemeVars.safeParse(vars);
  if (!parsedVars.success) return null;
  const parts: string[] = [];
  for (const name of parsedVars.data.primary) parts.push(`${name}:${parsedTheme.data.primary}`);
  const dark = darkenHex(parsedTheme.data.primary);
  for (const name of parsedVars.data.primary_dark) parts.push(`${name}:${dark}`);
  for (const name of parsedVars.data.secondary) parts.push(`${name}:${parsedTheme.data.secondary}`);
  if (parts.length === 0) return null;
  return `:root{${parts.join(";")}}`;
}

/**
 * A brand revision's config_json with the template version's theme variable map: what the brand Worker
 * reads to write the brand's colors. Missing, invalid or all-empty maps remove the key.
 */
export function withThemeVars(configJson: string, themeVarsJson: string | null): string {
  const config = JSON.parse(configJson) as Record<string, unknown>;
  delete config.theme_vars;
  if (themeVarsJson) {
    try {
      const parsed = TemplateThemeVars.safeParse(JSON.parse(themeVarsJson));
      if (parsed.success && parsed.data.primary.length + parsed.data.primary_dark.length + parsed.data.secondary.length > 0) config.theme_vars = parsed.data;
    } catch {
      /* invalid JSON: no vars */
    }
  }
  return JSON.stringify(config);
}

/** The block appended at the end of <head>: identical bytes for every visitor (AGENTS.md hard rule 3). */
export function themeStyleTag(css: string): string {
  return `<style id="brand-theme">${css}</style>`;
}
