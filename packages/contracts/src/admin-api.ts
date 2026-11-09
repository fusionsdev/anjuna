/**
 * Core admin API (T12-0, FUS-353): what the control panel (T12a) calls and core (T6) serves.
 *
 * The panel Worker reaches core over a Service Binding (plan decision 1) and never binds the
 * `leads` D1 (ADR-0001). Every request carries the acting user's id and role in
 * ADMIN_CONTEXT_HEADERS; the panel sets them from its better-auth session, never from the
 * browser. Core is the enforcement point: it checks the role with `authorize()` against
 * ADMIN_ROLE_TABLE. Core binds the `factory` D1 in addition to `leads` and writes the
 * `audit_log` row itself right after each successful brand/config change. The panel writes
 * audit rows only for panel-only actions such as user management.
 *
 * Check order core applies (and the mock core in T12a copies):
 *   1. context headers missing or invalid      -> 401 unauthorized
 *   2. endpoint below the actor's role          -> 403 forbidden_role
 *   3. body / query invalid                     -> 422 invalid
 *   4. PATCH field group above the actor's role -> 403 forbidden_role (lists denied_fields)
 *   5. brand or lead does not exist             -> 404 not_found
 *   6. PATCH `expected_updated_at` is stale     -> 409 conflict
 *
 * No secret ever leaves core: the postback token is shown only as "set" / "not_set" (never a
 * value or a hash), and the one exception is the freshly rotated token returned once in the
 * PATCH response so the owner can paste it into LeadsGate.
 *
 * Out of scope: rollback / install / upgrade (factory Workflows, T10).
 */
import { TrafficBreakdownQuery, TrafficBreakdownResponse } from "./traffic.js";
import { z } from "zod";
import { AdkitProject, BrandId, GoogleAdsAccount, GoogleConversionAction, Hostname, ExperimentId, OpaqueToken, VariantId } from "./common.js";
import { ConversionSetupStateResponse } from "./conversion-setup.js";
import {
  AdkitDirectoryResponse, AdkitJobCreateRequest, AdkitJobCreateResponse, CampaignJobCreateRequest, PanelCampaignsResponse,
} from "./adkit.js";
import { Keyword } from "./runtime-config.js";
import { SiteBrandName, SiteDescription, SiteTitle } from "./site-text.js";
import { BrandTheme } from "./theme.js";
import { TrafficRiskExportQuery, TrafficRiskExportResponse, TrafficRiskQuery, TrafficRiskResponse } from "./traffic-risk.js";
import { REQUESTED_AMOUNT_RANGE } from "./v1.js";
import {
  AdAllocationAssignRequest, AdAllocationAssignResponse, AdAllocationQuery, AdAllocationResponse,
  SpendCurrency, SpendPeriod, SpendQuery, SpendReportResponse, SpendRowsQuery, SpendRowsResponse,
} from "./spend.js";
import { CONVERSIONS_MAX_LIMIT, CONVERSION_STATUSES, ConversionReasonCode, ConversionStatus } from "./conversions.js";
import { ClientErrorsQuery, ClientErrorsResponse, TrafficReportQuery, TrafficReportResponse } from "./traffic-log.js"; // spec traffic

// --- roles and request context ------------------------------------------------------------------

/** better-auth roles (plan: `defaultRole: "employee"`, `adminRoles: ["owner"]`). */
export const ADMIN_ROLES = ["employee", "owner"] as const;
export const AdminRole = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof AdminRole>;

/** Owner outranks employee. */
const ROLE_RANK: Record<AdminRole, number> = { employee: 1, owner: 2 };

/** True when `role` meets `min`. */
export function roleAtLeast(role: AdminRole, min: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Request id: the panel mints one per call; core echoes it in errors and logs. */
export const RequestId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Invalid request_id");

/** Who is acting. Set by the panel Worker from its session; never taken from the browser. */
export const AdminRequestContext = z.strictObject({
  /** better-auth user id. Written to `audit_log.actor_id`. */
  actor_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "Invalid actor_id"),
  actor_role: AdminRole,
  request_id: RequestId,
});
export type AdminRequestContext = z.infer<typeof AdminRequestContext>;

/** Headers that carry AdminRequestContext over the Service Binding. */
export const ADMIN_CONTEXT_HEADERS = {
  actor_id: "x-actor-id",
  actor_role: "x-actor-role",
  request_id: "x-request-id",
} as const;

/** Read the context from request headers. Returns null (-> 401) when anything is missing or bad. */
export function adminContextFromHeaders(headers: { get(name: string): string | null }): AdminRequestContext | null {
  const r = AdminRequestContext.safeParse({
    actor_id: headers.get(ADMIN_CONTEXT_HEADERS.actor_id) ?? undefined,
    actor_role: headers.get(ADMIN_CONTEXT_HEADERS.actor_role) ?? undefined,
    request_id: headers.get(ADMIN_CONTEXT_HEADERS.request_id) ?? undefined,
  });
  return r.success ? r.data : null;
}

/** The inverse, for the panel Worker. */
export function adminContextToHeaders(ctx: AdminRequestContext): Record<string, string> {
  const c = AdminRequestContext.parse(ctx);
  return {
    [ADMIN_CONTEXT_HEADERS.actor_id]: c.actor_id,
    [ADMIN_CONTEXT_HEADERS.actor_role]: c.actor_role,
    [ADMIN_CONTEXT_HEADERS.request_id]: c.request_id,
  };
}

// --- shared brand fields -------------------------------------------------------------------------

/** `brand_runtime.paused` as the panel shows it. */
export const BrandStatus = z.enum(["live", "paused"]);
export type BrandStatus = z.infer<typeof BrandStatus>;

/** `brand_runtime.flow_gate_mode` (BR-2 / BR-3). */
export const FlowGateMode = z.enum(["param", "signed_cookie"]);
export type FlowGateMode = z.infer<typeof FlowGateMode>;

/** One A/B arm. `id` is the same lowercase slug (e.g. `lite_v1`, `full_v1`) written on clicks and leads. */
export const AbVariant = z.strictObject({
  id: VariantId,
  weight: z.number().int().min(0).max(100),
});
export type AbVariant = z.infer<typeof AbVariant>;

/** `brand_runtime.ab_config_json` (BR-9). Weights are whole-number percentages and must sum to 100. */
export const AbConfig = z
  .strictObject({
    experiment_id: ExperimentId,
    variants: z.array(AbVariant).min(2).max(8),
  })
  .refine((c) => c.variants.reduce((s, v) => s + v.weight, 0) === 100, "A/B weights must sum to 100")
  .refine((c) => new Set(c.variants.map((v) => v.id)).size === c.variants.length, "A/B variant ids must be unique");
