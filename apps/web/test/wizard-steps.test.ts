import { describe, expect, it } from "vitest";
import { BRAND_PROFILE_DEFAULTS, BrandProfile } from "@anjuna/contracts";
import type { WizardDraft } from "../src/shared/wizard";
import {
  STEPS, adsOf, contactOf, copyOf, disclosuresOf, emptyForm, firstIncompleteStep, formFromDraft, stepOfField, validateStep,
  type FieldKey, type WizardForm,
} from "../src/client/wizard/steps";

const templates = [{ template_version_id: "tv-1" }, { template_version_id: "tv-2" }];
const ctx = { hasDraft: false, canEditTracking: true, templates };
const valid = (over: Partial<WizardForm> = {}): WizardForm => ({
  ...emptyForm(),
  name: "Maple Cash", domain: "maple.test", keyword: "Quick Loan", phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test",
  representative_example: "A 12 month loan of $1,000 at 29.99% APR costs about $96 a month.", template_version_id: "tv-1",
  ...over,
});
const errorsOf = (step: (typeof STEPS)[number], form: WizardForm, over: Partial<typeof ctx> = {}) => validateStep(step, form, { ...ctx, ...over });
const fieldsOf = (step: (typeof STEPS)[number], form: WizardForm, over: Partial<typeof ctx> = {}) => Object.keys(errorsOf(step, form, over)).sort();
/** Every message is Thai first, then English in parentheses. */
const bilingual = (text: string) => /[฀-๿]/.test(text) && /\([A-Za-z]/.test(text);

describe("emptyForm", () => {
  it("fills the product defaults from BRAND_PROFILE_DEFAULTS and nothing else", () => {
    const form = emptyForm();
    expect(disclosuresOf(form)).toEqual(BRAND_PROFILE_DEFAULTS.disclosures);
    expect(form.name).toBe("");
    expect(form.template_version_id).toBe("");
  });
});

describe("step order", () => {
  it("has six steps in the brief's order", () => {
    expect(STEPS).toEqual(["brand", "product", "template", "copy", "tracking", "review"]);
  });
});

describe("validateStep brand", () => {
  it("accepts a complete brand step", () => {
    expect(errorsOf("brand", valid())).toEqual({});
  });
  it("requires name, domain, keyword, phone, address and email", () => {
    expect(fieldsOf("brand", emptyForm())).toEqual(["address", "domain", "email", "keyword", "name", "phone"]);
  });
  it.each<[string, Partial<WizardForm>, FieldKey]>([
    ["a name with an underscore", { name: "Lead_Cash" }, "name"],
    ["a name with a forbidden word", { name: "Anjuna Loans" }, "name"],
    ["a www domain", { domain: "www.maple.test" }, "domain"],
    ["a single label domain", { domain: "localhost" }, "domain"],
    ["a url as the domain", { domain: "https://maple.test" }, "domain"],
    ["a keyword with nothing left after cleanup", { keyword: "!!!" }, "keyword"],
    ["a phone with letters", { phone: "555-CASH" }, "phone"],
    ["a short phone", { phone: "123" }, "phone"],
    ["a markup address", { address: "<b>12 Main St</b>" }, "address"],
    ["a bad email", { email: "help@" }, "email"],
    ["an email with a forbidden word", { email: "help@aurum.test" }, "email"],
  ])("refuses %s", (_name, over, field) => {
    expect(Object.keys(errorsOf("brand", valid(over)))).toEqual([field]);
  });
  it("does not check the domain once the draft exists, because the domain is fixed", () => {
    expect(errorsOf("brand", valid({ domain: "" }), { hasDraft: true })).toEqual({});
  });
  it("writes every message as Thai with English in parentheses", () => {
    for (const message of Object.values(errorsOf("brand", { ...emptyForm(), name: "Lead_Cash", domain: "www.x.test", keyword: "!!!", phone: "abc", email: "x" }))) {
      expect(bilingual(message!), message).toBe(true);
    }
  });
});

describe("validateStep product", () => {
  it("needs only the representative example on top of the defaults", () => {
    expect(fieldsOf("product", { ...emptyForm() })).toEqual(["representative_example"]);
    expect(errorsOf("product", valid())).toEqual({});
  });
  it.each<[string, Partial<WizardForm>, FieldKey]>([
    ["a reversed term range", { term_min: "40", term_max: "12" }, "term_min"],
    ["a term of 0 months", { term_min: "0" }, "term_min"],
    ["a term above 120 months", { term_max: "121" }, "term_max"],
    ["a fractional term", { term_min: "2.5" }, "term_min"],
    ["an APR with 3 decimals", { apr_max: "35.999" }, "apr_max"],
    ["an APR above 999.99", { apr_max: "1000" }, "apr_max"],
    ["an APR that is not a number", { apr_max: "high" }, "apr_max"],
    ["states without NY", { unsupported_states: "AR, VT, WV" }, "unsupported_states"],
    ["a lowercase state", { unsupported_states: "NY, AR, VT, WV, ca" }, "unsupported_states"],
    ["an unknown state", { unsupported_states: "NY, AR, VT, WV, ZZ" }, "unsupported_states"],
    ["a duplicate state", { unsupported_states: "NY, AR, VT, WV, CA, CA" }, "unsupported_states"],
    ["personal loan wording", { representative_example: "A Personal Loan of $500 costs $40" }, "representative_example"],
  ])("refuses %s", (_name, over, field) => {
    expect(Object.keys(errorsOf("product", valid(over)))).toEqual([field]);
  });
  it("accepts extra states on top of the global four", () => {
    expect(errorsOf("product", valid({ unsupported_states: "NY, AR, VT, WV, CA" }))).toEqual({});
  });
});

describe("validateStep template, copy and tracking", () => {
  it("needs one of the approved templates", () => {
    expect(fieldsOf("template", valid({ template_version_id: "" }))).toEqual(["template_version_id"]);
    expect(fieldsOf("template", valid({ template_version_id: "tv-other" }))).toEqual(["template_version_id"]);
    expect(errorsOf("template", valid({ template_version_id: "tv-2" }))).toEqual({});
  });
  it("accepts an empty copy step, because blank means the template text", () => {
    expect(errorsOf("copy", valid())).toEqual({});
  });
  it("applies the site-text contract to brand name, title and description", () => {
    expect(fieldsOf("copy", valid({ site_title: 'Say "hi"', site_description: "a".repeat(161), brand_name: "Anjuna Cash" }))).toEqual(["brand_name", "site_description", "site_title"]);
    expect(errorsOf("copy", valid({ brand_name: "Maple Cash", site_title: "Maple Cash | Funding", site_description: "See your options.", h1: "{{keyword}} in minutes", cta: "Check my rate", sub: "No hard pull" }))).toEqual({});
  });
  it("keeps h1, cta and sub to plain one-line text", () => {
    expect(fieldsOf("copy", valid({ h1: "<b>Hi</b>", cta: "a".repeat(201) }))).toEqual(["cta", "h1"]);
  });
  it("checks tracking ids with the admin validators when the role may set them", () => {
    expect(fieldsOf("tracking", valid({ google_ads_account: "123-456-7890", google_conversion_action: "abc", adkit_project: "has space", microsoft_ads_account: "12345" }))).toEqual(["adkit_project", "google_ads_account", "google_conversion_action", "microsoft_ads_account"]);
    expect(errorsOf("tracking", valid())).toEqual({});
    expect(errorsOf("tracking", valid({ google_ads_account: "1234567890", google_conversion_action: "555", adkit_project: "maple-ads", microsoft_ads_account: "654321" }))).toEqual({});
  });
  it("skips tracking validation for a role that sees the fields read-only", () => {
    expect(errorsOf("tracking", valid({ google_ads_account: "bad" }), { canEditTracking: false })).toEqual({});
  });
});

describe("validateStep review", () => {
  it("passes a complete form and reports every step's errors otherwise", () => {
    expect(errorsOf("review", valid({ unsupported_states: "NY, AR, VT, WV" }), { hasDraft: true })).toEqual({});
    expect(fieldsOf("review", valid({ name: "", term_min: "0", site_title: 'x"', google_ads_account: "9", template_version_id: "" }))).toEqual(["google_ads_account", "name", "site_title", "template_version_id", "term_min"]);
  });
  it("maps a field back to the step that holds it", () => {
    expect(stepOfField("email")).toBe(0);
    expect(stepOfField("apr_max")).toBe(1);
    expect(stepOfField("template_version_id")).toBe(2);
    expect(stepOfField("cta")).toBe(3);
    expect(stepOfField("adkit_project")).toBe(4);
  });
});

describe("profile groups", () => {
  it("leave out blank fields and trim the rest, and every group is a valid BrandProfile", () => {
    const form = valid({ phone: " 555 010 0199 ", h1: "  ", google_ads_account: "1234567890" });
    expect(contactOf(form)).toEqual({ phone: "555 010 0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" });
    expect(copyOf(form)).toEqual({});
    expect(adsOf(form)).toEqual({ google_ads_account: "1234567890" });
    expect(BrandProfile.safeParse({ contact: contactOf(form), disclosures: disclosuresOf(form), copy: copyOf(form), ads: adsOf(form) }).success).toBe(true);
  });
  it("turns the states text into a list and the numbers into numbers", () => {
    expect(disclosuresOf(valid({ term_min: "6", apr_max: "29.99", unsupported_states: " NY,AR , VT,WV " }))).toMatchObject({ term_min_months: 6, apr_max: 29.99, unsupported_states: ["NY", "AR", "VT", "WV"] });
  });
});

describe("formFromDraft and firstIncompleteStep", () => {
  const draft = (profile?: BrandProfile): WizardDraft => ({
    brand: { brand_id: "brand_1", name: "Maple Cash", domain: "maple.test", keyword_default: "Quick Loan", status: "draft" },
    revision: { revision_id: "brand_1_rev_1", revision: 1, template_version_id: "tv-2", form_artifact_id: "fa-1" },
    ...(profile ? { profile } : {}),
  });
  const contact = { phone: "+1 (555) 010-0199", address: "12 Main St", email: "help@maplecash.test" };
  const disclosures = { term_min_months: 6, term_max_months: 48, apr_max: 29.99, representative_example: "A 12 month loan.", unsupported_states: ["NY", "AR", "VT", "WV"] as ["NY", "AR", "VT", "WV"] };
  const as = { canEditTracking: true };

  it("hydrates the form from the draft and keeps the defaults for a group the draft lacks", () => {
    const form = formFromDraft(draft({ contact, copy: { site_title: "Maple Cash | Funding" } }));
    expect(form).toMatchObject({ name: "Maple Cash", domain: "maple.test", keyword: "Quick Loan", template_version_id: "tv-2", phone: contact.phone, site_title: "Maple Cash | Funding", term_min: "3", term_max: "36", apr_max: "35.99" });
  });
  it.each<[string, BrandProfile | undefined, number]>([
    ["a draft with no profile", undefined, 0],
    ["a draft with a partial contact", { contact: { phone: contact.phone } }, 0],
    ["contact only", { contact }, 1],
    ["disclosures missing the example", { contact, disclosures: { ...disclosures, representative_example: undefined } }, 1],
    ["contact and disclosures", { contact, disclosures }, 2],
    ["copy saved, no tracking", { contact, disclosures, copy: {} }, 4],
    ["everything saved", { contact, disclosures, copy: {}, ads: {} }, 5],
  ])("resumes %s at step index %i", (_name, profile, expected) => {
    expect(firstIncompleteStep(profile, as)).toBe(expected);
  });
  it("does not hold a role that cannot set tracking at the Tracking step", () => {
    expect(firstIncompleteStep({ contact, disclosures, copy: {} }, { canEditTracking: false })).toBe(5);
  });
});
