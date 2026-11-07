/**
 * AdKit directory and job queue (panel redesign T9, ADR-0005). Workers never call AdKit.
 *
 * VPS routes on core, drain token in the `Authorization` header only:
 *   POST /api/adkit/directory/ingest  hourly snapshot of projects, accounts and conversion actions
 *   GET  /api/adkit/jobs/pending      jobs the executor may claim now
 *   POST /api/adkit/jobs/claim        claim one job (atomic; two claims, one wins)
 *   POST /api/adkit/jobs/result       the job's result or its error
 *
 * Admin routes (owner) are in admin-api.ts: the three directory reads and POST /admin/adkit/jobs.
 */
import { z } from "zod";
import { AdkitProject, BrandId, GoogleAdsAccount, GoogleConversionAction } from "./common.js";
import { ConversionName } from "./conversion-setup.js";

const Timestamp = z.iso.datetime();

/** Directory rows older than this are not served: the panel shows "—" (ADR-0005 decision 10). */
export const ADKIT_DIRECTORY_STALE_MS = 2 * 60 * 60 * 1000;
/** A claim older than this is a crashed executor run and may be claimed again. */
export const ADKIT_JOB_LEASE_MS = 30 * 60 * 1000;
/** Claims per job. A job that fails or crashes this many times stays failed. */
export const ADKIT_JOB_MAX_ATTEMPTS = 5;
/** Most items one directory ingest accepts; the sync script sends larger snapshots in chunks. */
export const ADKIT_DIRECTORY_INGEST_MAX = 500;

/** Wait before the next claim after the `attempts`-th failed claim: 1 h, 2 h, 4 h ... capped at 24 h. */
export function adkitJobBackoffMs(attempts: number): number {
  const hour = 60 * 60 * 1000;
  return Math.min(2 ** Math.max(attempts - 1, 0) * hour, 24 * hour);
}

export const AdkitDirectoryKind = z.enum(["project", "account", "conversion_action"]);
export type AdkitDirectoryKind = z.infer<typeof AdkitDirectoryKind>;

const DirectoryName = z.string().trim().min(1).max(200);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "Invalid currency");

/** One directory row as the VPS posts it. The id and parent formats depend on the kind. */
export const AdkitDirectoryIngestItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), id: AdkitProject, parent_id: z.null(), name: DirectoryName, currency: z.null() }),
  z.strictObject({
    kind: z.literal("account"), id: GoogleAdsAccount, parent_id: AdkitProject.nullable(), name: DirectoryName,
    currency: CurrencyCode.nullable(),
  }),
  z.strictObject({
    kind: z.literal("conversion_action"), id: GoogleConversionAction, parent_id: GoogleAdsAccount, name: DirectoryName,
    currency: z.null(),
  }),
]);
export type AdkitDirectoryIngestItem = z.infer<typeof AdkitDirectoryIngestItem>;

export const AdkitDirectoryIngestRequest = z.strictObject({
  items: z.array(AdkitDirectoryIngestItem).min(1).max(ADKIT_DIRECTORY_INGEST_MAX),
});
export type AdkitDirectoryIngestRequest = z.infer<typeof AdkitDirectoryIngestRequest>;

export const AdkitDirectoryIngestResponse = z.strictObject({ status: z.literal("ok"), upserted: z.number().int().min(0) });
export type AdkitDirectoryIngestResponse = z.infer<typeof AdkitDirectoryIngestResponse>;

export const AdkitDirectoryItem = z.strictObject({
  id: z.string(),
  name: z.string(),
  currency: CurrencyCode.nullable(),
  updated_at: Timestamp,
});
export type AdkitDirectoryItem = z.infer<typeof AdkitDirectoryItem>;

/** Fresh rows only. `synced_at` is the newest updated_at served, null when nothing is fresh. */
export const AdkitDirectoryResponse = z.strictObject({
  items: z.array(AdkitDirectoryItem),
  synced_at: Timestamp.nullable(),
});
export type AdkitDirectoryResponse = z.infer<typeof AdkitDirectoryResponse>;

