import { describe, expect, it } from "vitest";
import { BrandProfile, BrandTheme, BrandThemeVarsResponse, EMPTY_THEME_VARS, HexColor, TemplateThemeVars, TemplateThemeVarsRequest, TemplateThemeVarsResponse, darkenHex, isEmptyThemeVars, themeCss, themeStyleTag, withThemeVars } from "../src/index.js";

describe("HexColor", () => {
  it("accepts #rrggbb in any case and lowercases", () => {
    expect(HexColor.parse("#2563EB")).toBe("#2563eb");
    expect(HexColor.parse("#0F766E")).toBe("#0f766e");
    expect(HexColor.parse("#abcdef")).toBe("#abcdef");
  });

  it.each(["#fff", "red", "rgb(0,0,0)", "#2563eb;}", "#2563eg", "", "#2563eb ", " #2563eb", "#12345", "#1234567"])("HexColor rejects short, named and functional colors: %j", (value) => {
    expect(HexColor.safeParse(value).success).toBe(false);
  });
});

describe("darkenHex", () => {
  it("multiplies each channel by 0.88", () => {
    expect(darkenHex("#2563eb")).toBe("#2157cf");
    expect(darkenHex("#000000")).toBe("#000000");
    expect(darkenHex("#ffffff")).toBe("#e0e0e0");
    expect(darkenHex("#0f766e")).toBe("#0d6861");
  });
});

describe("themeCss", () => {
  const theme = { primary: "#0f766e", secondary: "#1e293b" };
  const vars = { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: ["--color-ink"] };

  it("writes primary, dark and secondary in order", () => {
    expect(themeCss(theme, vars)).toBe(":root{--color-royal:#0f766e;--color-royal-dark:#0d6861;--color-ink:#1e293b}");
  });

  it("writes only mapped roles", () => {
    expect(themeCss(theme, { primary: [], primary_dark: [], secondary: ["--ink"] })).toBe(":root{--ink:#1e293b}");
    expect(themeCss(theme, { primary: ["--royal"], primary_dark: [], secondary: [] })).toBe(":root{--royal:#0f766e}");
    expect(themeCss(theme, { primary: [], primary_dark: ["--royal-dark"], secondary: [] })).toBe(":root{--royal-dark:#0d6861}");
  });

  it("returns null without a theme or mapped names", () => {
    expect(themeCss(null, vars)).toBeNull();
    expect(themeCss(undefined, vars)).toBeNull();
    expect(themeCss(theme, null)).toBeNull();
    expect(themeCss(theme, undefined)).toBeNull();
    expect(themeCss(theme, EMPTY_THEME_VARS)).toBeNull();
    expect(themeCss(null, null)).toBeNull();
  });

  it("returns null on an invalid hex or variable name", () => {
    expect(themeCss({ primary: "#fff", secondary: "#1e293b" }, vars)).toBeNull();
    expect(themeCss(theme, { primary: ["--x;}body{"], primary_dark: [], secondary: [] })).toBeNull();
    expect(themeCss(theme, { primary: ["--anjuna-blue"], primary_dark: [], secondary: [] })).toBeNull();
    expect(themeCss(theme, { primary: ["--a", "--b", "--c", "--d", "--e", "--f", "--g", "--h", "--i"], primary_dark: [], secondary: [] })).toBeNull();
  });

  it("style tag wraps the css with the brand-theme id", () => {
    expect(themeStyleTag(":root{--ink:#1e293b}")).toBe('<style id="brand-theme">:root{--ink:#1e293b}</style>');
  });
});

describe("BrandTheme and TemplateThemeVars", () => {
  it("parses a valid theme and rejects extras", () => {
    expect(BrandTheme.parse({ primary: "#0F766E", secondary: "#1e293b" })).toEqual({ primary: "#0f766e", secondary: "#1e293b" });
    expect(BrandTheme.safeParse({ primary: "#0f766e", secondary: "#1e293b", extra: 1 }).success).toBe(false);
    expect(BrandTheme.safeParse({ primary: "#0f766e" }).success).toBe(false);
  });

  it("parses valid vars and EMPTY_THEME_VARS holds three empty arrays", () => {
    expect(TemplateThemeVars.parse({ primary: ["--color-royal"], primary_dark: [], secondary: ["--ink"] })).toEqual({
      primary: ["--color-royal"],
      primary_dark: [],
      secondary: ["--ink"],
    });
    expect(EMPTY_THEME_VARS).toEqual({ primary: [], primary_dark: [], secondary: [] });
    expect(TemplateThemeVars.safeParse(EMPTY_THEME_VARS).success).toBe(true);
    expect(TemplateThemeVars.safeParse({ primary: [], primary_dark: [], secondary: [], extra: [] }).success).toBe(false);
  });
});