export type AbConfig = z.infer<typeof AbConfig>;

/** `brand_runtime.amount_buckets` (BR-2): unique, ascending, within the V1 range. */
export const AmountBuckets = z
  .array(z.number().int().min(REQUESTED_AMOUNT_RANGE.min).max(REQUESTED_AMOUNT_RANGE.max))
  .min(1)
  .max(32)
  .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), "Amount buckets must be unique and ascending");

/**
 * Form bundle version a brand serves (`form@<sha>`, FO-4). Nullable in brand responses for now;
 * filled from `brand_runtime.form_version` once the install Workflow (T10) adds and writes it.
 */
export const FormVersion = z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/, "Invalid form version");

/** The only thing anyone outside core ever learns about the postback token. */
export const PostbackTokenState = z.enum(["set", "not_set", "global"]);
export type PostbackTokenState = z.infer<typeof PostbackTokenState>;

/** LeadsGate affiliate id. */
export const LeadsGateAid = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Invalid aid");

/** LeadsGate prepop form: HTTPS URL or same-origin path, without query/fragment (core appends params). */
export const PrepopBase = z
  .string()
  .max(512)
  .pipe(z.union([z.url({ protocol: /^https$/ }), z.string().regex(/^\/(?!\/)[^\\\s?#]*$/)]))
  .refine((u) => !u.includes("?") && !u.includes("#"), "prepop_base must not carry a query or fragment");

/** Key in the drain's BRAND_ROUTING_JSON. An identifier, not a credential. */
export const DrainKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid drain_key");

// GoogleAdsAccount, GoogleConversionAction and AdkitProject live in common.ts (conversion-setup.ts needs them
// without importing this file); re-exported here so existing imports keep working.
export { AdkitProject, GoogleAdsAccount, GoogleConversionAction };

const Day = z.iso.date();
const Timestamp = z.iso.datetime();
const Count = z.number().int().min(0);

// --- GET /admin/brands ---------------------------------------------------------------------------

/** Leads created in the last 7 days, by buyer outcome. */
export const BrandStats7d = z
  .strictObject({
    leads: Count,
    sold: Count,
    pending: Count,
  })
  .refine((s) => s.sold + s.pending <= s.leads, "sold + pending cannot exceed leads");

export const BrandSummary = z.strictObject({
  brand_id: BrandId,
  hostnames: z.array(Hostname).min(1),
  status: BrandStatus,
  flow_gate_mode: FlowGateMode,
  /** Null = no A/B test running. */
  ab_config: AbConfig.nullable(),
  form_version: FormVersion.nullable(),
  stats_7d: BrandStats7d,
});
export type BrandSummary = z.infer<typeof BrandSummary>;

export const ListBrandsResponse = z.strictObject({
  brands: z.array(BrandSummary),
  generated_at: Timestamp,
});
export type ListBrandsResponse = z.infer<typeof ListBrandsResponse>;

// --- GET /admin/brands/:id -----------------------------------------------------------------------

/**
 * The full editable config of one `brand_runtime` row. Strict: `postback_token_hash` (or any
 * other unlisted column) fails validation, so it cannot leak by accident.
 */
export const BrandConfig = z.strictObject({
  brand_id: BrandId,
  account: z.string().min(1).max(64),
  hostnames: z.array(Hostname).min(1),
  status: BrandStatus,
  form_version: FormVersion.nullable(),
  keyword_default: Keyword.nullable(),
  /** Site text edited in the control panel. Null = the template default. */
  brand_name: SiteBrandName.nullable(),
  site_title: SiteTitle.nullable(),
  site_description: SiteDescription.nullable(),
  /** The brand's two colors (FUS-381). Null = the template colors. */
  theme: BrandTheme.nullable(),
  amount_buckets: AmountBuckets,
  ab_config: AbConfig.nullable(),
  flow_gate_mode: FlowGateMode,
  aid: LeadsGateAid,
  prepop_base: PrepopBase,
  drain_key: DrainKey,
  /** Drain route served by GET /api/conversions/routing. Null = not set; the drain skips the brand. */
  google_ads_account: GoogleAdsAccount.nullable(),
  google_conversion_action: GoogleConversionAction.nullable(),
  adkit_project: AdkitProject.nullable(),
  postback_token: PostbackTokenState,
  created_at: Timestamp,
  /** Pass back as `expected_updated_at` on PATCH for optimistic concurrency (409 when stale). */
  updated_at: Timestamp,
});
export type BrandConfig = z.infer<typeof BrandConfig>;

export const GetBrandResponse = z.strictObject({ brand: BrandConfig });
export type GetBrandResponse = z.infer<typeof GetBrandResponse>;

// --- PATCH /admin/brands/:id ---------------------------------------------------------------------

/** Editable fields. `rotate_postback_token: true` asks core to mint a new token. */
export const BRAND_PATCH_FIELDS = [
  "keyword_default",
  "brand_name",
  "site_title",
  "site_description",
  "amount_buckets",
  "ab_config",
  "flow_gate_mode",
  "aid",
  "prepop_base",
  "drain_key",
  "google_ads_account",
  "google_conversion_action",
  "adkit_project",
  "rotate_postback_token",
  "theme",
] as const;
export type BrandPatchField = (typeof BRAND_PATCH_FIELDS)[number];

export const BrandPatchRequest = z
  .strictObject({
    /** Null clears it (the template keeps its own default text). */
    keyword_default: Keyword.nullable().optional(),
    /** Null resets the field to the template default. */
    brand_name: SiteBrandName.nullable().optional(),
    site_title: SiteTitle.nullable().optional(),
    site_description: SiteDescription.nullable().optional(),
    amount_buckets: AmountBuckets.optional(),
    /** Null stops the test. */
    ab_config: AbConfig.nullable().optional(),
    flow_gate_mode: FlowGateMode.optional(),
    aid: LeadsGateAid.optional(),
    prepop_base: PrepopBase.optional(),
    drain_key: DrainKey.optional(),
    /** Null clears the drain route field. */
    google_ads_account: GoogleAdsAccount.nullable().optional(),
    google_conversion_action: GoogleConversionAction.nullable().optional(),
    adkit_project: AdkitProject.nullable().optional(),
    rotate_postback_token: z.literal(true).optional(),
    /** Null resets the brand to the template colors. */
    theme: BrandTheme.nullable().optional(),
    /** `BrandConfig.updated_at` the editor loaded. Stale -> 409 conflict. */
    expected_updated_at: Timestamp.optional(),
  })
  .refine((p) => BRAND_PATCH_FIELDS.some((f) => p[f] !== undefined), "Patch changes nothing");
export type BrandPatchRequest = z.infer<typeof BrandPatchRequest>;

export const BrandPatchResponse = z.strictObject({
  brand: BrandConfig,
  /** Fields whose value actually changed (empty when the patch was a no-op). */
  changed: z.array(z.enum(BRAND_PATCH_FIELDS)),
  /** `audit_log.id` of the row core wrote; null when nothing changed. */
  audit_id: z.number().int().positive().nullable(),
  /**
   * Core generates a strong random postback token, returned only in the PATCH response to
   * `rotate_postback_token: true`.
   * Shown once so the owner can update the LeadsGate postback URL; core stores only its hash
   * and never returns it again.
   */
  issued_postback_token: OpaqueToken.optional(),
});
export type BrandPatchResponse = z.infer<typeof BrandPatchResponse>;

// --- POST /admin/brands/:id/pause | /resume ------------------------------------------------------

export const BrandStatusChangeRequest = z.strictObject({
  /** Free-text note for the audit log. */
  reason: z.string().max(280).optional(),
});
export type BrandStatusChangeRequest = z.infer<typeof BrandStatusChangeRequest>;

/** Idempotent: pausing a paused brand answers 200 with `changed: false` and writes no audit row. */
export const BrandStatusChangeResponse = z
  .strictObject({
    brand_id: BrandId,
    status: BrandStatus,
    changed: z.boolean(),
    audit_id: z.number().int().positive().nullable(),
  })
  .refine((r) => r.changed === (r.audit_id !== null), "audit_id is set exactly when the status changed");
export type BrandStatusChangeResponse = z.infer<typeof BrandStatusChangeResponse>;

// --- GET /admin/leads/aggregates -----------------------------------------------------------------

/** Buyer outcome of a lead, derived from `leads.status`. */
export const LEAD_OUTCOMES = ["pending", "sold", "rejected"] as const;
export const LeadOutcome = z.enum(LEAD_OUTCOMES);
export type LeadOutcome = z.infer<typeof LeadOutcome>;

/**
 * `leads.status` -> outcome. V1 inserts `accepted`; the postback handler then writes the
 * LeadsGate type (`newLead`, `soldLead`, `rejectLead`) and never moves a sold lead back.
 */
export function leadOutcome(status: string): LeadOutcome {
  if (status === "soldLead") return "sold";
  if (status === "rejectLead") return "rejected";
  return "pending";
}

/** Longest window one aggregates call may ask for, in days (inclusive). */
export const LEAD_AGGREGATES_MAX_DAYS = 93;

/** Query string. Days are UTC calendar days, inclusive. */
export const LeadAggregatesQuery = z
  .strictObject({
    from: Day,
    to: Day,
    brand_id: BrandId.optional(),
  })
  .refine((q) => q.from <= q.to, "from must not be after to")
  .refine(
    (q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1 <= LEAD_AGGREGATES_MAX_DAYS,
    `Window is longer than ${LEAD_AGGREGATES_MAX_DAYS} days`,
  );
export type LeadAggregatesQuery = z.infer<typeof LeadAggregatesQuery>;

/** One cell of brand x day x outcome. Counts only: no lead id, no applicant field. */
export const LeadAggregateRow = z.strictObject({
  brand_id: BrandId,
  day: Day,
  status: LeadOutcome,
  count: Count,
});
export type LeadAggregateRow = z.infer<typeof LeadAggregateRow>;

export const LeadAggregatesResponse = z.strictObject({
  from: Day,
  to: Day,
  timezone: z.literal("UTC"),
  /** Zero cells are omitted. */
  rows: z.array(LeadAggregateRow),
});
export type LeadAggregatesResponse = z.infer<typeof LeadAggregatesResponse>;

// --- GET /admin/leads/:lead_id (PII fields owner-only, redacted by core) -------------------------

export const LeadId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Invalid lead_id");

/** Applicant fields as `leads` stores them (V1 columns). This is PII. */
export const LeadApplicant = z.strictObject({
  first_name: z.string(),
  last_name: z.string(),
  birth_date: z.string(),
  email: z.string(),
  home_phone: z.string(),
  work_phone: z.string().nullable(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  address_length_months: z.number().int(),
  own_home: z.boolean(),
  income_type: z.string(),
  employer: z.string(),
  job_title: z.string(),
  employed_months: z.number().int(),
  pay_date1: z.string(),
  pay_frequency: z.string(),
  direct_deposit: z.boolean(),
  monthly_income: z.number().int(),
});
export type LeadApplicant = z.infer<typeof LeadApplicant>;

// spec leads (declared here because LeadDetail below needs both before the main block)
/** Eligibility fields that identify nobody on their own. Both roles receive them. */
export const LeadProfile = LeadApplicant.pick({
  state: true,
  address_length_months: true,
  own_home: true,
  income_type: true,
  employer: true,
  job_title: true,
  employed_months: true,
  pay_date1: true,
  pay_frequency: true,
  direct_deposit: true,
  monthly_income: true,
});
export type LeadProfile = z.infer<typeof LeadProfile>;

/** Which click id the conversion upload carries. Never the id itself. */
export const LEAD_CLICK_TYPES = ["gclid", "gbraid", "wbraid", "msclkid", "none"] as const;

/** One `conversion_uploads` row as lead detail shows it. `value` and `last_error` are owner-only. */
export const LeadConversion = z.strictObject({
  status: z.enum(["pending", "processing", "uploaded", "dead"]),
  click_type: z.enum(LEAD_CLICK_TYPES),
  currency: z.string().length(3),
  occurred_at: Timestamp,
  attempts: Count,
  next_attempt_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp.nullable(),
  value: z.number().min(0).nullable(),
  last_error: z.string().max(300).nullable(),
});
export type LeadConversion = z.infer<typeof LeadConversion>;

export const LeadPostbackEvent = z.strictObject({
  event_type: z.string().max(32),
  /** Null for any role other than owner. */
  payout: z.number().min(0).nullable(),
  created_at: Timestamp,
});

export const LeadDetail = z.strictObject({
  lead_id: LeadId,
  brand_id: BrandId,
  hostname: Hostname,
  /** Raw `leads.status`. */
  status: z.string().max(32),
  outcome: LeadOutcome,
  form_version: z.string().max(64),
  form_variant: z.string().max(64),
  experiment_id: ExperimentId.nullable(),
  variant: VariantId.nullable(),
  keyword: z.string().max(60).nullable(),
  requested_amount: z.number().int().positive(),
  loan_purpose: z.string(),
  /** Null unless the caller is the owner. */
  applicant: LeadApplicant.nullable(),
  profile: LeadProfile,
  postbacks: z.array(LeadPostbackEvent),
  /** Null when no `conversion_uploads` row exists. */
  conversion: LeadConversion.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp.nullable(),
});
export type LeadDetail = z.infer<typeof LeadDetail>;

export const GetLeadResponse = z.strictObject({ lead: LeadDetail });
export type GetLeadResponse = z.infer<typeof GetLeadResponse>;

// spec leads
// --- GET /admin/leads, GET /admin/leads/export, GET /admin/suppressions (FUS-376) ----------------

/**
 * Shared lead filter. `q` matches `lead_id` by prefix or `click_id` exactly and never an email or
 * a phone number. No refinement here so `.extend()` stays legal; the window rules sit on each
 * query below. With both days absent core uses the last 30 days.
 */
export const LeadFilter = z.strictObject({
  brand: BrandId.optional(),
  from: Day.optional(),
  to: Day.optional(),
  status: LeadOutcome.optional(),
  q: z.string().regex(/^[A-Za-z0-9-]{4,64}$/).optional(),
});
export type LeadFilter = z.infer<typeof LeadFilter>;

type LeadWindow = { from?: string | undefined; to?: string | undefined };
const leadWindowOrdered = (q: LeadWindow) => q.from === undefined || q.to === undefined || q.from <= q.to;
const leadWindowShort = (q: LeadWindow) =>
  q.from === undefined || q.to === undefined || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1 <= LEAD_AGGREGATES_MAX_DAYS;

/** Opaque to the contract; the shape (`base64url(created_at|lead_id)`) is core's. */
export const LeadCursor = z.string().regex(/^[A-Za-z0-9_-]{1,344}$/);

/** What a decoded lead cursor must hold: the same `created_at` and `lead_id` shapes a list row has. */
export const LeadCursorKey = z.strictObject({ created_at: Timestamp, lead_id: LeadId });
export type LeadCursorKey = z.infer<typeof LeadCursorKey>;

export const LeadsQuery = LeadFilter.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: LeadCursor.optional(),
})
  .refine(leadWindowOrdered, "from must not be after to")
  .refine(leadWindowShort, `Window is longer than ${LEAD_AGGREGATES_MAX_DAYS} days`);
export type LeadsQuery = z.infer<typeof LeadsQuery>;

/** No PII for any role, so the bytes are the same for an employee and an owner. */
export const LeadListRow = z.strictObject({
  lead_id: LeadId,
  /** Not `BrandId`: old `leads.brand` values predate the pattern. */
  brand: z.string().min(1),
  hostname: Hostname,
  status: z.string().max(32),
  outcome: LeadOutcome,
  requested_amount: z.number().int().positive(),
  loan_purpose: z.string(),
  /** Two letters, or "" when the form posted no state (V1 accepts an empty `state`). */
  state: z.union([z.string().length(2), z.literal("")]),
  keyword: z.string().max(60).nullable(),
  variant: VariantId.nullable(),
  form_variant: z.string().max(64),
  has_conversion: z.boolean(),
  postback_count: Count,
  created_at: Timestamp,
});
export type LeadListRow = z.infer<typeof LeadListRow>;

export const LeadsResponse = z.strictObject({
  rows: z.array(LeadListRow),
  next_cursor: z.string().nullable(),
});
export type LeadsResponse = z.infer<typeof LeadsResponse>;

export const LEAD_EXPORT_LIMIT = 5_000;

export const LeadExportQuery = LeadFilter.extend({
  pii: z.enum(["0", "1"]).default("0"),
  limit: z.coerce.number().int().min(1).max(LEAD_EXPORT_LIMIT).default(LEAD_EXPORT_LIMIT),
})
  .refine(leadWindowOrdered, "from must not be after to")
  .refine(leadWindowShort, `Window is longer than ${LEAD_AGGREGATES_MAX_DAYS} days`);
export type LeadExportQuery = z.infer<typeof LeadExportQuery>;

/**
 * One schema for both column sets: the PII fields are present only when `pii` is true. The row
 * never carries `click_id` or any click id value.
 */
export const LeadExportRow = LeadListRow.extend(
  LeadApplicant.omit({ state: true }).partial().shape,
);
export type LeadExportRow = z.infer<typeof LeadExportRow>;

/** CSV column order without PII. */
export const LEAD_EXPORT_COLUMNS = [
  "lead_id", "brand", "hostname", "status", "outcome", "requested_amount", "loan_purpose",
  "state", "keyword", "variant", "form_variant", "has_conversion", "postback_count", "created_at",
] as const satisfies readonly (keyof LeadExportRow)[];

/** CSV column order with PII: `LEAD_EXPORT_COLUMNS` first, then the nine PII fields and the profile fields. */
export const LEAD_EXPORT_PII_COLUMNS = [
  ...LEAD_EXPORT_COLUMNS,
  "first_name", "last_name", "birth_date", "email", "home_phone", "work_phone", "address", "city", "zip",
  "address_length_months", "own_home", "income_type", "employer", "job_title", "employed_months",
  "pay_date1", "pay_frequency", "direct_deposit", "monthly_income",
] as const satisfies readonly (keyof LeadExportRow)[];

export const LeadExportResponse = z.strictObject({
  rows: z.array(LeadExportRow),
  /** True when more than `LEAD_EXPORT_LIMIT` rows matched; core returns the newest ones. */
  truncated: z.boolean(),
  pii: z.boolean(),
});
export type LeadExportResponse = z.infer<typeof LeadExportResponse>;

export const SuppressionReason = z.enum(["blocklisted", "unsubscribed", "complaint", "bounce", "manual"]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;
export const SuppressionSource = z.enum(["listmonk", "ses", "manual"]);
export type SuppressionSource = z.infer<typeof SuppressionSource>;

/** `base64url(email)`. 254 characters of up to 4 UTF-8 bytes each is 1,016 bytes, 1,355 base64url characters. */
export const SuppressionCursor = z.string().regex(/^[A-Za-z0-9_-]{1,1356}$/);

export const SuppressionsQuery = z.strictObject({
  /** Matched as a lowercased substring of the email. */
  q: z.string().min(1).max(254).optional(),
  reason: SuppressionReason.optional(),
  source: SuppressionSource.optional(),
  /** A user id, or `"system"` for rows with no actor (listmonk sync). */
  added_by: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: SuppressionCursor.optional(),
});
export type SuppressionsQuery = z.infer<typeof SuppressionsQuery>;

/** One suppression row. `added_by` is the actor who added it manually, null for sync rows. */
export const SuppressionRow = z.strictObject({
  email: z.string().max(254),
  reason: SuppressionReason,
  source: SuppressionSource,
  added_by: z.string().min(1).max(128).nullable(),
  created_at: Timestamp,
  updated_at: Timestamp.nullable(),
});
export type SuppressionRow = z.infer<typeof SuppressionRow>;

/** Every row is an email, so the endpoint is owner-only. */
export const SuppressionsResponse = z.strictObject({
  rows: z.array(SuppressionRow),
  next_cursor: z.string().nullable(),
});
export type SuppressionsResponse = z.infer<typeof SuppressionsResponse>;

/** Lowercased and trimmed. The address travels in the body so it never appears in a URL or access log. */
export const SuppressionEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const AddSuppressionRequest = z.strictObject({
  email: SuppressionEmail,
  reason: SuppressionReason.optional().default("manual"),
});
export type AddSuppressionRequest = z.infer<typeof AddSuppressionRequest>;

/** The inserted row. */
export const AddSuppressionResponse = SuppressionRow;
export type AddSuppressionResponse = z.infer<typeof AddSuppressionResponse>;

export const RemoveSuppressionRequest = z.strictObject({
  email: SuppressionEmail,
});
export type RemoveSuppressionRequest = z.infer<typeof RemoveSuppressionRequest>;

export const RemoveSuppressionResponse = z.strictObject({
  removed: z.literal(true),
});
export type RemoveSuppressionResponse = z.infer<typeof RemoveSuppressionResponse>;

// --- GET /admin/audit ----------------------------------------------------------------------------

/** Actions core writes for this API. Factory rows (install.start, template.seal, ...) also appear. */
export const ADMIN_AUDIT_ACTIONS = [
  "brand.update", "brand.pause", "brand.resume",
  "pii.lead_view", "pii.lead_export", "lead.export", "pii.suppression_search",
  "suppression.add", "suppression.remove",
  "ad_allocation.assign",
] as const;

export const AuditActorRole = z.enum(["owner", "employee", "system"]);

/** One `factory.audit_log` row (entity_type/entity_id -> target, before/after_json -> old/new). */
export const AuditEntry = z.strictObject({
  id: z.number().int().positive(),
  actor_id: z.string().min(1).max(128),
  actor_role: AuditActorRole,
  action: z.string().regex(/^[a-z_]+(?:\.[a-z_]+)+$/, "Invalid audit action"),
  target: z.strictObject({
    type: z.string().regex(/^[a-z_]{1,32}$/),
    id: z.string().min(1).max(128),
  }),
  /** Changed fields before / after. Secrets appear only as PostbackTokenState. */
  old: z.record(z.string(), z.json()).nullable(),
  new: z.record(z.string(), z.json()).nullable(),
  at: Timestamp,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AUDIT_PAGE_LIMIT = { default: 50, min: 1, max: 200 } as const;

/**
 * Query string. For an employee core forces `actor_id` to the caller; an employee who asks for
 * another actor gets 403 forbidden_role.
 */
export const AuditQuery = z.strictObject({
  limit: z.coerce.number().int().min(AUDIT_PAGE_LIMIT.min).max(AUDIT_PAGE_LIMIT.max).optional(),
  /** Opaque `next_cursor` from the previous page. */
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  actor_id: z.string().min(1).max(128).optional(),
  target_type: z.string().regex(/^[a-z_]{1,32}$/).optional(),
  target_id: z.string().min(1).max(128).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/** Newest first. */
export const AuditListResponse = z.strictObject({
  entries: z.array(AuditEntry),
  next_cursor: z.string().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

// --- errors --------------------------------------------------------------------------------------

export const ADMIN_ERROR_STATUS = {
  unauthorized: 401,
  forbidden_role: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
} as const;
export type AdminErrorCode = keyof typeof ADMIN_ERROR_STATUS;

const errorBase = { message: z.string().max(500).optional(), request_id: RequestId.optional() };

/** Uniform non-2xx body. `request_id` is absent only on 401 (no valid context to echo). */
export const AdminError = z.discriminatedUnion("error", [
  z.strictObject({ error: z.literal("unauthorized"), ...errorBase }),
  z.strictObject({
    error: z.literal("forbidden_role"),
    ...errorBase,
    required_role: AdminRole,
    /** PATCH fields the caller may not change (absent when the whole endpoint is denied). */
    denied_fields: z.array(z.string()).min(1).optional(),
  }),
  z.strictObject({ error: z.literal("not_found"), ...errorBase, resource: z.enum(["brand", "lead", "route", "suppression", "campaign"]) }),
  z.strictObject({ error: z.literal("conflict"), ...errorBase, current_updated_at: Timestamp }),
  z.strictObject({
    error: z.literal("invalid"),
    ...errorBase,
    issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).min(1),
  }),
]);
export type AdminError = z.infer<typeof AdminError>;

// --- GET /admin/funnel, /admin/alerts, /admin/mailing (read-only reports) -----------------------

const AlertState = z.enum(["ok", "warn", "alert"]);

/** Query for the funnel report. `to` is exclusive. Matches the insights filter. */
export const FunnelQuery = z
  .strictObject({
    from: Timestamp,
    to: Timestamp,
    brand: z.string().min(1).max(64).optional(),
    keyword: z.string().min(1).max(100).optional(),
    variant: z.string().min(1).max(32).optional(),
  })
  .refine((f) => f.from < f.to, "from must be before to");
export type FunnelQuery = z.infer<typeof FunnelQuery>;

export const FunnelReportResponse = z.strictObject({
  from: Timestamp,
  to: Timestamp,
  rows: z.array(
    z.strictObject({
      brand: z.string().min(1),
      keyword: z.string().min(1).nullable(),
      variant: z.string().min(1).nullable(),
      clicks: Count,
      go_count: Count,
      form_views: Count,
      submits: Count,
      sold: Count,
      /** USD. null for a non-owner. */
      revenue: z.number().finite().min(0).nullable(),
      submit_rate: z.number().finite().min(0).nullable(),
      sold_rate: z.number().finite().min(0).nullable(),
    }),
  ),
});
export type FunnelReportResponse = z.infer<typeof FunnelReportResponse>;

// --- GET /admin/conversions (read-only, money redacted for non-owners) --------------------------

const Money = z.number().finite().min(0);

export const ConversionsQuery = z.strictObject({
  period: SpendPeriod,
  status: z.enum(["all", ...CONVERSION_STATUSES]).default("all"),
  brand: BrandId.optional(),
  /** Rows to return. Omitted means CONVERSIONS_ROW_LIMIT. */
  limit: z.coerce.number().int().min(1).max(CONVERSIONS_MAX_LIMIT).optional(),
  /** Test clock, as in AlertsQuery. Omitted means now. */
  now: Timestamp.optional(),
});
export type ConversionsQuery = z.infer<typeof ConversionsQuery>;

export const ConversionRow = z.strictObject({
  lead_id: LeadId,
  brand: z.string().min(1),
  status: ConversionStatus,
  reason_code: ConversionReasonCode.nullable(),
  last_error: z.string().max(300).nullable(),
  /** Which click id the row has. The id value never leaves core. */
  click_type: z.enum(["gclid", "gbraid", "wbraid", "msclkid"]).nullable(),
  attempts: Count,
  /** USD. null for a non-owner. */
  value: Money.nullable(),
  currency: z.string().length(3),
  occurred_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
  next_attempt_at: Timestamp.nullable(),
});
export type ConversionRow = z.infer<typeof ConversionRow>;

export const ConversionsReportResponse = z.strictObject({
  period: SpendPeriod,
  from: Timestamp,
  /** Exclusive. */
  to: Timestamp,
  /** Period window counts; ignore the status and brand filters. */
  totals: z.strictObject({ pending: Count, processing: Count, uploaded: Count, dead: Count }),
  /** USD sums for the period window. null for a non-owner. */
  value_totals: z.strictObject({ uploaded: Money, dead: Money }).nullable(),
  /** Rows still pending more than CONVERSION_STALLED_HOURS after creation, any age. */
  stalled: Count,
  rows: z.array(ConversionRow),
  /** True when more rows matched than the requested `limit` (default CONVERSIONS_ROW_LIMIT, 200). */
  truncated: z.boolean(),
});
export type ConversionsReportResponse = z.infer<typeof ConversionsReportResponse>;

/** Optional clock override so tests are deterministic. Omitted means "now". */
export const AlertsQuery = z.strictObject({
  now: Timestamp.optional(),
});
export type AlertsQuery = z.infer<typeof AlertsQuery>;

export const AlertsReportResponse = z.strictObject({
  generated_at: Timestamp,
  conversion_stalled: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      max_hours: z.number().positive(),
      stuck_count: Count,
      oldest_created_at: Timestamp.nullable(),
    }),
  }),
  brands_without_postbacks: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_hours: z.number().positive(),
      brands: z.array(z.strictObject({ brand: z.string().min(1), leads: Count })),
    }),
  }),
  submit_error_rate: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_hours: z.number().positive(),
      warn_at: z.number().min(0),
      alert_at: z.number().min(0),
      samples: z.array(
        z.strictObject({
          brand: z.string().min(1),
          submits: Count,
          errors: Count,
          rate: z.number().finite().min(0).max(1),
        }),
      ),
    }),
  }),
  reject_rate: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_hours: z.number().positive(),
      warn_at: z.number().min(0),
      alert_at: z.number().min(0),
      brands: z.array(
        z.strictObject({
          brand: z.string().min(1),
          rejected: Count,
          decided: Count,
          rate: z.number().finite().min(0).max(1),
        }),
      ),
    }),
  }),
  /** FUS-372: hostnames whose high-risk visit share reached `alert_at` with at least `min_visits` visits. */
  click_risk: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_hours: z.number().positive(),
      alert_at: z.number().min(0),
      min_visits: Count,
      hostnames: z.array(
        z.strictObject({
          hostname: Hostname,
          visits: Count,
          high_risk: Count,
          rate: z.number().finite().min(0).max(1),
        }),
      ),
    }),
  }),
  /**
   * Panel redesign T12: crawler hits counted by the brand Workers (no response varies by them).
   * `adsbot_hours` has one row per brand per UTC hour with AdsBot hits; any row makes the state
   * "alert". No money. Optional so a core that predates the counter still parses.
   */
  bot_hits: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_hours: z.number().positive(),
      brands: z.array(z.strictObject({
        brand: z.string().min(1), googlebot: Count, adsbot: Count, other_bot: Count,
      })),
      adsbot_hours: z.array(z.strictObject({ brand: z.string().min(1), hour: Timestamp, hits: Count })),
    }),
  }).optional(),
  /**
   * T13 A3 "ค่าโฆษณายังไม่จัดสรร": accounts shared by several brands whose unmapped campaign cost in the last
   * `window_days` is above `alert_at` of their cost, one row per account and currency. Shares only, no money,
   * because an employee reads this report. Optional so a core that predates it still parses.
   */
  ad_spend_unallocated: z.strictObject({
    state: AlertState,
    detail: z.strictObject({
      window_days: z.number().int().positive(),
      alert_at: z.number().min(0).max(1),
      accounts: z.array(z.strictObject({
        account: GoogleAdsAccount,
        currency: SpendCurrency,
        share: z.number().finite().min(0).max(1),
      })),
    }),
  }).optional(),
});
export type AlertsReportResponse = z.infer<typeof AlertsReportResponse>;

