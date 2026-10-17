import { describe, expect, it } from "vitest";
import { SITE_TEXT_LIMITS, SiteBrandName, SiteDescription, SiteTitle, TemplateTextDefaults, normalizeSiteText } from "../src/index.js";

describe("site text values", () => {
  it("accepts trimmed plain text up to each limit, including & and '", () => {
    expect(SiteBrandName.parse("  Harbor & Co.  ")).toBe("Harbor & Co.");
    expect(SiteTitle.parse("Harbor's Options")).toBe("Harbor's Options");
    expect(SiteTitle.safeParse("T".repeat(70)).success).toBe(true);
    expect(SiteTitle.safeParse("T".repeat(71)).success).toBe(false);
    expect(SiteDescription.safeParse("d".repeat(160)).success).toBe(true);
    expect(SiteDescription.safeParse("d".repeat(161)).success).toBe(false);
    expect(SiteBrandName.safeParse("B".repeat(81)).success).toBe(false);
  });

  it.each(["", "   ", "Harbor <b>", 'Say "hi"', "line\nbreak", "Anjuna Funding", "AURUM", "Personal Loans Fast", "personal  loan"])("rejects %j", (value) => {
    expect(SiteTitle.safeParse(value).success).toBe(false);
  });

  it("normalizes extracted text: whitespace collapsed, cut to the limit, null when invalid", () => {
    expect(normalizeSiteText("  Harbor \n Funding  ", "brand_name")).toBe("Harbor Funding");
    expect(normalizeSiteText("x".repeat(100), "title")).toBe("x".repeat(70));
    expect(normalizeSiteText("Personal Loans Today", "title")).toBeNull();
    expect(normalizeSiteText(null, "description")).toBeNull();
  });

  it("text defaults are strict and nullable", () => {
    expect(TemplateTextDefaults.parse({ brand_name: null, title: "Harbor | Funding", description: null })).toEqual({ brand_name: null, title: "Harbor | Funding", description: null });
    expect(TemplateTextDefaults.safeParse({ brand_name: null, title: null, description: null, extra: 1 }).success).toBe(false);
    expect(SITE_TEXT_LIMITS).toEqual({ brand_name: 80, title: 70, description: 160 });
  });
});
