import { describe, expect, it } from "vitest";
import { renderPageText } from "@anjuna/brand-runtime/page-text";
import { WILLOW_LAKE_INDEX, WILLOW_LAKE_TERMS, WIZARD_DEMO_PAGE_TEXT } from "@anjuna/brand-runtime/testing";
import { assertCleanBrandBytes, renderBrand, type FileMap, type LegalRenderData } from "../src/render";

const enc = new TextEncoder();
const dec = new TextDecoder();
const template = (): FileMap => new Map([
  ["index.html", enc.encode(WILLOW_LAKE_INDEX)],
  ["terms/index.html", enc.encode(WILLOW_LAKE_TERMS)],
  ["assets/site.css", enc.encode("body { color: black }")],
]);
const { brand_name, template_brand, keyword_default, profile } = WIZARD_DEMO_PAGE_TEXT;
const data: LegalRenderData = { brand_name, template_brand, keyword_default, profile };

describe("renderBrand page text (FUS-364)", () => {
  it("writes the wizard H1, CTA, phone and brand name into the Willow Lake pattern", async () => {
    const { files } = await renderBrand(template(), new Map(), "brand-test", "rev-1", data);
    const index = dec.decode(files.get("index.html")!);
    expect(index).toContain("<h1><span data-kw>Loan Options</span> Options in Minutes</h1>");
    expect(index).toContain('<button type="submit">Check My Options</button>');
    expect(index).toContain('href="tel:+15550100199"');
    expect(index).toContain("<h3>What is <span data-brand>Wizard Demo</span>?</h3>");
    expect(index).not.toContain("710-3200");
    // Left for the brand Worker, which writes the live brand name: <title> and the index og:title.
    expect(index.replace(/<title>.*?<\/title>/, "").replace(/<meta property="og:title"[^>]*>/, "")).not.toContain("Willow Lake");
    expect(dec.decode(files.get("terms/index.html")!)).not.toMatch(/Willow Lake Lending\.|710-3200/);
    expect(files.get("assets/site.css")).toEqual(template().get("assets/site.css"));
  });

  it("uploads exactly what the shared page text function returns (the wizard preview runs the same function)", async () => {
    const { files } = await renderBrand(template(), new Map(), "brand-test", "rev-1", data);
    const shared = await renderPageText(new Map([["index.html", WILLOW_LAKE_INDEX], ["terms/index.html", WILLOW_LAKE_TERMS]]), WIZARD_DEMO_PAGE_TEXT);
    expect(dec.decode(files.get("index.html")!)).toBe(shared.get("index.html"));
    expect(dec.decode(files.get("terms/index.html")!)).toBe(shared.get("terms/index.html"));
  });

  it("still enforces clean brand bytes after page text is applied", async () => {
    const { files } = await renderBrand(template(), new Map(), "brand-test", "rev-1", data);
    expect(() => assertCleanBrandBytes(files, "brand-test")).not.toThrow();
    await expect(renderBrand(template(), new Map(), "brand-test", "rev-1", { ...data, brand_name: "Anjuna Cash" }))
      .rejects.toThrow(/forbidden identity in index\.html/);
  });

  it("fails the render on saved copy that breaks the copy rules", async () => {
    await expect(renderBrand(template(), new Map(), "brand-test", "rev-1", { ...data, profile: { copy: { h1: "No keyword slot" } } }))
      .rejects.toThrow(/Page copy is invalid/);
  });
});
