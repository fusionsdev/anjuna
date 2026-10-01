/**
 * The lead payload the form POSTs to the brand's same-origin `/api/leads` (V1 shape).
 *
 * Built by `aurum-form/src/App.tsx` handleSubmit (`8ba11d3`) and read by V1
 * `functions/api/[[path]].ts` validateLeadPayload (`8404ec2`). The brand Worker forwards it
 * unchanged inside LeadsRpc `submitLead`.
 *
 * This schema checks shape and the variant-independent invariants only. The full V1
 * validation rules (name charset, age, payday window, state gate, consent versions, ...)
 * belong to core (T6, CO-1) because some depend on env (FORM_VERSION, CONSENT_VERSION, ...).
 */
import { z } from "zod";
import { V1_UUID_LIKE } from "./v1.js";

/** `aurum-form` TRACKING_KEYS: the only keys the form copies into `tracking`. */
export const FORM_TRACKING_KEYS = [
  "clickid", "click_id", "gclid", "gbraid", "wbraid", "msclkid", "fbclid",
  "ref_id",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "campaign_id", "adgroup_id", "ad_id", "keyword",
  "sub1", "sub2", "sub3", "sub4", "sub5",
] as const;

/**
 * V1 server TRACKING_KEYS: the keys validateLeadPayload keeps. Same as the form's list minus
 * `ref_id` (V1 core drops it; the postback still falls back to `tracking.ref_id` for msclkid).
 */
export const V1_SERVER_TRACKING_KEYS = FORM_TRACKING_KEYS.filter((k) => k !== "ref_id");

/**
 * LeadsGate prepop GET-param names (V1 BUYER_FIELDS). The form's `lead` object uses exactly
 * these keys, and V1 buildUserRedirect copies the non-empty ones onto the prepop URL.
 */
export const BUYER_FIELDS = [
  "requested_amount", "loan_purpose", "first_name", "last_name", "birth_date",
  "email", "home_phone", "work_phone", "address", "city", "state", "zip",
  "address_length_months", "own_home", "income_type", "employer", "job_title",
  "employed_months", "pay_date1", "pay_frequency", "direct_deposit", "monthly_income",
] as const;
export type BuyerField = (typeof BUYER_FIELDS)[number];

/** `form_variant` values the V1 form emits (experiment.ts VARIANTS). */
export const V1_FORM_VARIANTS = { FULL: "aurum-14-step", LITE: "lite_v1" } as const;

const uuidLike = z.string().regex(V1_UUID_LIKE, "Invalid identifiers");
const text = z.string();

/**
 * The `lead` object. The form always sends all 22 keys as strings; on `lite_v1` the fields it
 * does not ask are "" (V1 treats "" on lite as "not asked"). `zip` is never optional on any
 * variant: it is the state-screening gate.
 */
export const FormLeadFields = z.strictObject({
  requested_amount: z.string().regex(/^\d+(\.\d+)?$/, "Invalid requested amount"),
  loan_purpose: text,
  first_name: text,
  last_name: text,
  birth_date: text,
  email: text,
  home_phone: text,
  work_phone: text,
  address: text,
  city: text,
  state: text,
  zip: z.string().regex(/^\d{5}$/, "Invalid ZIP code"),
  address_length_months: text,
  own_home: text,
  income_type: text,
  employer: text,
  job_title: text,
  employed_months: text,
  pay_date1: text,
  pay_frequency: text,
  direct_deposit: text,
  monthly_income: text,
});
export type FormLeadFields = z.infer<typeof FormLeadFields>;

/**
 * `site` as the form sends it. Client-supplied and therefore untrusted: in Anjuna the brand
 * Worker sets `brand_id` and `hostname` on the RPC envelope (BR-7) and core must use those.
 */
export const FormSite = z.strictObject({
  site_id: text,
  brand: text,
  hostname: text,
});

export const FormConsent = z.strictObject({
  application_consent: z.literal(true),
  consent_version: text,
  partner_list_version: text,
  accepted_at: text,
  page_url: text,
});
export type FormConsent = z.infer<typeof FormConsent>;

export const FormTracking = z.partialRecord(z.enum(FORM_TRACKING_KEYS), z.string());
export type FormTracking = z.infer<typeof FormTracking>;

export const FormMetadata = z.strictObject({
  landing_page_url: text,
  referrer: text,
  hostname: text,
  submitted_at: text,
});

/** Full V1 form submit body. */
export const FormLeadPayload = z.strictObject({
  lead_id: uuidLike,
  session_id: uuidLike,
  form_version: text,
  form_variant: text,
  site: FormSite,
  lead: FormLeadFields,
  consent: FormConsent,
  tracking: FormTracking,
  metadata: FormMetadata,
});
export type FormLeadPayload = z.infer<typeof FormLeadPayload>;

/** Status values V1 `/api/leads` returns (LeadStatus). */
export const LeadStatus = z.enum(["accepted", "duplicate", "invalid", "error"]);
export type LeadStatus = z.infer<typeof LeadStatus>;

/**
 * Success body of the brand's `/api/leads` (BR-7). V1 returns `{status, lead_id, reference,
 * redirect_url}` (201 accepted, 200 duplicate); the form reads `status`, `lead_id`,
 * `reference` and `redirect_url`. In Anjuna `redirect_url` is `<formRoute>/provider?c=<token>`.
 */
export const BrandLeadAccepted = z.strictObject({
  status: z.enum(["accepted", "duplicate"]),
  lead_id: z.string().min(1),
  reference: z.string().optional(),
  redirect_url: z.string().min(1),
});
export type BrandLeadAccepted = z.infer<typeof BrandLeadAccepted>;

/** Error body V1 uses everywhere: `{status:"invalid"|"error", message}`. The form shows `message`. */
export const LeadError = z.strictObject({
  status: z.enum(["invalid", "error"]),
  message: z.string(),
});
export type LeadError = z.infer<typeof LeadError>;

export const BrandLeadResponse = z.union([BrandLeadAccepted, LeadError]);
export type BrandLeadResponse = z.infer<typeof BrandLeadResponse>;

/** V1 `GET /api/zip?zip=` responses (handleZipLookup). Same body on the brand domain. */
export const ZipFound = z.strictObject({
  found: z.literal(true),
  zip: z.string().regex(/^\d{5}$/),
  city: z.string(),
  state: z.string(),
});
export const ZipNotFound = z.strictObject({ found: z.literal(false) });
export const ZipResponse = z.union([ZipFound, ZipNotFound]);
export type ZipResponse = z.infer<typeof ZipResponse>;
