import { describe, expect, it } from "vitest";
import { BrandProfile, BrandTheme, EMPTY_THEME_VARS, HexColor, TemplateThemeVars, darkenHex, themeCss, themeStyleTag } from "../src/index.js";

describe("HexColor", () => {
  it("accepts #rrggbb in any case and lowercases", () => {
    expect(HexColor.parse("#2563EB")).toBe("#2563eb");
    expect(HexColor.parse("#0F766E")).toBe("#0f766e");
    expect(HexColor.parse("#abcdef")).toBe("#abcdef");
  });

  it.each(["#fff", "red", "rgb(0,0,0)", "#2563eb;}", "#2563eg", "", "#2563eb ", " #2563eb", "#12345", "#1234567"])("rejects %j", (value) => {
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

describe("BrandProfile theme", () => {
  it("accepts an optional theme and rejects a bad one", () => {
    expect(BrandProfile.safeParse({}).success).toBe(true);
    expect(BrandProfile.parse({ theme: { primary: "#0F766E", secondary: "#1e293b" } })).toEqual({ theme: { primary: "#0f766e", secondary: "#1e293b" } });
    expect(BrandProfile.safeParse({ theme: { primary: "#fff", secondary: "#1e293b" } }).success).toBe(false);
    expect(BrandProfile.safeParse({ theme: { primary: "#0f766e" } }).success).toBe(false);
    expect(BrandProfile.safeParse({ theme: null }).success).toBe(false);
  });
});
