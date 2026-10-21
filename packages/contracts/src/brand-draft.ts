/**
 * What an employee can set on a brand draft before install: the brand profile (contact, disclosures,
 * site copy, ads routing) and the PATCH /api/brands/:id/draft contract. The profile is stored in the revision's
 * `config_json.profile`. It never holds tenant-owned runtime routing (amount buckets, form route).
 */
import { z } from "zod";
import { isBrandClean, BrandName } from "./common.js";
import { AdkitProject, GoogleAdsAccount, GoogleConversionAction } from "./admin-api.js";
import { cleanKeyword } from "./runtime-config.js";
import { SiteBrandName, SiteDescription, SiteTitle, siteTextValue } from "./site-text.js";
import { TEMPLATE_RULES } from "./template.js";
import { V1_UNSUPPORTED_STATES } from "./v1.js";

/** 50 states and DC. Uppercase only: a lowercase code is refused, not normalized. */
const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;
const UsStateCode = z.enum(US_STATE_CODES);

/** Free text a brand page may show: one line, no angle brackets, brand clean (AGENTS.md hard rule 4). */
function profileText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), "Use plain text without < or > characters")
    .refine(isBrandClean, "Contains a forbidden platform string");
}

const Contact = z.strictObject({
  phone: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9 ()+-]+$/, "Phone may only hold digits, spaces and + - ( )")
    .optional(),
  address: profileText(200).optional(),
  email: z.email().max(120).refine(isBrandClean, "Contains a forbidden platform string").optional(),
});

const TermMonths = z.number().int().min(1).max(120);

const Disclosures = z
  .strictObject({
    term_min_months: TermMonths.optional(),
    term_max_months: TermMonths.optional(),
    apr_max: z
      .number()
      .min(0)
      .max(999.99)
      .refine((value) => Number(value.toFixed(2)) === value, "apr_max allows at most 2 decimals")
      .optional(),
    representative_example: profileText(500)
      .refine((value) => !TEMPLATE_RULES.forbiddenWording.test(value), 'Do not use the words "personal loan"')
      .optional(),
    unsupported_states: z.array(UsStateCode).max(US_STATE_CODES.length).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.term_min_months !== undefined && value.term_max_months !== undefined && value.term_min_months > value.term_max_months) {
      ctx.addIssue({ code: "custom", path: ["term_min_months"], message: "term_min_months must not exceed term_max_months" });
    }
    const states = value.unsupported_states;
    if (!states) return;
    if (new Set(states).size !== states.length) {
      ctx.addIssue({ code: "custom", path: ["unsupported_states"], message: "unsupported_states must be unique" });
    }
    const missing = V1_UNSUPPORTED_STATES.filter((state) => !states.includes(state));
    if (missing.length > 0) {
      ctx.addIssue({ code: "custom", path: ["unsupported_states"], message: `unsupported_states must include ${missing.join(", ")}` });
    }
  });

const Ads = z.strictObject({
  google_ads_account: GoogleAdsAccount.optional(),
  google_conversion_action: GoogleConversionAction.optional(),
  adkit_project: AdkitProject.optional(),
  microsoft_ads_account: z.string().regex(/^\d{6,12}$/, "Invalid microsoft_ads_account").optional(),
});

/** Limits of the optional page copy that the site-text contract does not cover. */
export const COPY_LIMITS = { h1: 100, cta: 40, sub: 200 } as const;

/**
 * Page copy typed at draft time. brand_name, site_title and site_description are the runtime site-text
 * fields under the same names and validators. A missing key means the template default.
 * h1, cta and sub are optional extra copy for the copy step (and the copy assistant) to fill.
 */
const Copy = z.strictObject({
  brand_name: SiteBrandName.optional(),
  site_title: SiteTitle.optional(),
  site_description: SiteDescription.optional(),
  h1: siteTextValue(COPY_LIMITS.h1).optional(),
  cta: siteTextValue(COPY_LIMITS.cta).optional(),
  sub: siteTextValue(COPY_LIMITS.sub).optional(),
});

/** Every group is optional: a draft may carry any subset. */
export const BrandProfile = z.strictObject({
  contact: Contact.optional(),
  disclosures: Disclosures.optional(),
  copy: Copy.optional(),
  ads: Ads.optional(),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

/** The only profile defaults. The panel pre-fills them, a draft stores what the employee confirms. */
export const BRAND_PROFILE_DEFAULTS = {
  disclosures: {
    term_min_months: 3,
    term_max_months: 36,
    apr_max: 35.99,
    unsupported_states: [...V1_UNSUPPORTED_STATES],
  },
} satisfies BrandProfile;

const Id = z.string().min(1).max(128);

/** Draft keyword: normalized by cleanKeyword, refused when nothing is left. */
export const BrandDraftKeyword = z
  .string()
  .min(1)
  .max(60)
  .transform((value) => cleanKeyword(value) ?? "")
  .refine((value) => value.length > 0, "Keyword is empty after normalization");

/** PATCH /api/brands/:id/draft. A key that is absent stays as it is. `profile` replaces the whole stored profile. */
export const UpdateBrandDraftRequest = z.strictObject({
  name: BrandName.optional(),
  keyword_default: BrandDraftKeyword.optional(),
  template_version_id: Id.optional(),
  profile: BrandProfile.optional(),
});
export type UpdateBrandDraftRequest = z.infer<typeof UpdateBrandDraftRequest>;

export const UpdateBrandDraftResponse = z.strictObject({
  brand: z.strictObject({
    brand_id: z.string().min(1),
    name: z.string().min(1),
    domain: z.string().min(1),
    keyword_default: z.string().min(1).nullable(),
    status: z.enum(["draft", "failed"]),
  }),
  revision: z.strictObject({
    revision_id: Id,
    revision: z.number().int().positive(),
    template_version_id: Id,
    form_artifact_id: Id,
  }),
  profile: BrandProfile.optional(),
  /** Key names the call changed: name, keyword_default, template_version_id, profile.contact, profile.disclosures, profile.copy, profile.ads. */
  changed: z.array(z.string()),
});
export type UpdateBrandDraftResponse = z.infer<typeof UpdateBrandDraftResponse>;
