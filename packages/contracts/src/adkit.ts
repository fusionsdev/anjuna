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
export const CampaignJobKind = z.enum([
  "campaign.draft.create", "campaign.update_budget", "campaign.pause", "campaign.enable", "campaign.status_check",
]);
export type CampaignJobKind = z.infer<typeof CampaignJobKind>;

/** The panel's AdKit Terminal (T13-6): one allowlisted `adkit manage ...` line, run once by the executor. */
export const TerminalJobKind = z.enum(["terminal.run"]);
export type TerminalJobKind = z.infer<typeof TerminalJobKind>;

export const AdkitJobKind = z.enum([...ConversionJobKind.options, ...CampaignJobKind.options, ...TerminalJobKind.options]);
export type AdkitJobKind = z.infer<typeof AdkitJobKind>;

/**
 * `held`: a campaign enable or budget job waiting for its cap recheck; never claimable.
 * `unknown`: a claimed campaign enable or budget job whose outcome never reached core (last lease expired, or the last
 * attempt reported an error). Core keeps its budget counted until a status check or a confirmed pause resolves it.
 */
export const AdkitJobStatus = z.enum(["queued", "claimed", "done", "failed", "held", "unknown"]);
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

/**
 * A draft result carries what AdKit holds: a new draft, or an adopted campaign whose name, budget and status
 * (PAUSED or DRAFT) all matched the job. An ENABLED campaign is never recorded as a draft.
 */
export const CampaignDraftResult = z.strictObject({
  campaign_id: GoogleCampaignId, name: CampaignName, adopted: z.boolean(),
  status: z.enum(["PAUSED", "DRAFT"]), daily_budget: DailyBudget,
});
export type CampaignDraftResult = z.infer<typeof CampaignDraftResult>;
export const CampaignStatusResult = z.strictObject({ campaign_id: GoogleCampaignId, status: z.enum(["ENABLED", "PAUSED"]) });
export type CampaignStatusResult = z.infer<typeof CampaignStatusResult>;
export const CampaignBudgetResult = z.strictObject({ campaign_id: GoogleCampaignId, daily_budget: DailyBudget });
export type CampaignBudgetResult = z.infer<typeof CampaignBudgetResult>;
/** campaign.status_check: what `campaigns list` reports for the campaign id. NOT_FOUND only after a complete listing. */
export const CampaignStatusCheckResult = z.strictObject({
  campaign_id: GoogleCampaignId,
  observed_status: z.enum(["ENABLED", "PAUSED", "DRAFT", "REMOVED", "NOT_FOUND"]),
  daily_budget: DailyBudget.nullable(),
});
export type CampaignStatusCheckResult = z.infer<typeof CampaignStatusCheckResult>;

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
  z.strictObject({ kind: z.literal("campaign.status_check"), campaign_id: GoogleCampaignId }),
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
  /** Read only: lists the campaign in AdKit and records what it reports. */
  "campaign.status_check": { action: "checkCampaignStatus", min_role: "employee" },
} as const satisfies Record<CampaignJobKind, { action: string; min_role: "employee" | "owner" }>;

/** The state core derives for one panel campaign from its jobs. */
export const CampaignState = z.enum(["drafting", "draft", "enabling", "enabled", "paused", "failed", "unknown", "removed"]);
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
  /** Copied from the draft job, so the enable dialog can show where the ads run and which page they open. */
  geo: CampaignGeo,
  final_url: CampaignFinalUrl,
});
export type PanelCampaign = z.infer<typeof PanelCampaign>;

/**
 * Per brand with a Google Ads account: the account currency, the baht per one unit of it, and the baht per day core
 * counts against the caps (committed: spending campaigns plus pending budget jobs). `thb_per_unit` and
 * `committed_thb_day` are null when core cannot convert a currency; the client then skips its cap pre-check.
 */
export const PanelCampaignBrand = z.strictObject({
  brand_id: BrandId,
  currency: CurrencyCode.nullable(),
  thb_per_unit: z.number().positive().nullable(),
  committed_thb_day: z.number().min(0).nullable(),
});
export type PanelCampaignBrand = z.infer<typeof PanelCampaignBrand>;

/** GET /admin/adkit/campaigns: panel campaigns, the caps and what is already enabled, in baht per day. */
export const PanelCampaignsResponse = z.strictObject({
  campaigns: z.array(PanelCampaign),
  brands: z.array(PanelCampaignBrand),
  caps: z.strictObject({ total_thb_day: ThbPerDay, brand_thb_day: ThbPerDay }),
  enabled_total_thb_day: z.number().min(0),
});
export type PanelCampaignsResponse = z.infer<typeof PanelCampaignsResponse>;

