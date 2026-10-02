// @vitest-environment node
// FO-4 acceptance: "a grep of the bundle finds no brand domain, no 'anjuna' or 'aurum' and no
// PostHog key or Sentry DSN". Builds the real production bundle with the real vite config into a
// temp dir, then scans every emitted byte.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRules, scanDir, scanText, unknownDomains } from "../scripts/check-bundle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let outDir = "";
let js = "";
let html = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "form-bundle-"));
  // Vitest runs with NODE_ENV=test, which would make React/JSX emit a development bundle
  // (with absolute source paths in it). Build exactly what CI ships.
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root,
      mode: "production",
      configFile: join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
  html = readFileSync(join(outDir, "index.html"), "utf8");
  js = readdirSync(join(outDir, "assets"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(outDir, "assets", f), "utf8"))
    .join("\n");
});

describe("built bundle", () => {
  it("contains no brand domain, brand name, 'anjuna', 'aurum', PostHog key or Sentry DSN", () => {
    const { files, findings } = scanDir(outDir);
    expect(files).toBeGreaterThan(1);
    expect(findings).toEqual([]);
  });

  it("is built with base /_f/", () => {
    expect(html).toMatch(/src="\/_f\/assets\/[^"]+\.js"/);
    expect(html).toMatch(/href="\/_f\/assets\/[^"]+\.css"/);
    expect(html).toContain('<script type="application/json" id="cfg">{}</script>');
  });

  it("makes no third-party request from the HTML (no CDN scripts, no font host)", () => {
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it("has no gtag ads conversion and no gate-interest side channel", () => {
    expect(js).not.toMatch(/gate-interest/);
    expect(js).not.toMatch(/gtag|googletagmanager|AW-\d+/);
  });

  it("renders the keyword slot and reads the runtime config", () => {
    expect(js).toContain("data-kw");
    expect(js).toContain('getElementById("cfg")');
  });

  it("uses only placeholder telemetry credentials", () => {
    expect(js).toContain("https://public@placeholder.invalid/0");
    expect(js).toContain('"placeholder"');
    expect(js).toContain("disable_compression");
  });
});

describe("scanner catches what it must", () => {
  const rules = buildRules({ extraDomains: ["newbrand.example"], extraStrings: [] });
  const cases: Array<[string, string]> = [
    ["word:aurum", 'x="AURUM"'],
    ["word:anjuna", "anjuna-core"],
    ["brand-domain:harborlinecredit.com", "https://www.harborlinecredit.com/x"],
    ["brand-domain:newbrand.example", "newbrand.example"],
    ["brand-name:CASH LOANS BEAR", "Cash Loans Bear"],
    ["posthog-key", `"phc_${"a1B2".repeat(11)}"`],
    ["sentry-dsn", `dsn:"https://${"0123456789abcdef".repeat(2)}@o123.ingest.us.sentry.io/456"`],
  ];
  for (const [rule, text] of cases) {
    it(`flags ${rule}`, () => {
      expect(scanText(text, rules).map((f) => f.rule)).toContain(rule);
    });
  }

  it("flags an unlisted domain but not minified property access", () => {
    expect(unknownDomains('fetch("https://someotherbrand.com/api")')).toEqual(["someotherbrand.com"]);
    expect(unknownDomains("u.info(x);e.co=1;www.w3.org")).toEqual([]);
  });
});
