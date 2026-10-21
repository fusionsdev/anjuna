import { describe, expect, it, vi } from "vitest";
import { validateCopy } from "@anjuna/contracts";
import { fillCopy, type CopyDraft } from "../src/copy-fill";

const draft: CopyDraft = { brand_name: "Harbor", keyword_default: "Funding Options" };
const valid = { h1: "{{keyword}} | Check Your Options", cta: "Continue", sub: "Explore options with Harbor." };

describe("fillCopy", () => {
  it("uses deterministic validated fallback when no AI adapter is bound", async () => {
    const result = await fillCopy(draft);
    expect(result).toEqual(await fillCopy(draft));
    expect(result.issues).toEqual([]);
    expect(validateCopy(result.copy, draft.keyword_default)).toEqual([]);
    expect(result.copy.sub).toContain(draft.brand_name);
    expect(result.copy.sub).toContain(draft.keyword_default);
  });

  it("requests only blanks and leaves employee text byte-identical", async () => {
    const own = Object.freeze({ h1: "  {{keyword}} | My Headline  ", cta: "\t ", sub: "Employee text." });
    const generate = vi.fn(async () => valid);
    const result = await fillCopy({ ...draft, copy: own }, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      brand_name: "Harbor", keyword_default: "Funding Options", keyword_marker: "{{keyword}}", fields: ["cta"],
    });
    expect(result).toEqual({ copy: { ...own, cta: valid.cta }, issues: [] });
    expect(own.cta).toBe("\t ");
  });

  it("handles absent, null, empty and whitespace-only fields", async () => {
    const generate = vi.fn(async () => valid);
    expect(await fillCopy({ ...draft, copy: { h1: null, cta: "", sub: "  " } }, { generate })).toEqual({ copy: valid, issues: [] });
  });

  it("never calls the adapter for a filled draft, but still validates employee text", async () => {
    const generate = vi.fn();
    const own = { ...valid, cta: "Personal Loans" };
    const result = await fillCopy({ ...draft, copy: own }, { generate });
    expect(generate).not.toHaveBeenCalled();
    expect(result.copy).toEqual(own);
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "cta", code: "forbidden_wording" }));
  });

  it("reports adapter failure without leaking its error or changing employee text", async () => {
    const own = { ...valid, sub: "" };
    const result = await fillCopy({ ...draft, copy: own }, { generate: async () => { throw new Error("private provider details"); } });
    expect(result.copy).toEqual(own);
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "adapter", code: "adapter_failed" }));
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "sub", code: "required" }));
    expect(JSON.stringify(result)).not.toContain("private provider details");
  });

  it.each([
    null, [], "unstructured text", {}, { ...valid, h1: 12 }, { ...valid, h1: "Missing slot" },
    { ...valid, cta: "Personal Loans" }, { ...valid, sub: "Anjuna" }, { ...valid, sub: "<img src=x>" },
    { ...valid, cta: "x".repeat(41) },
  ])("rejects malformed or invalid adapter output atomically: %j", async (output) => {
    const result = await fillCopy(draft, { generate: async () => output });
    expect(result.copy).toEqual({ h1: "", cta: "", sub: "" });
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("keeps even invalid employee text on generation validation failure", async () => {
    const own = { h1: "My existing headline", cta: "", sub: "Employee text." };
    const result = await fillCopy({ ...draft, copy: own }, { generate: async () => valid });
    expect(result.copy).toEqual(own);
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "h1", code: "keyword_slot" }));
  });

  it("validates fallback values too", async () => {
    const result = await fillCopy({ ...draft, brand_name: "Aurum" });
    expect(result.copy).toEqual({ h1: "", cta: "", sub: "" });
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "sub", code: "brand_clean" }));
  });
});
