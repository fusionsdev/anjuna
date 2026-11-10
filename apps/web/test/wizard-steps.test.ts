import { describe, expect, it } from "vitest";
import { BrandProfile } from "@anjuna/contracts";
import type { WizardDraft } from "../src/shared/wizard";
import {
  STEPS, adsOf, contactOf, copyFieldErrors, copyOf, emptyForm, firstIncompleteStep, formFromDraft, stepOfField, validateStep, visibleCopyLength,
  type FieldKey, type WizardForm,
} from "../src/client/wizard/steps";

const templates = [{ template_version_id: "tv-1" }, { template_version_id: "tv-2" }];
const ctx = { hasDraft: false, canEditTracking: true, templates };
const valid = (over: Partial<WizardForm> = {}): WizardForm => ({
  ...emptyForm(),
  name: "Maple Cash", domain: "maple.test", keyword: "Quick Loan", phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test",
  template_version_id: "tv-1",
  ...over,
});
const errorsOf = (step: (typeof STEPS)[number], form: WizardForm, over: Partial<typeof ctx> = {}) => validateStep(step, form, { ...ctx, ...over });
const fieldsOf = (step: (typeof STEPS)[number], form: WizardForm, over: Partial<typeof ctx> = {}) => Object.keys(errorsOf(step, form, over)).sort();
/** Every message is Thai first, then English in parentheses. */
/** A message is Thai only: it has Thai text and no English in parentheses. */
const thaiOnly = (text: string) => /[฀-๿]/.test(text) && !/\([A-Za-z]/.test(text);

describe("emptyForm", () => {
  it("is blank and holds no APR, term or loan-rule field", () => {
    const form = emptyForm();
    expect(form.name).toBe("");
    expect(form.template_version_id).toBe("");
    expect(Object.keys(form).filter((key) => /term|apr|example|states/.test(key))).toEqual([]);
  });
});

describe("step order", () => {
  it("has five steps: no Product step, because the template carries its own disclosures", () => {
    expect(STEPS).toEqual(["brand", "template", "copy", "tracking", "review"]);
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
  it("writes every message in Thai only", () => {
    for (const message of Object.values(errorsOf("brand", { ...emptyForm(), name: "Lead_Cash", domain: "www.x.test", keyword: "!!!", phone: "abc", email: "x" }))) {
      expect(thaiOnly(message!), message).toBe(true);
    }
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
  it("runs validateCopy on the filled h1, cta and sub and leaves empty ones alone", () => {
    expect(copyFieldErrors(valid())).toEqual({});
    expect(copyFieldErrors(valid({ cta: "Check my rate" }))).toEqual({});
    expect(Object.keys(copyFieldErrors(valid({ h1: "No slot here", cta: "Say <b>hi</b>", sub: "Ask about a personal loan" }))).sort()).toEqual(["cta", "h1", "sub"]);
    expect(errorsOf("copy", valid({ h1: "No slot here" })).h1).toMatch(/\{\{keyword\}\}/);
  });
  it("names each rule in Thai: slot, wording, plain text, brand clean and length", () => {
    const one = (over: Partial<WizardForm>, field: "h1" | "cta" | "sub") => copyFieldErrors(valid(over))[field]!;
    for (const message of [
      one({ h1: "Two {{keyword}} and {{keyword}}" }, "h1"),
      one({ h1: "{{keyword}} {other}" }, "h1"),
      one({ sub: "A personal loan for you" }, "sub"),
      one({ cta: 'Say "hi"' }, "cta"),
      one({ sub: "Powered by Anjuna" }, "sub"),
      one({ cta: "a".repeat(41) }, "cta"),
      one({ sub: "a {b} c" }, "sub"),
    ]) expect(thaiOnly(message), message).toBe(true);
    expect(one({ cta: "a".repeat(41) }, "cta")).toContain("40");
    expect(one({ sub: "Powered by Anjuna" }, "sub")).not.toContain("Anjuna");
  });
  it("counts the keyword in the h1 length, like the install does", () => {
    expect(visibleCopyLength(valid({ h1: "{{keyword}} now" }), "h1")).toBe("Quick Loan now".length);
    expect(visibleCopyLength(valid({ cta: " Go " }), "cta")).toBe(2);
    expect(copyFieldErrors(valid({ h1: `${"a".repeat(131)} {{keyword}}` })).h1).toContain("140");
  });
  it("does not report the keyword as a copy error: the Brand step owns it", () => {
    expect(copyFieldErrors(valid({ keyword: "", h1: "{{keyword}} in minutes" }))).toEqual({});
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
    expect(errorsOf("review", valid(), { hasDraft: true })).toEqual({});
    expect(fieldsOf("review", valid({ name: "", site_title: 'x"', google_ads_account: "9", template_version_id: "" }))).toEqual(["google_ads_account", "name", "site_title", "template_version_id"]);
  });
  it("maps a field back to the step that holds it", () => {
    expect(stepOfField("email")).toBe(0);
    expect(stepOfField("template_version_id")).toBe(1);
    expect(stepOfField("cta")).toBe(2);
    expect(stepOfField("adkit_project")).toBe(3);
  });
});

describe("profile groups", () => {
  it("leave out blank fields and trim the rest, and every group is a valid BrandProfile", () => {
    const form = valid({ phone: " 555 010 0199 ", h1: "  ", google_ads_account: "1234567890" });
    expect(contactOf(form)).toEqual({ phone: "555 010 0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" });
    expect(copyOf(form)).toEqual({});
    expect(adsOf(form)).toEqual({ google_ads_account: "1234567890" });
    expect(BrandProfile.safeParse({ contact: contactOf(form), copy: copyOf(form), ads: adsOf(form) }).success).toBe(true);
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

  it("hydrates the form from the draft and leaves a group the draft lacks blank", () => {
    const form = formFromDraft(draft({ contact, copy: { site_title: "Maple Cash | Funding" } }));
    expect(form).toMatchObject({ name: "Maple Cash", domain: "maple.test", keyword: "Quick Loan", template_version_id: "tv-2", phone: contact.phone, site_title: "Maple Cash | Funding", h1: "" });
  });
  it("loads an older draft that holds disclosures, and shows no field for them", () => {
    const form = formFromDraft(draft({ contact, disclosures }));
    expect(form).toEqual(formFromDraft(draft({ contact })));
  });
  it.each<[string, BrandProfile | undefined, number]>([
    ["a draft with no profile", undefined, 0],
    ["a draft with a partial contact", { contact: { phone: contact.phone } }, 0],
    ["contact only", { contact }, 1],
    ["contact and disclosures of an older draft", { contact, disclosures }, 1],
    ["copy saved, no tracking", { contact, copy: {} }, 3],
    ["copy saved with disclosures of an older draft, no tracking", { contact, disclosures, copy: {} }, 3],
    ["everything saved", { contact, copy: {}, ads: {} }, 4],
  ])("resumes %s at step index %i", (_name, profile, expected) => {
    expect(firstIncompleteStep(profile, as)).toBe(expected);
  });
  it("does not hold a role that cannot set tracking at the Tracking step", () => {
    expect(firstIncompleteStep({ contact, copy: {} }, { canEditTracking: false })).toBe(4);
  });
});