/**
 * Local `mailing_outbox` counts. `external_sync` says whether LISTMONK_* is set.
 * This response never includes a subscriber, an email, or a listmonk call.
 */
export const MailingStatusResponse = z.strictObject({
  external_sync: z.enum(["not_configured", "configured"]),
  counts: z.strictObject({
    pending: Count,
    sent: Count,
    skipped: Count,
    dead: Count,
  }),
});
export type MailingStatusResponse = z.infer<typeof MailingStatusResponse>;

// --- endpoint table and role table ---------------------------------------------------------------

/**
 * Every admin endpoint: method, path template, minimum role and schemas. Core and the panel's
 * mock core both route with this table. `audit_scope: "own_for_employee"` means an employee
 * sees only rows where actor_id is themselves.
 */
export const AdminApi = {
  trafficBreakdown: {
    method: "GET", path: "/admin/traffic/breakdown", min_role: "employee",
    query: TrafficBreakdownQuery, response: TrafficBreakdownResponse,
  },
  listBrands: {
    method: "GET",
    path: "/admin/brands",
    min_role: "employee",
    response: ListBrandsResponse,
  },
  getBrand: {
    method: "GET",
    path: "/admin/brands/:id",
    min_role: "employee",
    response: GetBrandResponse,
  },
  patchBrand: {
    method: "PATCH",
    path: "/admin/brands/:id",
    /** Endpoint floor. Each field group below has its own minimum. */
    min_role: "employee",
    request: BrandPatchRequest,
    response: BrandPatchResponse,
  },
  pauseBrand: {
    method: "POST",
    path: "/admin/brands/:id/pause",
    min_role: "employee",
    request: BrandStatusChangeRequest,
    response: BrandStatusChangeResponse,
  },
  resumeBrand: {
    method: "POST",
    path: "/admin/brands/:id/resume",
    min_role: "employee",
    request: BrandStatusChangeRequest,
    response: BrandStatusChangeResponse,
  },
  leadAggregates: {
    method: "GET",
    path: "/admin/leads/aggregates",
    min_role: "employee",
    query: LeadAggregatesQuery,
    response: LeadAggregatesResponse,
  },
  getLead: {
    method: "GET",
    path: "/admin/leads/:lead_id",
    /** Endpoint floor. The PII fields inside stay owner-only: core redacts them by role. */
    min_role: "employee",
    response: GetLeadResponse,
  },
  // spec leads
  listLeads: {
    method: "GET",
    path: "/admin/leads",
    min_role: "employee",
    query: LeadsQuery,
    response: LeadsResponse,
  },
  /** `pii=1` is owner-only, enforced by `authorize()`; every export is audited. */
  leadExport: {
    method: "GET",
    path: "/admin/leads/export",
    min_role: "employee",
    query: LeadExportQuery,
    response: LeadExportResponse,
  },
  /** Every row is an email: owner-only, and every search is audited. */
  listSuppressions: {
    method: "GET",
    path: "/admin/suppressions",
    min_role: "owner",
    query: SuppressionsQuery,
    response: SuppressionsResponse,
  },
  /** Manual add. An address already suppressed answers 409 conflict. */
  addSuppression: {
    method: "POST",
    path: "/admin/suppressions",
    min_role: "owner",
    request: AddSuppressionRequest,
    response: AddSuppressionResponse,
  },
  /** Manual remove. An unknown address answers 404. */
  removeSuppression: {
    method: "POST",
    path: "/admin/suppressions/remove",
    min_role: "owner",
    request: RemoveSuppressionRequest,
    response: RemoveSuppressionResponse,
  },
  listAudit: {
    method: "GET",
    path: "/admin/audit",
    min_role: "employee",
    audit_scope: "own_for_employee",
    query: AuditQuery,
    response: AuditListResponse,
  },
  funnelReport: {
    method: "GET",
    path: "/admin/funnel",
    min_role: "employee",
    query: FunnelQuery,
    response: FunnelReportResponse,
  },
  alertsReport: {
    method: "GET",
    path: "/admin/alerts",
    min_role: "employee",
    query: AlertsQuery,
    response: AlertsReportResponse,
  },
  mailingStatus: {
    method: "GET",
    path: "/admin/mailing",
    min_role: "employee",
    response: MailingStatusResponse,
  },
  spendReport: {
    method: "GET",
    path: "/admin/spend",
    min_role: "owner",
    query: SpendQuery,
    response: SpendReportResponse,
  },
  /** T13 A3: shared accounts, their campaigns with 7 day cost and owner, the mode and the unallocated total. */
  adAllocation: {
    method: "GET",
    path: "/admin/ad-allocation",
    min_role: "owner",
    query: AdAllocationQuery,
    response: AdAllocationResponse,
  },
  /** T13 A3: the owner gives a campaign of a shared account to one of its brands (`source = 'manual'`). */
  assignAdCampaign: {
    method: "PATCH",
    path: "/admin/ad-allocation/campaign",
    min_role: "owner",
    request: AdAllocationAssignRequest,
    response: AdAllocationAssignResponse,
  },
  /** T13-7: spend per brand, currency and allocation over a day range, for API v1. Cost only: no USD, no profit. */
  spendRows: {
    method: "GET",
    path: "/admin/spend/rows",
    min_role: "owner",
    query: SpendRowsQuery,
    response: SpendRowsResponse,
  },
  /** FUS-384 auto-created conversion action status for one brand. */
  conversionSetup: {
    method: "GET",
    path: "/admin/brands/:id/conversion-setup",
    min_role: "owner",
    response: ConversionSetupStateResponse,
  },
  /** T9 AdKit directory (ADR-0005): fresh rows only, synced from the VPS. */
  adkitProjects: {
    method: "GET",
    path: "/admin/adkit/projects",
    min_role: "owner",
    response: AdkitDirectoryResponse,
  },
  adkitAccounts: {
    method: "GET",
    path: "/admin/adkit/projects/:project/accounts",
    min_role: "owner",
    response: AdkitDirectoryResponse,
  },
  adkitConversionActions: {
    method: "GET",
    path: "/admin/adkit/accounts/:account/conversion-actions",
    min_role: "owner",
    response: AdkitDirectoryResponse,
  },
  /** Queue one AdKit job. Idempotent: a repeat answers the existing row with `created: false`. */
  createAdkitJob: {
    method: "POST",
    path: "/admin/adkit/jobs",
    min_role: "owner",
    request: AdkitJobCreateRequest,
    response: AdkitJobCreateResponse,
  },
  /**
   * T13 Part B: queue a campaign job. Employee may queue a draft; core refuses the other kinds below the role in
   * CAMPAIGN_JOB_ROLES (enable, pause, budget are owner only). Budgets above a baht cap are 422 before a row exists.
   */
  createCampaignJob: {
    method: "POST",
    path: "/admin/adkit/campaign-jobs",
    min_role: "employee",
    request: CampaignJobCreateRequest,
    response: AdkitJobCreateResponse,
  },
  /** Panel campaigns derived from their jobs, with the caps and the enabled total in baht per day. */
  listCampaigns: {
    method: "GET",
    path: "/admin/adkit/campaigns",
    min_role: "employee",
    response: PanelCampaignsResponse,
  },
  conversionsReport: {
    method: "GET",
    path: "/admin/conversions",
    min_role: "employee",
    query: ConversionsQuery,
    response: ConversionsReportResponse,
  },
  /** FUS-372 observe-only click risk totals. */
  trafficRisk: {
    method: "GET",
    path: "/admin/traffic/risk",
    min_role: "employee",
    query: TrafficRiskQuery,
    response: TrafficRiskResponse,
  },
  /** High-risk visits with their gclid, for a Google Ads refund request. The panel serves it as CSV. */
  trafficRiskExport: {
    method: "GET",
    path: "/admin/traffic/risk/export",
    min_role: "owner",
    query: TrafficRiskExportQuery,
    response: TrafficRiskExportResponse,
  },
  // spec traffic
  trafficReport: {
    method: "GET", path: "/admin/traffic/report", min_role: "employee",
    query: TrafficReportQuery, response: TrafficReportResponse,
  },
  clientErrors: {
    method: "GET", path: "/admin/client-errors", min_role: "employee",
    query: ClientErrorsQuery, response: ClientErrorsResponse,
  },
} as const;
export type AdminEndpoint = keyof typeof AdminApi;
export const ADMIN_ENDPOINTS = Object.keys(AdminApi) as AdminEndpoint[];

