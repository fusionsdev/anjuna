import { describe, expect, it } from "vitest";
import { COPY_KEYWORD_MARKER, COPY_LIMITS, renderCopyH1, validateCopy, type BrandCopy } from "../src/index.js";

const keyword = "Funding Options";
const copy: BrandCopy = { h1: "{{keyword}} | Check Your Options", cta: "Continue", sub: "Explore options with Harbor & Co." };

describe("validateCopy", () => {
  it("accepts plain copy and preserves the KeywordSlot in generated H1 markup", () => {
    expect(validateCopy(copy, keyword)).toEqual([]);
    expect(renderCopyH1(copy.h1, keyword)).toBe('<span data-kw>Funding Options</span> | Check Your Options');
    expect(renderCopyH1("Harbor & Co. | {{keyword}}", keyword)).toBe('Harbor &amp; Co. | <span data-kw>Funding Options</span>');
  });

  it.each(["Funding Options", "{{keyword}} {{keyword}}", "{{Keyword}}", "{{keyword}} {{brand}}", '<span data-kw>Funding Options</span>'])("rejects a missing, duplicate or HTML slot: %s", (h1) => {
    expect(validateCopy({ ...copy, h1 }, keyword).length).toBeGreaterThan(0);
    expect(() => renderCopyH1(h1, keyword)).toThrow();
  });

  it.each(["h1", "cta", "sub"] as const)("checks required, plain text, wording and clean bytes for %s", (field) => {
    for (const value of ["", "   ", "x\ny", "x\u0000y", "<b>Hi</b>", 'Say "hi"', "Personal Loans", "PERSONAL  LOAN", "Anjuna", "AURUM", "brand_0123456789abcdef", "phc_0123456789abcdef", "https://public@errors.example/1"]) {
      const result = validateCopy({ ...copy, [field]: value }, keyword);
      expect(result.some((issue) => issue.field === field), value).toBe(true);
    }
  });

  it("checks visible lengths after keyword expansion, including boundaries", () => {
    const h1 = COPY_KEYWORD_MARKER + "x".repeat(COPY_LIMITS.h1 - keyword.length);
    const max = { h1, cta: "c".repeat(COPY_LIMITS.cta), sub: "s".repeat(COPY_LIMITS.sub) };
    expect(validateCopy(max, keyword)).toEqual([]);
    for (const field of ["h1", "cta", "sub"] as const) {
      expect(validateCopy({ ...max, [field]: max[field] + "x" }, keyword)).toContainEqual(expect.objectContaining({ field, code: "length" }));
    }
  });

  it("counts slot text literally: $& in a brand name is 2 characters, not the marker", () => {
    // 136 + space + 2 = 139 visible. A replacement pattern would insert the 11-character marker and give 148.
    expect(validateCopy({ ...copy, h1: "a".repeat(136) + " {{keyword}}" }, "Maple", "$&")).toEqual([]);
    // 138 + space + 2 = 141 is one over the 140 limit.
    expect(validateCopy({ ...copy, h1: "a".repeat(138) + " {{keyword}}" }, "Maple", "$&")).toContainEqual(expect.objectContaining({ field: "h1", code: "length" }));
  });

  it("slotText is what the marker becomes: it sets the visible length and the markup, keyword_default is still checked on its own", () => {
    const brand = "Harbor & Sons, LLC";
    expect(renderCopyH1(copy.h1, keyword, brand)).toBe("Harbor &amp; Sons, LLC | Check Your Options".replace(/^(.*?) \| /, '<span data-kw>$1</span> | '));
    const h1 = COPY_KEYWORD_MARKER + "x".repeat(COPY_LIMITS.h1 - brand.length);
    expect(validateCopy({ ...copy, h1 }, keyword, brand)).toEqual([]);
    expect(validateCopy({ ...copy, h1: h1 + "x" }, keyword, brand)).toContainEqual(expect.objectContaining({ field: "h1", code: "length" }));
    expect(validateCopy({ ...copy, h1: "{{keyword}} | Anything" }, keyword, "Anjuna Cash")).toContainEqual(expect.objectContaining({ field: "h1", code: "brand_clean" }));
    expect(validateCopy(copy, "not clean!", brand).some((issue) => issue.field === "keyword_default")).toBe(true);
    expect(validateCopy(copy, keyword, brand).some((issue) => issue.field === "keyword_default")).toBe(false);
  });

  it.each(["", "funding options", "<b>Funding</b>", "Personal Loans", "Anjuna", "A".repeat(61)])("rejects invalid keyword_default: %s", (value) => {
    expect(validateCopy(copy, value).some((issue) => issue.field === "keyword_default")).toBe(true);
  });

  it("refuses placeholders outside H1 and wording split across the keyword boundary", () => {
    expect(validateCopy({ ...copy, cta: "{{keyword}}" }, keyword)).toContainEqual(expect.objectContaining({ field: "cta", code: "keyword_slot" }));
    expect(validateCopy({ ...copy, h1: "Personal {{keyword}}" }, "Loans")).toContainEqual(expect.objectContaining({ field: "h1", code: "forbidden_wording" }));
    expect(validateCopy({ ...copy, h1: "anj{{keyword}}" }, "Una")).toContainEqual(expect.objectContaining({ field: "h1", code: "brand_clean" }));
    expect(() => renderCopyH1("anj{{keyword}}", "Una")).toThrow();
  });
});
