import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";
import type { FileMap } from "../src/archive";
import { checkTemplate } from "../src/checker";
import { AMOUNT_BUCKETS } from "../src/contract";
import { submitTemplate } from "../src/submit";
import { resetDb, setupDb } from "./helpers";
import indexHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/index.html?raw";
import privacyHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/privacy/index.html?raw";
import termsHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/terms/index.html?raw";
import doNotSellHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/do-not-sell/index.html?raw";
import disclosuresHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/disclosures/index.html?raw";
import ratesHtml from "../../../integrations/open-design/anjuna-landing-template/starter/site/rates-and-fees/index.html?raw";
import siteCss from "../../../integrations/open-design/anjuna-landing-template/starter/site/assets/site.css?raw";
import logoSvg from "../../../integrations/open-design/anjuna-landing-template/starter/site/assets/logo.svg?raw";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

/** The Open Design plugin's starter site, keyed by path relative to starter/site/. */
const SOURCES: Record<string, string> = {
  "index.html": indexHtml,
  "privacy/index.html": privacyHtml,
  "terms/index.html": termsHtml,
  "do-not-sell/index.html": doNotSellHtml,
  "disclosures/index.html": disclosuresHtml,
  "rates-and-fees/index.html": ratesHtml,
  "assets/site.css": siteCss,
  "assets/logo.svg": logoSvg,
};
const starterSite = (): FileMap => new Map(Object.entries(SOURCES).map(([path, text]) => [path, strToU8(text)]));
const pages = Object.entries(SOURCES).filter(([path]) => path.endsWith(".html"));

const browserEnv = { ...env, BROWSER: {} as Fetcher };
const builder = { key_id: "bk_test", label: "Starter skeleton" };

describe("starter skeleton site", () => {
  it("loads all eight files with real content", () => {
    const files = starterSite();
    expect([...files.keys()].sort()).toEqual([
      "assets/logo.svg", "assets/site.css", "disclosures/index.html", "do-not-sell/index.html", "index.html", "privacy/index.html", "rates-and-fees/index.html", "terms/index.html",
    ]);
    for (const [path, bytes] of files) expect(bytes.byteLength, path).toBeGreaterThan(100);
  });

  it("passes the template checker with no errors and no brand-slot warning", () => {
    const report = checkTemplate(starterSite());
    const warnings = report.issues.filter((i) => i.severity === "warning");
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report).toMatchObject({ pass: true, errors: 0 });
    expect(warnings.filter((i) => i.rule === "brand-slot" || i.rule === "meta" || /data-brand/.test(i.message))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("contains no platform or other-brand name in any file", () => {
    for (const [path, text] of Object.entries(SOURCES)) expect(text, path).not.toMatch(/anjuna|aurum/i);
  });

  it("has no JavaScript, external URLs, dashes or banned wording", () => {
    for (const [path, text] of Object.entries(SOURCES)) {
      expect(text, path).not.toMatch(/<script|<iframe|<textarea|javascript:|\son[a-z]+=/i);
      expect(text.includes(String.fromCharCode(0x2013)) || text.includes(String.fromCharCode(0x2014)), `${path} has an en or em dash`).toBe(false);
      expect(text, path).not.toMatch(/personal\s+loans?|guaranteed|no\s+credit\s+check|instant\s+approval|100%\s+approved/i);
      // The SVG namespace declaration is an identifier, not a request.
      expect(text.replace('xmlns="http://www.w3.org/2000/svg"', ""), path).not.toMatch(/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    }
  });

  it("puts the same footer with the five legal links and the disclosure on every page", () => {
    for (const [path, html] of pages) {
      for (const href of ["/privacy/", "/terms/", "/do-not-sell/", "/disclosures/", "/rates-and-fees/"]) expect(html, path).toContain(`<a href="${href}">`);
      expect(html, path).toContain(">Do Not Sell or Share My Personal Information</a>");
      expect(html, path).toContain("<span data-brand>Brand Name</span> is not a lender. Rates and terms vary by lender and state. Not all applicants qualify.");
      expect(html, path).toContain('<a class="brand-link" href="/"><img src="/assets/logo.svg" alt=""><span data-brand>Brand Name</span></a>');
    }
  });

  it("keeps the landing page head, keyword slot and single CTA form from the contract", () => {
    expect(indexHtml).toContain("<title>Brand Name | Check Your Funding Options</title>");
    const description = /<meta name="description" content="([^"]*)">/.exec(indexHtml)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(indexHtml.match(/<h1>/g)).toHaveLength(1);
    expect(indexHtml).toContain("<h1><span data-kw>Funding Options</span> | Check Your Options in Minutes</h1>");
    expect(indexHtml.match(/<form\b/g)).toHaveLength(1);
    expect(indexHtml).toContain('<form class="cta-form" method="get" action="/go" data-cta>');
    expect([...indexHtml.matchAll(/<option value="(\d+)">/g)].map((m) => Number(m[1]))).toEqual([...AMOUNT_BUCKETS]);
    expect([...indexHtml.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1])).toEqual(["requested_amount", "zip"]);
    expect(indexHtml).not.toMatch(/type="hidden"/i);
    expect(indexHtml.match(/<details>/g)).toHaveLength(4);
    expect(indexHtml).toContain('id="top"');
    expect(indexHtml).toContain('<a class="button" href="#top">');
  });

  it("marks every page with REDESIGN comments and the legal pages with placeholders", () => {
    for (const [path, html] of pages) expect(html, path).toMatch(/<!-- REDESIGN: /);
    for (const [path, html] of pages.filter(([p]) => p !== "index.html")) {
      const paragraphs = [...html.matchAll(/<p>(\[Placeholder\][^<]*(?:<span data-brand>Brand Name<\/span>[^<]*)?)<\/p>/g)];
      expect(paragraphs.length, path).toBeGreaterThanOrEqual(3);
      expect(paragraphs.length, path).toBeLessThanOrEqual(5);
    }
    expect(disclosuresHtml).toContain("Not all applicants qualify.");
    expect(disclosuresHtml).toContain("Rates and terms vary by lender and state.");
    expect(disclosuresHtml).toContain("is not a lender.");
  });

  it("ships a rates and fees page with an APR range and a labeled example", () => {
    expect(ratesHtml.match(/<h1>/g)).toHaveLength(1);
    expect(ratesHtml).toContain("<h1>Rates and Fees</h1>");
    expect(ratesHtml).toMatch(/APRs from [\d.]+% to [\d.]+%/);
    expect(ratesHtml).toContain("Example only. This is not an offer and not a quote.");
    expect(ratesHtml).toContain("About $200.91");
  });
});

describe("starter skeleton submission", () => {
  beforeAll(setupDb);
  beforeEach(async () => {
    await resetDb();
    vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  });

  it("is submitted as awaiting_approval with the brand name read from data-brand", async () => {
    const result = await submitTemplate(browserEnv, {
      template_id: "starter-skeleton", template_name: "Starter Skeleton", files: starterSite(), submitted_by: builder, created_by: "bk_test",
    });
    expect(result.issues).toEqual([]);
    expect(result.status).toBe("awaiting_approval");
    expect(result.text_defaults).toMatchObject({ brand_name: "Brand Name", title: "Brand Name | Check Your Funding Options" });
    expect(result.warnings).toEqual([]);
  });
});