describe("withThemeVars", () => {
  const vars = { primary: ["--color-royal"], primary_dark: [], secondary: ["--ink"] };
  it("withThemeVars sets valid vars and removes invalid or empty ones", () => {
    expect(JSON.parse(withThemeVars('{"keyword_default":"Quick Loan","theme_vars":{"primary":["--old"],"primary_dark":[],"secondary":[]}}', JSON.stringify(vars))))
      .toEqual({ keyword_default: "Quick Loan", theme_vars: vars });
    expect(JSON.parse(withThemeVars('{"keyword_default":"Quick Loan","theme_vars":{"primary":["--old"],"primary_dark":[],"secondary":[]}}', null))).toEqual({ keyword_default: "Quick Loan" });
    expect(JSON.parse(withThemeVars('{"keyword_default":"Quick Loan","theme_vars":{"primary":["--old"],"primary_dark":[],"secondary":[]}}', JSON.stringify(EMPTY_THEME_VARS)))).toEqual({ keyword_default: "Quick Loan" });
    expect(JSON.parse(withThemeVars('{"keyword_default":"Quick Loan","theme_vars":{"primary":["--old"],"primary_dark":[],"secondary":[]}}', '{"primary":["--anjuna-blue"],"primary_dark":[],"secondary":[]}'))).toEqual({ keyword_default: "Quick Loan" });
    expect(JSON.parse(withThemeVars('{"keyword_default":"Quick Loan","theme_vars":{"primary":["--old"],"primary_dark":[],"secondary":[]}}', "not json"))).toEqual({ keyword_default: "Quick Loan" });
  });
});

describe("BrandProfile theme", () => {
  it("accepts an optional theme and rejects a bad one", () => {
    expect(BrandProfile.safeParse({}).success).toBe(true);
    expect(BrandProfile.parse({ theme: { primary: "#0F766E", secondary: "#1e293b" } })).toEqual({ theme: { primary: "#0f766e", secondary: "#1e293b" } });
    expect(BrandProfile.safeParse({ theme: { primary: "#fff", secondary: "#1e293b" } }).success).toBe(false);
    expect(BrandProfile.safeParse({ theme: { primary: "#0f766e" } }).success).toBe(false);
    expect(BrandProfile.safeParse({ theme: null }).success).toBe(false);
  });
});

describe("theme vars backfill contracts", () => {
  const vars = { primary: ["--color-royal"], primary_dark: [], secondary: [] };

  it("TemplateThemeVarsRequest rejects a non-clean name", () => {
    expect(TemplateThemeVarsRequest.safeParse({ theme_vars: vars }).success).toBe(true);
    expect(TemplateThemeVarsRequest.safeParse({ theme_vars: { ...vars, primary: ["--anjuna-blue"] } }).success).toBe(false);
    expect(TemplateThemeVarsRequest.safeParse({ theme_vars: { ...vars, primary: ["color"] } }).success).toBe(false);
    expect(TemplateThemeVarsRequest.safeParse({ theme_vars: vars, extra: 1 }).success).toBe(false);
    expect(TemplateThemeVarsResponse.safeParse({ template_version_id: "tv1", theme_vars: vars }).success).toBe(true);
    expect(TemplateThemeVarsResponse.safeParse({ template_version_id: "", theme_vars: vars }).success).toBe(false);
  });

  it("BrandThemeVarsResponse accepts nulls", () => {
    expect(BrandThemeVarsResponse.safeParse({ brand_id: "b1", deployed: null, template: null }).success).toBe(true);
    expect(BrandThemeVarsResponse.safeParse({ brand_id: "b1", deployed: vars, template: vars }).success).toBe(true);
    expect(BrandThemeVarsResponse.safeParse({ brand_id: "b1", deployed: vars }).success).toBe(false);
  });

  it("isEmptyThemeVars", () => {
    expect(isEmptyThemeVars(EMPTY_THEME_VARS)).toBe(true);
    expect(isEmptyThemeVars(vars)).toBe(false);
    expect(isEmptyThemeVars({ primary: [], primary_dark: [], secondary: ["--ink"] })).toBe(false);
  });
});