/** Jobs POST /admin/adkit/jobs queues (wizard step 4). */
export const ConversionJobKind = z.enum(["conversion_action.create"]);
export type ConversionJobKind = z.infer<typeof ConversionJobKind>;

/** Jobs POST /admin/adkit/campaign-jobs queues (T13 Part B). Only campaign.enable spends money. */
export const CampaignJobKind = z.enum(["campaign.draft.create", "campaign.update_budget", "campaign.pause", "campaign.enable"]);
export type CampaignJobKind = z.infer<typeof CampaignJobKind>;

export const AdkitJobKind = z.enum([...ConversionJobKind.options, ...CampaignJobKind.options]);
export type AdkitJobKind = z.infer<typeof AdkitJobKind>;

export const AdkitJobStatus = z.enum(["queued", "claimed", "done", "failed"]);
export type AdkitJobStatus = z.infer<typeof AdkitJobStatus>;

/** What the executor needs to create the action. The name is opaque and fixed per job, so a retry adopts it. */
export const ConversionActionCreatePayload = z.strictObject({
  brand_draft_id: BrandId,
  account: GoogleAdsAccount,
  project: AdkitProject.nullable(),
  name: ConversionName,
});
export type ConversionActionCreatePayload = z.infer<typeof ConversionActionCreatePayload>;

export const ConversionActionCreateResult = z.strictObject({
  conversion_action_id: GoogleConversionAction,
  name: ConversionName,
  adopted: z.boolean(),
});
export type ConversionActionCreateResult = z.infer<typeof ConversionActionCreateResult>;

export const AdkitJobError = z.strictObject({ error: z.string().min(1).max(500) });

// --- campaign jobs (T13 Part B) ---------------------------------------------------------------------

/** Largest baht amount a cap or a daily budget may hold. */
export const THB_PER_DAY_MAX = 1_000_000;
const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** Baht per day: finite, 0 to 1,000,000, at most 2 decimals. */
export const ThbPerDay = z.number().finite().min(0).max(THB_PER_DAY_MAX)
  .refine(twoDecimals, "At most 2 decimals");
/** A campaign daily budget in the account currency: like ThbPerDay but above 0. */
export const DailyBudget = z.number().finite().positive().max(THB_PER_DAY_MAX)
  .refine(twoDecimals, "At most 2 decimals");

/** panel_settings keys (factory D1). Owner edit only. */
export const ADS_CAP_TOTAL_KEY = "ads_cap_total_thb_day";
export const ADS_CAP_BRAND_KEY = "ads_cap_brand_thb_day";
/** Owner decision 2026-11-08: 3,000 baht per day for both. */
export const DEFAULT_ADS_CAP_THB_DAY = 3000;
/** Baht per US dollar (panel_settings). Core converts a USD budget with it before the cap check. */
export const FX_THB_PER_USD_KEY = "fx_thb_per_usd";
/** The owner confirmed 35 as the starting rate. */
export const DEFAULT_THB_PER_USD = 35;

/** PUT /api/settings/ads-caps. A brand cap above the total cap is refused. */
export const AdsCapsSettingRequest = z.strictObject({ total_thb_day: ThbPerDay, brand_thb_day: ThbPerDay })
  .refine((caps) => caps.brand_thb_day <= caps.total_thb_day, { path: ["brand_thb_day"], message: "brand cap is above the total cap" });
export type AdsCapsSettingRequest = z.infer<typeof AdsCapsSettingRequest>;

/** `<brand_slug>-search-<n>`: the campaign name carries the brand. Core also checks the prefix is the job's brand_id. */
export const CAMPAIGN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}-search-[1-9][0-9]{0,3}$/;
export const CampaignName = z.string().regex(CAMPAIGN_NAME_PATTERN, "Invalid campaign name");
export const GoogleCampaignId = z.string().regex(/^\d{1,20}$/, "Invalid campaign_id");
export const BidStrategy = z.enum(["maximize_conversions", "maximize_clicks"]);
export const CampaignGeo = z.union([
  z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/, "Invalid country") }),
  z.strictObject({ city_code: z.string().regex(/^\d{1,10}$/, "Invalid city_code") }),
]);
// Printable text only: keywords go into the --data JSON argument, never into argv on their own.
const Keyword = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u, "Invalid keyword");
export const CampaignKeywords = z.array(Keyword).min(1).max(200);
export const CampaignFinalUrl = z.url({ protocol: /^https$/ }).max(2048);

