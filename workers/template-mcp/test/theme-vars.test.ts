import { describe, expect, it } from "vitest";
import { EMPTY_THEME_VARS } from "@anjuna/contracts";
import type { FileMap } from "../src/archive";
import { extractThemeVars } from "../src/theme-vars";
import { DEMO14_CSS } from "./fixtures/demo14-css";

const enc = new TextEncoder();
const cssFiles = (css: string): FileMap => new Map([["assets/site.css", enc.encode(css)]]);
const demo14Files = (): FileMap => new Map([["assets/site.css", enc.encode(DEMO14_CSS)]]);

describe("extractThemeVars", () => {
  it("detects --color-royal and --color-royal-dark on demo14 CSS", () => {
    expect(extractThemeVars(demo14Files())).toEqual({
      primary: ["--color-royal"],
      primary_dark: ["--color-royal-dark"],
      secondary: [],
    });
  });

  it("detects --accent on the Astro starter", () => {
    const style = ":root { --accent: #1f7a4d; } button { background: var(--accent); }";
    const index = `<!doctype html><html><head><style>${style}</style></head><body></body></html>`;
    expect(extractThemeVars(new Map([["index.html", enc.encode(index)]])).primary).toEqual(["--accent"]);
  });

  it("drops gray and neutral variables", () => {
    const css = ":root{--brand-gray:#6b7280;--brand-neutral:#737373;--brand:#1f7a4d}" +
      ".a{background:var(--brand-gray)}.b{background-color:var(--brand-gray)}.c{background:var(--brand)}";
    expect(extractThemeVars(cssFiles(css)).primary).toEqual(["--brand"]);
  });

  it("returns EMPTY_THEME_VARS when no hex variable is used as a background", () => {
    const css = ":root{--brand:#1f7a4d}.card{border:1px solid var(--brand)}";
    expect(extractThemeVars(cssFiles(css))).toEqual(EMPTY_THEME_VARS);
  });

  it("picks secondary from color declarations", () => {
    const css = ":root{--brand:#1f7a4d;--ink:#10231c}.btn{background:var(--brand)}p{color:var(--ink)}a{color:var(--ink)}";
    expect(extractThemeVars(cssFiles(css))).toEqual({ primary: ["--brand"], primary_dark: [], secondary: ["--ink"] });
  });

  it("breaks ties by declaration order", () => {
    const css = ":root{--first:#111111;--second:#222222}.a{background:var(--second)}.b{background:var(--first)}";
    expect(extractThemeVars(cssFiles(css)).primary).toEqual(["--first"]);
  });

  it("skips primary candidates too light for white text", () => {
    const css = ":root{--pale:#fafafa;--brand:#2563eb}.a{background:var(--pale)}.b{background:var(--pale)}.c{background:var(--brand)}";
    expect(extractThemeVars(cssFiles(css)).primary).toEqual(["--brand"]);
  });
});
