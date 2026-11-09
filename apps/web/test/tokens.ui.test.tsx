import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const client = resolve(import.meta.dirname, "../src/client");
const read = (file: string) => readFileSync(resolve(client, file), "utf8");

/** jsdom keeps `var()` unresolved in computed styles, so the test substitutes the :root custom properties first. */
function resolveVars(css: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
  const vars = new Map([...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const));
  let out = css;
  for (let pass = 0; pass < 6 && out.includes("var("); pass++) out = out.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => vars.get(name) ?? whole);
  return out;
}

let sheet: HTMLStyleElement;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  // The operating system asks for dark. The panel must ignore it: release 1 is light only.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-color-scheme: dark"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  sheet = document.createElement("style");
  // The two files main.tsx imports, in its order.
  sheet.textContent = resolveVars(`${read("styles/tokens.css")}\n${read("styles.css")}`);
  document.head.appendChild(sheet);
});
afterEach(() => {
  sheet.remove();
  window.matchMedia = originalMatchMedia;
});

describe("light-only tokens", () => {
  it("paints the page #F6F6F4 with ink #111111 while the OS prefers dark", () => {
    const body = getComputedStyle(document.body);
    expect(body.backgroundColor).toBe("rgb(246, 246, 244)");
    expect(body.color).toBe("rgb(17, 17, 17)");
  });

  it("sets the body font to IBM Plex Sans Thai first, then Inter and the system font", () => {
    const family = getComputedStyle(document.body).fontFamily;
    expect(family.replace(/["']/g, "").startsWith("IBM Plex Sans Thai")).toBe(true);
    expect(family).toContain("Inter");
    expect(family).toContain("system-ui");
  });

  it("sets body text to 15px with 1.65 line height", () => {
    const body = getComputedStyle(document.body);
    expect(body.fontSize).toBe("15px");
    expect(body.lineHeight).toBe("1.65");
  });

  it("sets h1 to 28px, the card title to 18px with a 3px brand bar, and the KPI value to 28px", () => {
    const css = resolveVars(`${read("styles/tokens.css")}
${read("styles.css")}`);
    expect(/h1 \{ font-size: 28px;/.test(css)).toBe(true);
    expect(/h2 \{ font-size: 18px;/.test(css)).toBe(true);
    expect(css).toMatch(/\.panel > h2::before[^{]*\{[^}]*width: 3px;[^}]*background: #F83808/);
    expect(css).toMatch(/\.v \{ font-size: 28px;/);
  });

  it("styles the table head 13px ink on canvas and rows 52px", () => {
    const css = resolveVars(`${read("styles/tokens.css")}
${read("styles.css")}`);
    expect(css).toContain("--row-h: 52px");
    expect(css).toMatch(/\.table th \{ font-size: 13px; font-weight: 600; color: #111111; background: #F6F6F4; \}/);
    expect(css).toMatch(/\.table tbody tr, \.data-table tbody tr \{ height: 52px; \}/);
  });

  it("declares color-scheme light and imports no dark palette", () => {
    const tokens = read("styles/tokens.css");
    expect(tokens).toContain("color-scheme: light");
    expect(tokens).not.toContain("prefers-color-scheme");
    expect(tokens).not.toContain("data-theme");
    const main = read("main.tsx");
    expect(main).not.toContain("tokens.dark.css");
    expect(read("styles/tokens.dark.css")).toContain("prefers-color-scheme: dark");
  });

  it("defines the redesign palette and radii", () => {
    const tokens = read("styles/tokens.css");
    for (const value of ["--canvas: #F6F6F4", "--card: #FFFFFF", "--ink: #111111", "--sub: #46464C", "--line: #D9D9D4",
      "--brand: #F83808", "--brand-hover: #E03206", "--brand-tint: #FFE9E2", "--brand-ink: #C42A03",
      "--ok: #0E7A4F", "--ok-bg: #E6F5EE", "--warn: #805000", "--warn-bg: #FFF3DC", "--bad: #B42318", "--bad-bg: #FDECEA", "--info: #244D91", "--info-bg: #E8F0FC",
      "--radius-card: 16px", "--radius-control: 12px", "--radius-chip: 999px"]) {
      expect(tokens, value).toContain(value);
    }
  });

  it("loads the three font families from Google Fonts in index.html", () => {
    const html = read("index.html");
    expect(html).toContain("family=Inter");
    expect(html).toContain("family=IBM+Plex+Mono");
    expect(html).toContain("family=IBM+Plex+Sans+Thai");
    expect(html).toContain("<title>Anjuna</title>");
  });

  it("keeps relative font sizes at 13px or more inside a 13px parent", () => {
    // A size in em or % shrinks inside a small parent: .875em in a 13px .small is 11.4px. Every such size must be wrapped in max(13px, ...).
    const sources = ["styles.css", "screens/Audit.tsx", "screens/Suppressions.tsx", "screens/Home.css", "screens/Traffic.css", "screens/Brands.css", "screens/Campaigns.css", "screens/Conversions.css", "screens/Settings.css", "screens/Deploys.css", "screens/AdkitTerminal.css", "screens/BrandTimeline.css", "screens/BuilderKeys.tsx"];
    for (const file of sources) {
      for (const match of read(file).matchAll(/font-?[sS]ize:\s*"?([^;"},]+(?:\([^)]*\))?[^;"},]*)/g)) {
        const value = match[1]!.trim();
        const relative = value.match(/([\d.]+)(em|%)/);
        if (!relative) continue;
        const factor = relative[2] === "%" ? Number(relative[1]) / 100 : Number(relative[1]);
        const wrapped = /^max\(\s*13px/.test(value);
        // Resolve it against the smallest parent size the panel uses.
        const resolved = wrapped ? Math.max(13, 13 * factor) : 13 * factor;
        expect(resolved, `${file}: ${match[0]}`).toBeGreaterThanOrEqual(13);
      }
    }
  });

  it("gives an unsized <small> the 13px floor, so the browser default of 12.5px never shows", () => {
    expect(read("styles.css")).toContain("small { font-size: max(13px, .875em); }");
  });

  it("keeps the brand pick button 44px tall in every rule that sizes it", () => {
    for (const file of ["styles.css", "screens/Brands.css"]) {
      for (const rule of read(file).matchAll(/\.brand-pick \{([^}]*)\}/g)) {
        // Only the rules that size the button (they set padding). A colour or weight rule is not a size.
        if (rule[1]!.includes("padding")) expect(rule[1], `${file}: ${rule[0]}`).toContain("min-height: 44px");
      }
    }
  });

  it("styles the KPI row and the queue stats with selectors that beat the shared .ledger rule", () => {
    const home = read("screens/Home.css");
    expect(home).toContain(".ledger.kpi-row {");
    expect(home).toContain(".ledger.queue-stats {");
    // A bare .kpi-row or .queue-stats rule would lose to .ledger in the built CSS and flatten the five cards into one frame.
    const bare = home.split("\n").filter((line) => line.startsWith(".kpi-row") || line.startsWith(".queue-stats"));
    expect(bare).toEqual([]);
  });

  it("sets no font size under 13px in any stylesheet", () => {
    const files = ["styles.css", "styles/tokens.css", "screens/Home.css", "screens/Traffic.css", "screens/Brands.css", "screens/Campaigns.css", "screens/Conversions.css", "screens/Settings.css", "screens/Deploys.css", "screens/AdkitTerminal.css", "screens/BrandTimeline.css"];
    for (const file of files) {
      for (const match of read(file).matchAll(/font-size:\s*([\d.]+)(px|rem|em)/g)) {
        const size = Number(match[1]);
        const px = match[2] === "px" ? size : match[2] === "rem" ? size * 16 : size * 15;
        expect(px, `${file}: ${match[0]}`).toBeGreaterThanOrEqual(13);
      }
    }
  });
});