/**
 * PATCH /admin/brands/:id field groups and their minimum role. Every BRAND_PATCH_FIELDS entry
 * is in exactly one group. `plan_action` is the row of the T12 plan's role matrix it implements.
 */
export const BRAND_PATCH_FIELD_GROUPS = {
  keyword: {
    min_role: "employee",
    fields: ["keyword_default"],
    plan_action: "Edit keyword default",
  },
  site_text: {
    min_role: "employee",
    fields: ["brand_name", "site_title", "site_description"],
    plan_action: "Edit site text",
  },
  brand_colors: {
    min_role: "employee",
    fields: ["theme"],
    plan_action: "Edit brand colors",
  },
  ab_weights: {
    min_role: "owner",
    fields: ["ab_config"],
    plan_action: "Change A/B weights",
  },
  amount_buckets: {
    min_role: "owner",
    fields: ["amount_buckets"],
    plan_action: "Change amount buckets",
  },
  flow_gate_mode: {
    min_role: "owner",
    fields: ["flow_gate_mode"],
    plan_action: "Switch flow gate mode (`param` / `signed_cookie`)",
  },
  money_routing: {
    min_role: "owner",
    fields: ["aid", "prepop_base", "drain_key", "google_ads_account", "google_conversion_action", "adkit_project", "rotate_postback_token"],
    plan_action: "Set LeadsGate aid, postback token, drain key, prepop base",
  },
} as const satisfies Record<string, { min_role: AdminRole; fields: readonly BrandPatchField[]; plan_action: string }>;
export type BrandPatchFieldGroup = keyof typeof BRAND_PATCH_FIELD_GROUPS;