/** campaign.draft.create as stored: account and project come from the brand, never from the request. */
export const CampaignDraftPayload = z.strictObject({
  brand_id: BrandId,
  account: GoogleAdsAccount,
  project: AdkitProject.nullable(),
  name: CampaignName,
  daily_budget: DailyBudget,
  bid_strategy: BidStrategy,
  geo: CampaignGeo,
  keywords: CampaignKeywords,
  final_url: CampaignFinalUrl,
});
export type CampaignDraftPayload = z.infer<typeof CampaignDraftPayload>;

/** campaign.enable and campaign.pause as stored: the campaign plus where it lives, copied from its draft job. */
export const CampaignRefPayload = z.strictObject({
  campaign_id: GoogleCampaignId,
  brand_id: BrandId,
  account: GoogleAdsAccount,
  project: AdkitProject.nullable(),
  name: CampaignName,
});
export type CampaignRefPayload = z.infer<typeof CampaignRefPayload>;

/** campaign.update_budget as stored. */
export const CampaignBudgetPayload = z.strictObject({ ...CampaignRefPayload.shape, daily_budget: DailyBudget });
export type CampaignBudgetPayload = z.infer<typeof CampaignBudgetPayload>;

export const CampaignDraftResult = z.strictObject({ campaign_id: GoogleCampaignId, name: CampaignName, adopted: z.boolean() });
export type CampaignDraftResult = z.infer<typeof CampaignDraftResult>;
export const CampaignStatusResult = z.strictObject({ campaign_id: GoogleCampaignId, status: z.enum(["ENABLED", "PAUSED"]) });
export type CampaignStatusResult = z.infer<typeof CampaignStatusResult>;
export const CampaignBudgetResult = z.strictObject({ campaign_id: GoogleCampaignId, daily_budget: DailyBudget });
export type CampaignBudgetResult = z.infer<typeof CampaignBudgetResult>;

/** POST /admin/adkit/campaign-jobs. Core derives the idempotency key; the client never sends one. */
export const CampaignJobCreateRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("campaign.draft.create"),
    brand_id: BrandId,
    name: CampaignName,
    daily_budget: DailyBudget,
    bid_strategy: BidStrategy,
    geo: CampaignGeo,
    keywords: CampaignKeywords,
    final_url: CampaignFinalUrl,
  }),
  z.strictObject({ kind: z.literal("campaign.enable"), campaign_id: GoogleCampaignId }),
  z.strictObject({ kind: z.literal("campaign.pause"), campaign_id: GoogleCampaignId }),
  z.strictObject({ kind: z.literal("campaign.update_budget"), campaign_id: GoogleCampaignId, daily_budget: DailyBudget }),
]);
export type CampaignJobCreateRequest = z.infer<typeof CampaignJobCreateRequest>;

/**
 * Who may queue each campaign job. Core enforces it. An employee may make drafts; every job that changes what a
 * live campaign spends or does is owner only. `ads:enable` API keys (T13-7) map onto the enableCampaign action.
 */
export const CAMPAIGN_JOB_ROLES = {
  "campaign.draft.create": { action: "createCampaignDraft", min_role: "employee" },
  "campaign.enable": { action: "enableCampaign", min_role: "owner" },
  "campaign.pause": { action: "pauseCampaign", min_role: "owner" },
  "campaign.update_budget": { action: "updateCampaignBudget", min_role: "owner" },
} as const satisfies Record<CampaignJobKind, { action: string; min_role: "employee" | "owner" }>;

/** The state core derives for one panel campaign from its jobs. */
export const CampaignState = z.enum(["drafting", "draft", "enabling", "enabled", "paused", "failed"]);
export const PanelCampaign = z.strictObject({
  draft_job_id: z.string().uuid(),
  campaign_id: GoogleCampaignId.nullable(),
  brand_id: BrandId,
  account: GoogleAdsAccount,
  name: CampaignName,
  daily_budget: DailyBudget,
  currency: CurrencyCode.nullable(),
  daily_budget_thb: z.number().nullable(),
  state: CampaignState,
  updated_at: Timestamp,
});
export type PanelCampaign = z.infer<typeof PanelCampaign>;

