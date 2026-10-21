/**
 * Brand wizard model: the six steps, the form, per-step validation against the shared contracts, the profile
 * groups each step saves, and which step a saved draft resumes at. Pure functions, no React.
 */
import { BRAND_PROFILE_DEFAULTS, BrandDraftKeyword, BrandName, BrandProfile } from "@anjuna/contracts";
import { DraftDomain, type WizardDraft } from "../../shared/wizard";
import { describeIssue, requiredText } from "./messages";

export const STEPS = ["brand", "product", "template", "copy", "tracking", "review"] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABEL: Record<StepId, string> = {
  brand: "แบรนด์ (Brand)",
  product: "ผลิตภัณฑ์ (Product)",
  template: "เทมเพลต (Template)",
  copy: "ข้อความ (Copy)",
  tracking: "ติดตามผล (Tracking)",
  review: "ตรวจสอบ (Review)",
};

export interface WizardForm {
  name: string;
  domain: string;
  keyword: string;
  phone: string;
  address: string;
  email: string;
  term_min: string;
  term_max: string;
  apr_max: string;
  representative_example: string;
  /** Comma separated state codes. */
  unsupported_states: string;
  template_version_id: string;
  brand_name: string;
  site_title: string;
  site_description: string;
  h1: string;
  cta: string;
  sub: string;
  google_ads_account: string;
  google_conversion_action: string;
  adkit_project: string;
  microsoft_ads_account: string;
}
export type FieldKey = keyof WizardForm;
export type FieldErrors = Partial<Record<FieldKey, string>>;

const DEFAULT_DISCLOSURES = BRAND_PROFILE_DEFAULTS.disclosures;

/** A blank form with the tenant profile defaults filled in. */
export function emptyForm(): WizardForm {
  return {
    name: "", domain: "", keyword: "", phone: "", address: "", email: "",
    term_min: String(DEFAULT_DISCLOSURES.term_min_months), term_max: String(DEFAULT_DISCLOSURES.term_max_months),
    apr_max: String(DEFAULT_DISCLOSURES.apr_max), representative_example: "", unsupported_states: DEFAULT_DISCLOSURES.unsupported_states.join(", "),
    template_version_id: "", brand_name: "", site_title: "", site_description: "", h1: "", cta: "", sub: "",
    google_ads_account: "", google_conversion_action: "", adkit_project: "", microsoft_ads_account: "",
  };
}

/** The form a saved draft resumes with. A group the draft does not hold keeps its default or stays blank. */
export function formFromDraft(draft: WizardDraft): WizardForm {
  const form = emptyForm();
  const { contact, disclosures, copy, ads } = draft.profile ?? {};
  const text = (value: string | number | undefined, fallback: string) => (value === undefined ? fallback : String(value));
  return {
    ...form,
    name: draft.brand.name, domain: draft.brand.domain, keyword: draft.brand.keyword_default ?? "",
    phone: contact?.phone ?? "", address: contact?.address ?? "", email: contact?.email ?? "",
    term_min: text(disclosures?.term_min_months, form.term_min), term_max: text(disclosures?.term_max_months, form.term_max),
    apr_max: text(disclosures?.apr_max, form.apr_max), representative_example: disclosures?.representative_example ?? "",
    unsupported_states: disclosures?.unsupported_states?.join(", ") ?? form.unsupported_states,
    template_version_id: draft.revision.template_version_id,
    brand_name: copy?.brand_name ?? "", site_title: copy?.site_title ?? "", site_description: copy?.site_description ?? "",
    h1: copy?.h1 ?? "", cta: copy?.cta ?? "", sub: copy?.sub ?? "",
    google_ads_account: ads?.google_ads_account ?? "", google_conversion_action: ads?.google_conversion_action ?? "",
    adkit_project: ads?.adkit_project ?? "", microsoft_ads_account: ads?.microsoft_ads_account ?? "",
  };
}

type Group<K extends keyof BrandProfile> = NonNullable<BrandProfile[K]>;

/** Keys with a value, trimmed. A blank field is left out so the contract treats it as unset. */
function present<T extends string>(entries: Array<[T, string]>): Partial<Record<T, string>> {
  return Object.fromEntries(entries.map(([key, value]) => [key, value.trim()] as const).filter(([, value]) => value !== "")) as Partial<Record<T, string>>;
}

export const contactOf = (f: WizardForm): Group<"contact"> => present([["phone", f.phone], ["address", f.address], ["email", f.email]]);

export function disclosuresOf(f: WizardForm): Group<"disclosures"> {
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
  const states = f.unsupported_states.split(",").map((code) => code.trim()).filter(Boolean);
  const out: Group<"disclosures"> = {};
  const min = number(f.term_min), max = number(f.term_max), apr = number(f.apr_max);
  if (min !== undefined) out.term_min_months = min;
  if (max !== undefined) out.term_max_months = max;
  if (apr !== undefined) out.apr_max = apr;
  if (f.representative_example.trim()) out.representative_example = f.representative_example.trim();
  if (states.length > 0) out.unsupported_states = states as Group<"disclosures">["unsupported_states"];
  return out;
}

export const copyOf = (f: WizardForm): Group<"copy"> => present([["brand_name", f.brand_name], ["site_title", f.site_title], ["site_description", f.site_description], ["h1", f.h1], ["cta", f.cta], ["sub", f.sub]]);

