import { describe, expect, it } from "vitest";
import { BRAND_NAME_PATTERN, BrandName, LifecycleBrandSummary } from "../src/index.js";

const valid = ["Level Lending", "  Maple Cash  ", "A", "Café Münch", "สินเชื่อ ด่วน", "Smith & Sons", "O'Neil-Cash Co.", "9 Lives", "x".repeat(60)];
const invalid = ["", "   ", "x".repeat(61), "-Lead", "Lead_Cash", "Lead/Cash", "<b>Lead</b>", "Anjuna Loans", "My AURUM", "a@b"];

describe("BrandName", () => {
  it.each(valid)("accepts %j", (value) => {
    expect(BrandName.safeParse(value).success).toBe(true);
  });
  it.each(invalid)("rejects %j", (value) => {
    expect(BrandName.safeParse(value).success).toBe(false);
  });
  it("trims the accepted value", () => {
    expect(BrandName.parse("  Maple Cash  ")).toBe("Maple Cash");
  });
});

describe("BRAND_NAME_PATTERN", () => {
  // An HTML pattern attribute is wrapped as ^(?:...)$ and compiled with the u or v flag.
  const compile = (flags: string) => new RegExp(`^(?:${BRAND_NAME_PATTERN})$`, flags);
  it.each(["u", "v"])("compiles with the %s flag", (flags) => {
    expect(() => compile(flags)).not.toThrow();
  });
  it.each(["u", "v"])("agrees with BrandName on charset and length, flag %s", (flags) => {
    const re = compile(flags);
    for (const value of valid) expect(re.test(value)).toBe(true);
    // Forbidden words are not a charset rule: BrandName refuses them, the pattern cannot.
    for (const value of invalid.filter((v) => !/anjuna|aurum/i.test(v))) expect(re.test(value)).toBe(false);
  });
});

describe("LifecycleBrandSummary name", () => {
  const base = {
    brand_id: "brand-a", account: "acct", hostnames: ["example.com"], status: "live" as const,
    current_revision_id: "rev-1", runtime_sync_status: "ready" as const, bundle_form_version: "form@abcdef1", payload_version: "2026-01",
  };
  it("carries an optional display name", () => {
    expect(LifecycleBrandSummary.parse({ ...base, name: "Level Lending" }).name).toBe("Level Lending");
    expect(LifecycleBrandSummary.parse(base).name).toBeUndefined();
  });
  it("accepts a legacy domain-derived name that the create rule would refuse", () => {
    expect(LifecycleBrandSummary.safeParse({ ...base, name: "a-very-long-legacy-name-".repeat(4) }).success).toBe(true);
  });
});