/** Field -> minimum role, derived from BRAND_PATCH_FIELD_GROUPS. */
export const BRAND_PATCH_FIELD_MIN_ROLE: Record<BrandPatchField, AdminRole> = Object.fromEntries(
  Object.values(BRAND_PATCH_FIELD_GROUPS).flatMap((g) => g.fields.map((f) => [f, g.min_role])),
) as Record<BrandPatchField, AdminRole>;

export interface AdminRoleTableRow {
  /** `"METHOD /path"` or `"PATCH /admin/brands/:id#<group>"` for a field group. */
  key: string;
  endpoint: AdminEndpoint;
  field_group: BrandPatchFieldGroup | null;
  fields: readonly string[] | null;
  min_role: AdminRole;
  /** What each role sees where it differs (audit only). */
  scope: { employee: "own" | "all" | "none"; owner: "own" | "all" | "none" };
}

/**
 * Machine-readable role table: every endpoint and every PATCH field group with its minimum role.
 * T6 and T12a both test against this.
 */
export const ADMIN_ROLE_TABLE: readonly AdminRoleTableRow[] = [
  ...ADMIN_ENDPOINTS.map((e): AdminRoleTableRow => {
    const def = AdminApi[e];
    const ownOnly = "audit_scope" in def && def.audit_scope === "own_for_employee";
    return {
      key: `${def.method} ${def.path}`,
      endpoint: e,
      field_group: null,
      fields: null,
      min_role: def.min_role,
      scope: {
        employee: def.min_role === "owner" ? "none" : ownOnly ? "own" : "all",
        owner: "all",
      },
    };
  }),
  ...(Object.entries(BRAND_PATCH_FIELD_GROUPS) as [BrandPatchFieldGroup, (typeof BRAND_PATCH_FIELD_GROUPS)[BrandPatchFieldGroup]][]).map(
    ([group, g]): AdminRoleTableRow => ({
      key: `PATCH /admin/brands/:id#${group}`,
      endpoint: "patchBrand",
      field_group: group,
      fields: g.fields,
      min_role: g.min_role,
      scope: { employee: g.min_role === "owner" ? "none" : "all", owner: "all" },
    }),
  ),
];

