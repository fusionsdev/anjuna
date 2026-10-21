import { describe, expect, it } from "vitest";
import {
  BRAND_PROFILE_DEFAULTS, BrandProfile, LifecycleBrandSummary, UpdateBrandDraftRequest, V1_UNSUPPORTED_STATES,
} from "../src/index.js";

const ok = (value: unknown) => BrandProfile.safeParse(value).success;
const disclosures = (over: Record<string, unknown>) => ({ disclosures: over });
const contact = (over: Record<string, unknown>) => ({ contact: over });
const ads = (over: Record<string, unknown>) => ({ ads: over });

describe("BrandProfile", () => {
  it("accepts an empty profile and any subset of groups", () => {
    expect(ok({})).toBe(true);
    expect(ok(contact({}))).toBe(true);
    expect(ok({ ads: { adkit_project: "proj_1" } })).toBe(true);
  });

  it("accepts a full profile", () => {
    expect(ok({
      contact: { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" },
      disclosures: {
        term_min_months: 3, term_max_months: 36, apr_max: 35.99,
        representative_example: "A 12 month loan of $1,000 at 29.99% APR costs about $96 a month.",
        unsupported_states: ["NY", "AR", "VT", "WV", "CA"],
      },
      ads: { google_ads_account: "1234567890", google_conversion_action: "98765", adkit_project: "maple-ads", microsoft_ads_account: "123456" },
    })).toBe(true);
  });

  it("refuses unknown keys at every level, so amount buckets and form route cannot ride along", () => {
    expect(ok({ amount_buckets: [500] })).toBe(false);
    expect(ok({ form_route: "/apply" })).toBe(false);
    expect(ok(contact({ fax: "1234567" }))).toBe(false);
    expect(ok(disclosures({ amount_buckets: [500] }))).toBe(false);
    expect(ok(ads({ aid: "30003" }))).toBe(false);
  });

  describe("contact", () => {
    it.each(["1234567", "+1 555 010 0199", "(555) 010-0199", "1".repeat(20)])("accepts phone %j", (phone) => {
      expect(ok(contact({ phone }))).toBe(true);
    });
    it.each(["123456", "1".repeat(21), "555-CASH-NOW", "555.010.0199", "ext 12345678", ""])("rejects phone %j", (phone) => {
      expect(ok(contact({ phone }))).toBe(false);
    });
    it("limits address to 200 characters and email to 120", () => {
      expect(ok(contact({ address: "a".repeat(200) }))).toBe(true);
      expect(ok(contact({ address: "a".repeat(201) }))).toBe(false);
      expect(ok(contact({ email: `${"a".repeat(100)}@maplecash.test` }))).toBe(true);
      expect(ok(contact({ email: `${"a".repeat(111)}@maplecash.test` }))).toBe(false);
      expect(ok(contact({ email: "not-an-email" }))).toBe(false);
    });
    it.each(["Anjuna Plaza, Austin TX", "12 AURUM Way", "12 Main St\nAustin", "<b>12 Main St</b>"])("rejects address %j", (address) => {
      expect(ok(contact({ address }))).toBe(false);
    });
    it("rejects an email that names a forbidden platform string", () => {
      expect(ok(contact({ email: "help@anjuna.test" }))).toBe(false);
      expect(ok(contact({ email: "Aurum@maplecash.test" }))).toBe(false);
    });
  });

  describe("disclosures", () => {
    it.each([0, 121, 1.5])("rejects term_min_months %j", (value) => {
      expect(ok(disclosures({ term_min_months: value }))).toBe(false);
    });
    it("accepts the term bounds 1 and 120", () => {
      expect(ok(disclosures({ term_min_months: 1, term_max_months: 120 }))).toBe(true);
    });
    it("requires term_min_months <= term_max_months when both are set", () => {
      expect(ok(disclosures({ term_min_months: 12, term_max_months: 12 }))).toBe(true);
      expect(ok(disclosures({ term_min_months: 13, term_max_months: 12 }))).toBe(false);
      expect(ok(disclosures({ term_min_months: 99 }))).toBe(true);
      expect(ok(disclosures({ term_max_months: 2 }))).toBe(true);
    });
    it.each([0, 35.99, 0.07, 1.1, 999.99])("accepts apr_max %j", (apr_max) => {
      expect(ok(disclosures({ apr_max }))).toBe(true);
    });
    it.each([-0.01, 1000, 999.995, 35.999, Number.NaN, Number.POSITIVE_INFINITY])("rejects apr_max %j", (apr_max) => {
      expect(ok(disclosures({ apr_max }))).toBe(false);
    });
    it("caps representative_example at 500 characters", () => {
      expect(ok(disclosures({ representative_example: "a".repeat(500) }))).toBe(true);
      expect(ok(disclosures({ representative_example: "a".repeat(501) }))).toBe(false);
    });
    it.each(["Personal Loan of $500", "a PERSONAL   LOAN", "Anjuna example", "aurum example"])("rejects representative_example %j", (representative_example) => {
      // The wording rule is the template lint's own regex, so it also catches extra spaces between the words.
      expect(ok(disclosures({ representative_example }))).toBe(false);
    });
    it("accepts a state list that holds the global four plus others", () => {
      expect(ok(disclosures({ unsupported_states: [...V1_UNSUPPORTED_STATES] }))).toBe(true);
      expect(ok(disclosures({ unsupported_states: ["WV", "VT", "AR", "NY", "DC", "HI"] }))).toBe(true);
    });
    it.each([{ states: ["NY", "AR", "VT"] }, { states: ["AR", "VT", "WV"] }, { states: [] }])("refuses a state list that drops a global state: $states", ({ states }) => {
      expect(ok(disclosures({ unsupported_states: states }))).toBe(false);
    });
    it.each(["ny", "ZZ", "N", "NYC", "1A", ""])("refuses the state code %j next to the global four", (code) => {
      expect(ok(disclosures({ unsupported_states: [...V1_UNSUPPORTED_STATES, code] }))).toBe(false);
    });
    it("refuses duplicate state codes", () => {
      expect(ok(disclosures({ unsupported_states: ["NY", "AR", "VT", "WV", "CA", "CA"] }))).toBe(false);
    });
  });

  describe("ads", () => {
    it("reuses the admin validators", () => {
      expect(ok(ads({ google_ads_account: "123456789" }))).toBe(false);
      expect(ok(ads({ google_ads_account: "123-456-7890" }))).toBe(false);
      expect(ok(ads({ google_conversion_action: "abc" }))).toBe(false);
      expect(ok(ads({ google_conversion_action: "1".repeat(21) }))).toBe(false);
      expect(ok(ads({ adkit_project: "has space" }))).toBe(false);
      expect(ok(ads({ adkit_project: "a".repeat(65) }))).toBe(false);
    });
    it.each(["123456", "123456789012"])("accepts microsoft_ads_account %j", (value) => {
      expect(ok(ads({ microsoft_ads_account: value }))).toBe(true);
    });
    it.each(["12345", "1234567890123", "12345a", "123-456-789", ""])("rejects microsoft_ads_account %j", (value) => {
      expect(ok(ads({ microsoft_ads_account: value }))).toBe(false);
    });
  });
});

describe("BRAND_PROFILE_DEFAULTS", () => {
  it("is a valid profile with 3 to 36 months, 35.99 APR and the global unsupported states", () => {
    expect(BrandProfile.parse(BRAND_PROFILE_DEFAULTS)).toEqual({
      disclosures: { term_min_months: 3, term_max_months: 36, apr_max: 35.99, unsupported_states: ["NY", "AR", "VT", "WV"] },
    });
  });
  it("copies the global states, so editing the defaults does not edit V1_UNSUPPORTED_STATES", () => {
    expect(BRAND_PROFILE_DEFAULTS.disclosures.unsupported_states).not.toBe(V1_UNSUPPORTED_STATES);
  });
});

describe("UpdateBrandDraftRequest", () => {
  it("accepts any subset of the four keys, including none", () => {
    expect(UpdateBrandDraftRequest.safeParse({}).success).toBe(true);
    expect(UpdateBrandDraftRequest.safeParse({ name: "Maple Cash" }).success).toBe(true);
    expect(UpdateBrandDraftRequest.safeParse({ profile: {} }).success).toBe(true);
  });
  it("trims the name and normalizes the keyword like draft creation", () => {
    expect(UpdateBrandDraftRequest.parse({ name: "  Maple Cash ", keyword_default: "quick   loan!" })).toEqual({ name: "Maple Cash", keyword_default: "Quick Loan" });
  });
  it("refuses a dirty name, an empty keyword, unknown keys and a dirty profile", () => {
    expect(UpdateBrandDraftRequest.safeParse({ name: "Anjuna Cash" }).success).toBe(false);
    expect(UpdateBrandDraftRequest.safeParse({ keyword_default: "!!!" }).success).toBe(false);
    expect(UpdateBrandDraftRequest.safeParse({ domain: "x.test" }).success).toBe(false);
    expect(UpdateBrandDraftRequest.safeParse({ profile: { contact: { address: "Aurum Plaza" } } }).success).toBe(false);
  });
});

describe("LifecycleBrandSummary profile", () => {
  const base = {
    brand_id: "brand-a", account: "acct", hostnames: ["example.com"], status: "draft" as const,
    current_revision_id: null, runtime_sync_status: "queued" as const, bundle_form_version: "form@abcdef1", payload_version: "2026-01",
  };
  it("carries an optional profile and keeps the old shape valid", () => {
    expect(LifecycleBrandSummary.parse(base).profile).toBeUndefined();
    expect(LifecycleBrandSummary.parse({ ...base, profile: { contact: { phone: "555 010 0199" } } }).profile).toEqual({ contact: { phone: "555 010 0199" } });
    expect(LifecycleBrandSummary.safeParse({ ...base, profile: { contact: { phone: "abc" } } }).success).toBe(false);
  });
});