// --- AdKit Terminal (T13-6) -------------------------------------------------------------------------

export const TerminalMode = z.enum(["read", "draft", "publish"]);
export type TerminalMode = z.infer<typeof TerminalMode>;
/** Longest line the Terminal takes. Same value as TERMINAL_LINE_MAX in scripts/drain/adkit-allowlist.mjs. */
export const TERMINAL_LINE_MAX = 4000;
/** Most bytes of output a terminal job keeps. Same value as TERMINAL_OUTPUT_MAX in adkit-allowlist.mjs. */
export const TERMINAL_OUTPUT_MAX = 20 * 1024;
/** How often the result view polls, and when it gives up (spec Part C). */
export const TERMINAL_POLL_MS = 3000;
export const TERMINAL_POLL_MAX_MS = 120_000;

/** terminal.run as stored: the parsed argv, never the raw line alone. The executor checks it again. */
export const TerminalRunPayload = z.strictObject({
  line: z.string().max(TERMINAL_LINE_MAX),
  argv: z.array(z.string().max(TERMINAL_LINE_MAX)).min(4).max(60),
  mode: TerminalMode,
});
export type TerminalRunPayload = z.infer<typeof TerminalRunPayload>;
/** Output is masked and cut by the executor before it is posted; core masks and cuts again before it stores. */
export const TerminalRunResult = z.strictObject({ output: z.string().max(65536) });
export type TerminalRunResult = z.infer<typeof TerminalRunResult>;

/** POST /admin/adkit/terminal. `dry_run` parses and answers the argv without a job. Publish mode needs `confirm: true`. */
export const TerminalRunRequest = z.strictObject({
  line: z.string().max(TERMINAL_LINE_MAX),
  mode: TerminalMode,
  dry_run: z.boolean().optional(),
  confirm: z.boolean().optional(),
});
export type TerminalRunRequest = z.infer<typeof TerminalRunRequest>;

/** What the panel may read of a terminal job. `output` is masked and at most 20 KB. */
export const TerminalJobView = z.strictObject({
  id: z.string().uuid(),
  status: AdkitJobStatus,
  mode: TerminalMode,
  line: z.string(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  requested_by: z.string(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type TerminalJobView = z.infer<typeof TerminalJobView>;
/** `job` is null for a dry run. */
export const TerminalRunResponse = z.strictObject({
  preview: z.boolean(),
  argv: z.array(z.string()),
  mode: TerminalMode,
  job: TerminalJobView.nullable(),
});
export type TerminalRunResponse = z.infer<typeof TerminalRunResponse>;
export const TerminalJobResponse = z.strictObject({ job: TerminalJobView });
export type TerminalJobResponse = z.infer<typeof TerminalJobResponse>;

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9:._-]{8,160}$/, "Invalid idempotency_key");

/** POST /admin/adkit/jobs. Without a key, core derives `<kind>:<brand_draft_id>`. */
export const AdkitJobCreateRequest = z.strictObject({
  kind: ConversionJobKind,
  brand_draft_id: BrandId,
  idempotency_key: IdempotencyKey.optional(),
});
export type AdkitJobCreateRequest = z.infer<typeof AdkitJobCreateRequest>;

export const AdkitJobPayload = z.union([ConversionActionCreatePayload, CampaignDraftPayload, CampaignBudgetPayload, CampaignRefPayload]);
export const AdkitJobOutcome = z.union([
  ConversionActionCreateResult, CampaignDraftResult, CampaignStatusResult, CampaignBudgetResult, CampaignStatusCheckResult,
]);

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
  executorJob(z.literal("campaign.status_check"), CampaignRefPayload),
  executorJob(z.literal("terminal.run"), TerminalRunPayload),
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
  /** terminal.run (T13-6): the masked, cut output. */
  z.strictObject({ job_id: z.string().uuid(), claim_id: z.string().uuid(), result: TerminalRunResult }),
  z.strictObject({
    job_id: z.string().uuid(), claim_id: z.string().uuid(), error: z.string().min(1).max(500), retryable: z.boolean().optional(),
    /** false: the executor failed before any campaigns create or update ran. Absent counts as a possible write. */
    wrote: z.boolean().optional(),
  }),
]);
export type AdkitJobResultRequest = z.infer<typeof AdkitJobResultRequest>;