export type AuthorizeResult =
  | { ok: true; scope: "own" | "all" }
  | { ok: false; status: 403; error: Extract<AdminError, { error: "forbidden_role" }> };

/**
 * Role check for one call. For `patchBrand` pass the (parsed or raw) body: every present key
 * whose group needs a higher role is listed in `denied_fields`. An unknown key is treated as
 * owner-only, so the check fails closed. For `leadExport` pass `{ pii }`: a truthy `pii` from a
 * non-owner is denied. Pass a boolean, for example `{ pii: query.pii === "1" }`:
 * `LeadExportQuery.pii` is the string `"0" | "1"`, and `"0"` is truthy, so the parsed query
 * object would deny a non-PII export. `scope: "own"` means core must filter to the actor's
 * own rows (audit log).
 */
export function authorize(endpoint: AdminEndpoint, role: AdminRole, patch?: Record<string, unknown>): AuthorizeResult {
  const def = AdminApi[endpoint];
  if (!roleAtLeast(role, def.min_role)) {
    return { ok: false, status: 403, error: { error: "forbidden_role", required_role: def.min_role } };
  }
  if (endpoint === "patchBrand" && patch) {
    const denied = Object.keys(patch).filter((k) => {
      if (k === "expected_updated_at") return false;
      if (patch[k] === undefined) return false;
      const min = (BRAND_PATCH_FIELD_MIN_ROLE as Record<string, AdminRole | undefined>)[k] ?? "owner";
      return !roleAtLeast(role, min);
    });
    if (denied.length > 0) {
      return { ok: false, status: 403, error: { error: "forbidden_role", required_role: "owner", denied_fields: denied } };
    }
  }
  // spec leads
  if (endpoint === "leadExport" && patch?.pii && !roleAtLeast(role, "owner")) {
    return { ok: false, status: 403, error: { error: "forbidden_role", required_role: "owner", denied_fields: ["pii"] } };
  }
  const ownOnly = "audit_scope" in def && def.audit_scope === "own_for_employee" && role !== "owner";
  return { ok: true, scope: ownOnly ? "own" : "all" };
}

/**
 * Match a request to an endpoint (core router and the panel's mock core). A path with no `:param`
 * wins over one with params, whatever the table order: `/admin/leads/export` is not a lead id.
 */
export function matchAdminRoute(
  method: string,
  pathname: string,
): { endpoint: AdminEndpoint; params: Record<string, string> } | null {
  const parts = pathname.replace(/\/+$/, "").split("/");
  let withParams: { endpoint: AdminEndpoint; params: Record<string, string> } | null = null;
  for (const e of ADMIN_ENDPOINTS) {
    const def = AdminApi[e];
    if (def.method !== method.toUpperCase()) continue;
    const tpl = def.path.split("/");
    if (tpl.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < tpl.length && ok; i++) {
      const t = tpl[i]!;
      const p = parts[i]!;
      if (t.startsWith(":")) {
        if (p === "") ok = false;
        else params[t.slice(1)] = decodeURIComponent(p);
      } else if (t !== p) ok = false;
    }
    if (!ok) continue;
    if (Object.keys(params).length === 0) return { endpoint: e, params };
    withParams ??= { endpoint: e, params };
  }
  return withParams;
}