/** GET /admin/adkit/campaigns: panel campaigns, the caps and what is already enabled, in baht per day. */
export const PanelCampaignsResponse = z.strictObject({
  campaigns: z.array(PanelCampaign),
  caps: z.strictObject({ total_thb_day: ThbPerDay, brand_thb_day: ThbPerDay }),
  enabled_total_thb_day: z.number().min(0),
});
export type PanelCampaignsResponse = z.infer<typeof PanelCampaignsResponse>;

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9:._-]{8,160}$/, "Invalid idempotency_key");

/** POST /admin/adkit/jobs. Without a key, core derives `<kind>:<brand_draft_id>`. */
export const AdkitJobCreateRequest = z.strictObject({
  kind: ConversionJobKind,
  brand_draft_id: BrandId,
  idempotency_key: IdempotencyKey.optional(),
});
export type AdkitJobCreateRequest = z.infer<typeof AdkitJobCreateRequest>;

export const AdkitJobPayload = z.union([ConversionActionCreatePayload, CampaignDraftPayload, CampaignBudgetPayload, CampaignRefPayload]);
export const AdkitJobOutcome = z.union([ConversionActionCreateResult, CampaignDraftResult, CampaignStatusResult, CampaignBudgetResult]);

export const AdkitJob = z.strictObject({
  id: z.string().uuid(),
  kind: AdkitJobKind,
  status: AdkitJobStatus,
  payload: AdkitJobPayload,
  result: z.union([AdkitJobOutcome, AdkitJobError]).nullable(),
  attempts: z.number().int().min(0),
  idempotency_key: z.string(),
  requested_by: z.string(),
  next_attempt_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type AdkitJob = z.infer<typeof AdkitJob>;

/** `created` is false when the idempotency key already had a row: the body is that row's current state. */
export const AdkitJobCreateResponse = z.strictObject({ job: AdkitJob, created: z.boolean() });
export type AdkitJobCreateResponse = z.infer<typeof AdkitJobCreateResponse>;

const executorJob = <K extends z.ZodType, P extends z.ZodType>(kind: K, payload: P) =>
  z.strictObject({ id: z.string().uuid(), kind, payload, attempts: z.number().int().min(0) });
const ExecutorJob = z.discriminatedUnion("kind", [
  executorJob(z.literal("conversion_action.create"), ConversionActionCreatePayload),
  executorJob(z.literal("campaign.draft.create"), CampaignDraftPayload),
  executorJob(z.literal("campaign.update_budget"), CampaignBudgetPayload),
  executorJob(z.literal("campaign.pause"), CampaignRefPayload),
  executorJob(z.literal("campaign.enable"), CampaignRefPayload),
]);

export const AdkitJobsPendingResponse = z.strictObject({ jobs: z.array(ExecutorJob) });
export type AdkitJobsPendingResponse = z.infer<typeof AdkitJobsPendingResponse>;

export const AdkitJobClaimRequest = z.strictObject({ job_id: z.string().uuid() });
export type AdkitJobClaimRequest = z.infer<typeof AdkitJobClaimRequest>;

export const AdkitJobClaimResponse = z.strictObject({
  status: z.literal("claimed"),
  claim_id: z.string().uuid(),
  job: ExecutorJob,
});
export type AdkitJobClaimResponse = z.infer<typeof AdkitJobClaimResponse>;

/**
 * Exactly one of `result` or `error`. `retryable: false` fails the job at once (for example a command outside
 * the executor allowlist); otherwise it is queued again after the backoff while attempts are left.
 */
export const AdkitJobResultRequest = z.union([
  z.strictObject({ job_id: z.string().uuid(), claim_id: z.string().uuid(), result: AdkitJobOutcome }),
  z.strictObject({
    job_id: z.string().uuid(), claim_id: z.string().uuid(), error: z.string().min(1).max(500), retryable: z.boolean().optional(),
  }),
]);
export type AdkitJobResultRequest = z.infer<typeof AdkitJobResultRequest>;
