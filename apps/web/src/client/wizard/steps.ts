/**
 * Brand wizard model: the five steps, the form, per-step validation against the shared contracts, the profile
 * groups each step saves, and which step a saved draft resumes at. Pure functions, no React.
 * The wizard does not ask for term, APR or the other loan rules: each template carries its own disclosure text.
 */
import { BrandDraftKeyword, BrandName, BrandProfile, COPY_KEYWORD_MARKER, COPY_LIMITS, cleanKeyword, validateCopy, type CopyField } from "@anjuna/contracts";
import { DraftDomain, type WizardDraft } from "../../shared/wizard";
import { describeCopyIssue, describeIssue, requiredText } from "./messages";

export const STEPS = ["brand", "template", "copy", "tracking", "review"] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABEL: Record<StepId, string> = {
  brand: "ข้อมูลแบรนด์",
  template: "เทมเพลต",
  copy: "ข้อความ",
  tracking: "ติดตามผล",
  review: "ตรวจและสร้าง",
};

export interface WizardForm {
  name: string;
  domain: string;
  keyword: string;
  phone: string;
  address: string;
  email: string;
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
  /** Not shown: it moved to the global settings. A value an older draft holds is carried so a save keeps it. */
  microsoft_ads_account: string;
}
export type FieldKey = keyof WizardForm;
export type FieldErrors = Partial<Record<FieldKey, string>>;

/** A blank form. */
export function emptyForm(): WizardForm {
  return {
    name: "", domain: "", keyword: "", phone: "", address: "", email: "",
    template_version_id: "", brand_name: "", site_title: "", site_description: "", h1: "", cta: "", sub: "",
    google_ads_account: "", google_conversion_action: "", adkit_project: "", microsoft_ads_account: "",
  };
}

/**
 * The form a saved draft resumes with. A group the draft does not hold stays blank. Disclosures saved by an older draft are
 * not shown or edited: a save keeps them as they are (BrandWizard.save spreads the stored profile).
 */
export function formFromDraft(draft: WizardDraft): WizardForm {
  const form = emptyForm();
  const { contact, copy, ads } = draft.profile ?? {};
  return {
    ...form,
    name: draft.brand.name, domain: draft.brand.domain, keyword: draft.brand.keyword_default ?? "",
    phone: contact?.phone ?? "", address: contact?.address ?? "", email: contact?.email ?? "",
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

export const copyOf = (f: WizardForm): Group<"copy"> => present([["brand_name", f.brand_name], ["site_title", f.site_title], ["site_description", f.site_description], ["h1", f.h1], ["cta", f.cta], ["sub", f.sub]]);

export const adsOf = (f: WizardForm): Group<"ads"> => present([
  ["google_ads_account", f.google_ads_account], ["google_conversion_action", f.google_conversion_action],
  ["adkit_project", f.adkit_project], ["microsoft_ads_account", f.microsoft_ads_account],
]);

/** Form field behind each contract path. */
const FIELD_OF_PATH: Record<string, FieldKey> = {
  "contact.phone": "phone", "contact.address": "address", "contact.email": "email",
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

const COPY_FIELD_NAMES = Object.keys(COPY_LIMITS) as CopyField[];

/** What the h1's {{keyword}} marker becomes on the page: the site name (the install's brand_name, else the brand name), else the keyword. */
const slotTextOf = (f: WizardForm): string => f.brand_name.trim() || f.name.trim() || (cleanKeyword(f.keyword) ?? "");

/**
 * The page copy rules (validateCopy, the same check the install runs) for the h1, cta and sub the employee filled in.
 * An empty field is allowed: it is filled at Generate. A field with several findings shows them together.
 */
export function copyFieldErrors(f: WizardForm): FieldErrors {
  const errors: FieldErrors = {};
  const messages: Partial<Record<CopyField, string[]>> = {};
  const issues = validateCopy({ h1: f.h1, cta: f.cta, sub: f.sub }, cleanKeyword(f.keyword) ?? "", slotTextOf(f));
  for (const issue of issues) {
    if (issue.field === "keyword_default" || issue.field === "adapter" || issue.code === "required" || f[issue.field].trim() === "") continue;
    (messages[issue.field] ??= []).push(describeCopyIssue(issue.field, issue));
  }
  for (const field of COPY_FIELD_NAMES) if (messages[field]) errors[field] = messages[field]!.join(" · ");
  return errors;
}

/** Characters a visitor sees: the h1's {{keyword}} marker counts as the site name it becomes. */
export function visibleCopyLength(f: WizardForm, field: CopyField): number {
  const value = f[field].trim();
  return field === "h1" ? value.replaceAll(COPY_KEYWORD_MARKER, slotTextOf(f)).length : value.length;
}

export interface ValidateContext {
  /** The draft exists: its domain is fixed and no longer validated. */
  hasDraft: boolean;
  canEditTracking: boolean;
  /** The approved templates the employee may pick. */
  templates: Array<{ template_version_id: string }>;
}

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
    case "template":
      if (!ctx.templates.some((t) => t.template_version_id === f.template_version_id)) errors.template_version_id = requiredText("template_version_id");
      return errors;
    case "copy":
      return { ...profileErrors({ copy: copyOf(f) }), ...copyFieldErrors(f) };
    case "tracking":
      return ctx.canEditTracking ? profileErrors({ ads: adsOf(f) }) : {};
    case "review":
      return STEPS.slice(0, -1).reduce<FieldErrors>((all, id) => ({ ...all, ...validateStep(id, f, ctx) }), {});
  }
}

const indexOfStep = (id: StepId): number => STEPS.indexOf(id);

/** Step index each field belongs to, so a review error can send the employee back to it. */
export function stepOfField(field: FieldKey): number {
  if (["name", "domain", "keyword", "phone", "address", "email"].includes(field)) return indexOfStep("brand");
  if (field === "template_version_id") return indexOfStep("template");
  if (["brand_name", "site_title", "site_description", "h1", "cta", "sub"].includes(field)) return indexOfStep("copy");
  return indexOfStep("tracking");
}

/**
 * The step a saved draft resumes at: the first whose data the draft does not hold. A draft always holds a template,
 * so the Template step counts as done once the Copy group was saved. An employee who cannot set tracking ids
 * is never held at the Tracking step.
 */
export function firstIncompleteStep(profile: BrandProfile | undefined, opts: { canEditTracking: boolean }): number {
  const contact = profile?.contact;
  if (!contact?.phone || !contact.address || !contact.email) return indexOfStep("brand");
  if (!profile?.copy) return indexOfStep("template");
  if (opts.canEditTracking && !profile.ads) return indexOfStep("tracking");
  return indexOfStep("review");
}