export const adsOf = (f: WizardForm): Group<"ads"> => present([
  ["google_ads_account", f.google_ads_account], ["google_conversion_action", f.google_conversion_action],
  ["adkit_project", f.adkit_project], ["microsoft_ads_account", f.microsoft_ads_account],
]);

/** Form field behind each contract path. */
const FIELD_OF_PATH: Record<string, FieldKey> = {
  "contact.phone": "phone", "contact.address": "address", "contact.email": "email",
  "disclosures.term_min_months": "term_min", "disclosures.term_max_months": "term_max", "disclosures.apr_max": "apr_max",
  "disclosures.representative_example": "representative_example", "disclosures.unsupported_states": "unsupported_states",
  "copy.brand_name": "brand_name", "copy.site_title": "site_title", "copy.site_description": "site_description", "copy.h1": "h1", "copy.cta": "cta", "copy.sub": "sub",
  "ads.google_ads_account": "google_ads_account", "ads.google_conversion_action": "google_conversion_action", "ads.adkit_project": "adkit_project", "ads.microsoft_ads_account": "microsoft_ads_account",
};

/** Contract errors of one profile group, one message per form field. */
function profileErrors(profile: BrandProfile): FieldErrors {
  const errors: FieldErrors = {};
  const parsed = BrandProfile.safeParse(profile);
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const path = issue.path.slice(0, 2).join(".");
    const field = FIELD_OF_PATH[path];
    if (field && !errors[field]) errors[field] = describeIssue(field, issue);
  }
  return errors;
}

export interface ValidateContext {
  /** The draft exists: its domain is fixed and no longer validated. */
  hasDraft: boolean;
  canEditTracking: boolean;
  /** The approved templates the employee may pick. */
  templates: Array<{ template_version_id: string }>;
}

const REQUIRED_PRODUCT: FieldKey[] = ["term_min", "term_max", "apr_max", "representative_example", "unsupported_states"];
const REQUIRED_CONTACT: FieldKey[] = ["phone", "address", "email"];

export function validateStep(step: StepId, f: WizardForm, ctx: ValidateContext): FieldErrors {
  const errors: FieldErrors = {};
  const required = (fields: FieldKey[]) => { for (const key of fields) if (f[key].trim() === "") errors[key] = requiredText(key); };
  switch (step) {
    case "brand": {
      const name = BrandName.safeParse(f.name);
      if (f.name.trim() === "") errors.name = requiredText("name");
      else if (!name.success) errors.name = describeIssue("name", name.error.issues[0]!);
      if (!ctx.hasDraft) {
        const domain = DraftDomain.safeParse(f.domain);
        if (f.domain.trim() === "") errors.domain = requiredText("domain");
        else if (!domain.success) errors.domain = describeIssue("domain", domain.error.issues[0]!);
      }
      const keyword = BrandDraftKeyword.safeParse(f.keyword);
      if (f.keyword.trim() === "") errors.keyword = requiredText("keyword");
      else if (!keyword.success) errors.keyword = describeIssue("keyword", keyword.error.issues[0]!);
      required(REQUIRED_CONTACT);
      return { ...profileErrors({ contact: contactOf(f) }), ...errors };
    }
    case "product": {
      required(REQUIRED_PRODUCT);
      const numbers: Array<[FieldKey, string]> = [["term_min", f.term_min], ["term_max", f.term_max], ["apr_max", f.apr_max]];
      for (const [key, value] of numbers) if (value.trim() !== "" && !Number.isFinite(Number(value))) errors[key] = describeIssue(key, { code: "invalid_type", message: "Expected number" });
      return { ...profileErrors({ disclosures: disclosuresOf(f) }), ...errors };
    }
    case "template":
      if (!ctx.templates.some((t) => t.template_version_id === f.template_version_id)) errors.template_version_id = requiredText("template_version_id");
      return errors;
    case "copy":
      return profileErrors({ copy: copyOf(f) });
    case "tracking":
      return ctx.canEditTracking ? profileErrors({ ads: adsOf(f) }) : {};
    case "review":
      return STEPS.slice(0, 5).reduce<FieldErrors>((all, id) => ({ ...all, ...validateStep(id, f, ctx) }), {});
  }
}

/** Step index each field belongs to, so a review error can send the employee back to it. */
export function stepOfField(field: FieldKey): number {
  if (["name", "domain", "keyword", "phone", "address", "email"].includes(field)) return 0;
  if (["term_min", "term_max", "apr_max", "representative_example", "unsupported_states"].includes(field)) return 1;
  if (field === "template_version_id") return 2;
  if (["brand_name", "site_title", "site_description", "h1", "cta", "sub"].includes(field)) return 3;
  return 4;
}

/**
 * The step a saved draft resumes at: the first whose data the draft does not hold. A draft always holds a template,
 * so the Template step counts as done once the Copy group was saved. An employee who cannot set tracking ids
 * is never held at the Tracking step.
 */
export function firstIncompleteStep(profile: BrandProfile | undefined, opts: { canEditTracking: boolean }): number {
  const contact = profile?.contact;
  if (!contact?.phone || !contact.address || !contact.email) return 0;
  const d = profile?.disclosures;
  if (d?.term_min_months === undefined || d.term_max_months === undefined || d.apr_max === undefined || !d.representative_example || !d.unsupported_states?.length) return 1;
  if (!profile?.copy) return 2;
  if (opts.canEditTracking && !profile.ads) return 4;
  return 5;
}
