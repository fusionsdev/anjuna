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
    // The H1 slot is baked with the brand name; keyword_default ("Loan Options") stays out of it.
    expect(index).toContain("<h1><span data-kw>Wizard Demo</span> Options in Minutes</h1>");
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

  it("bakes the brand name into the [data-kw] slot when copy.h1 is not set, as the preview does", async () => {
    const noH1 = { ...data, brand_name: "Maple Cash", profile: { ...data.profile, copy: { cta: "Check My Options" } } };
    const { files } = await renderBrand(template(), new Map(), "brand-test", "rev-1", noH1);
    const index = dec.decode(files.get("index.html")!);
    expect(index).toContain("<h1><span data-kw>Maple Cash</span> from <span data-brand>Maple Cash</span></h1>");
    expect(index).not.toContain("<span data-kw>Loan Options</span>");
    const shared = await renderPageText(new Map([["index.html", WILLOW_LAKE_INDEX], ["terms/index.html", WILLOW_LAKE_TERMS]]), noH1);
    expect(index).toBe(shared.get("index.html"));
  });

  it("still enforces clean brand bytes after page text is applied", async () => {
    const { files } = await renderBrand(template(), new Map(), "brand-test", "rev-1", data);
    expect(() => assertCleanBrandBytes(files, "brand-test")).not.toThrow();
    const withoutH1 = { ...data.profile, copy: { cta: "Check My Options" } };
    await expect(renderBrand(template(), new Map(), "brand-test", "rev-1", { ...data, brand_name: "Anjuna Cash", profile: withoutH1 }))
      .rejects.toThrow(/forbidden identity in index\.html/);
    // A filled H1 puts the brand name in the slot, so the copy rules refuse it one step earlier.
    await expect(renderBrand(template(), new Map(), "brand-test", "rev-1", { ...data, brand_name: "Anjuna Cash" }))
      .rejects.toThrow(/forbidden identity/);
  });

  it("fails the render on saved copy that breaks the copy rules", async () => {
    await expect(renderBrand(template(), new Map(), "brand-test", "rev-1", { ...data, profile: { copy: { h1: "No keyword slot" } } }))
      .rejects.toThrow(/Page copy is invalid/);
  });
});
