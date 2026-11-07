/**
 * Campaign jobs (T13 Part B). The panel queues them on the T9 AdKit job queue; the VPS executor runs them.
 * Core never calls AdKit.
 *
 * Admin routes (dispatched from admin/index.ts):
 *   POST /admin/adkit/campaign-jobs  queue campaign.draft.create, campaign.enable, campaign.pause or campaign.update_budget
 *   GET  /admin/adkit/campaigns      panel campaigns derived from their jobs, with the caps
 *
 * Money rules:
 *   - A draft is created in AdKit without publish. campaign.enable is the only job that turns spend on.
 *   - Who may queue what: CAMPAIGN_JOB_ROLES (an employee may draft; enable, pause and budget are owner only).
 *   - Caps: ads_cap_total_thb_day and ads_cap_brand_thb_day (factory panel_settings, default 3000). checkBudget runs
 *     when the draft is made and again when it is enabled or its budget changes. "Enabled" counts every panel campaign
 *     whose last status job is a done enable, plus every enable or budget job still queued or claimed.
 *   - A budget is in the account currency (adkit_directory). THB counts as is, USD is converted with fx_thb_per_usd,
 *     any other or unknown currency is refused.
 *   - Two owner requests at the same moment could each pass the check before the other's row exists. An enable or
 *     budget job is therefore inserted on hold (not claimable), the caps are checked again over every row, and only
 *     then is the hold released. A row that breaks a cap is failed at once and the caller gets 422.
 *
 * Idempotency key: sha256(kind|brand_id|account|name) in hex. Enable, pause and budget append |n when the campaign
 * already has n finished jobs of that kind, so a second enable after a pause is a new job while a repeated post of
 * the same request still finds the first row.
 */
import {
  ADS_CAP_BRAND_KEY,
  ADS_CAP_TOTAL_KEY,
  CAMPAIGN_JOB_ROLES,
  CampaignBudgetPayload,
  CampaignDraftPayload,
  CampaignJobCreateRequest,
  CampaignRefPayload,
  DEFAULT_ADS_CAP_THB_DAY,
  DEFAULT_THB_PER_USD,
  FX_THB_PER_USD_KEY,
  AdkitJobCreateResponse,
  PanelCampaignsResponse,
  ThbPerDay,
  roleAtLeast,
  type AdminRequestContext,
  type CampaignJobKind,
  type PanelCampaign,
} from "@anjuna/contracts";
import { checkBudget } from "./ads-caps.js";
import { JOB_BODY_LIMIT, adminError, audit, parseBody, publicJob, type JobRow } from "./adkit.js";
import type { Env } from "./env.js";
import { json } from "./http.js";

/** An enable or budget job stays unclaimable this long while core re-checks the caps; a crash in between ends it. */
export const CAMPAIGN_HOLD_MS = 5 * 60 * 1000;

export interface AdsCaps { total_thb_day: number; brand_thb_day: number }

async function readSetting(db: D1Database, key: string): Promise<unknown> {
  const row = await db.prepare("SELECT value_json FROM panel_settings WHERE key = ?1").bind(key).first<{ value_json: string }>();
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

/** The caps, defaults when unset. A stored value that does not parse counts as 0, so nothing can be enabled. */
export async function readAdsCaps(db: D1Database): Promise<AdsCaps> {
  const cap = (raw: unknown) => (raw === undefined ? DEFAULT_ADS_CAP_THB_DAY : ThbPerDay.safeParse(raw).data ?? 0);
  const [total, brand] = await Promise.all([readSetting(db, ADS_CAP_TOTAL_KEY), readSetting(db, ADS_CAP_BRAND_KEY)]);
  return { total_thb_day: cap(total), brand_thb_day: cap(brand) };
}

async function readThbPerUsd(db: D1Database): Promise<number | null> {
  const raw = await readSetting(db, FX_THB_PER_USD_KEY);
  if (raw === undefined) return DEFAULT_THB_PER_USD;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 1000 ? raw : null;
}

/** Baht per one unit of the account currency, or null when core cannot convert it. */
type Rates = ((account: string) => number | null) & { currency: (account: string) => string | null };

async function loadRates(env: Env): Promise<Rates> {
  const [usd, { results }] = await Promise.all([
    readThbPerUsd(env.FACTORY),
    env.LEADS.prepare("SELECT id, currency FROM adkit_directory WHERE kind = 'account'").all<{ id: string; currency: string | null }>(),
  ]);
  const currency = new Map(results.map((r) => [r.id, r.currency]));
  const rate = (account: string) => {
    const c = currency.get(account);
    if (c === "THB") return 1;
    if (c === "USD") return usd;
    return null;
  };
  return Object.assign(rate, { currency: (account: string) => currency.get(account) ?? null });
}

export async function campaignIdempotencyKey(kind: CampaignJobKind, brandId: string, account: string, name: string, generation = 0): Promise<string> {
  const text = `${kind}|${brandId}|${account}|${name}${generation > 0 ? `|${generation}` : ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- state ------------------------------------------------------------------------------------------

interface Campaign {
  draft: JobRow;
  payload: CampaignDraftPayload;
  campaign_id: string | null;
  state: PanelCampaign["state"];
  /** Budget the campaign runs at: the last done budget job, else the draft budget. */
  budget: number;
  /** Budget for the caps: the larger of `budget` and any budget job still queued or claimed. */
  committedBudget: number;
  /** Counts toward the caps: enabled, or an enable job is still queued or claimed. */
  spending: boolean;
  updated_at: string;
  /** Finished (done or failed) jobs per kind, for the idempotency key generation. */
  finished: Record<string, number>;
}

const pending = (row: JobRow) => row.status === "queued" || row.status === "claimed";
const byCreated = (a: JobRow, b: JobRow) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);
const byUpdated = (a: JobRow, b: JobRow) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : byCreated(a, b));

async function loadCampaignJobs(env: Env): Promise<JobRow[]> {
  const { results } = await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE kind LIKE 'campaign.%' ORDER BY created_at, id").all<JobRow>();
  return results;
}

/** Every panel campaign, one per draft job, from the job rows alone. */
export function deriveCampaigns(rows: JobRow[]): Campaign[] {
  const campaigns: Campaign[] = [];
  const byId = new Map<string, Campaign>();
  for (const row of rows.filter((r) => r.kind === "campaign.draft.create").sort(byCreated)) {
    const payload = CampaignDraftPayload.parse(JSON.parse(row.payload));
    let campaignId: string | null = null;
    if (row.status === "done" && row.result) campaignId = (JSON.parse(row.result) as { campaign_id?: string }).campaign_id ?? null;
    const state = row.status === "done" ? "draft" : row.status === "failed" ? "failed" : "drafting";
    const c: Campaign = {
      draft: row, payload, campaign_id: campaignId, state, budget: payload.daily_budget, committedBudget: payload.daily_budget,
      spending: false, updated_at: row.updated_at, finished: {},
    };
    campaigns.push(c);
    if (campaignId && !byId.has(campaignId)) byId.set(campaignId, c);
  }
  const others = rows.filter((r) => r.kind !== "campaign.draft.create").sort(byUpdated);
  for (const row of others) {
    const ref = JSON.parse(row.payload) as { campaign_id?: string; daily_budget?: number };
    const c = ref.campaign_id ? byId.get(ref.campaign_id) : undefined;
    if (!c) continue;
    if (!pending(row)) c.finished[row.kind] = (c.finished[row.kind] ?? 0) + 1;
    if (row.updated_at > c.updated_at) c.updated_at = row.updated_at;
    if (row.status === "done" && row.kind === "campaign.enable") c.state = "enabled";
    if (row.status === "done" && row.kind === "campaign.pause") c.state = "paused";
    if (row.status === "done" && row.kind === "campaign.update_budget" && typeof ref.daily_budget === "number") c.budget = ref.daily_budget;
  }
  for (const c of campaigns) {
    c.committedBudget = c.budget;
    c.spending = c.state === "enabled";
    if (!c.campaign_id) continue;
    for (const row of others) {
      if (!pending(row) || (JSON.parse(row.payload) as { campaign_id?: string }).campaign_id !== c.campaign_id) continue;
      if (row.kind === "campaign.enable") {
        c.spending = true;
        if (c.state !== "enabled") c.state = "enabling";
      }
      if (row.kind === "campaign.update_budget") {
        c.committedBudget = Math.max(c.committedBudget, (JSON.parse(row.payload) as { daily_budget: number }).daily_budget);
      }
    }
  }
  return campaigns;
}

/** Baht per day the spending campaigns hold, in total and for one brand, leaving `skip` out. Null: a currency is unknown. */
function enabledThb(campaigns: Campaign[], rates: Rates, brandId: string, skip?: Campaign): { total: number; brand: number } | null {
  let total = 0;
  let brand = 0;
  for (const c of campaigns) {
    if (!c.spending || c === skip) continue;
    const rate = rates(c.payload.account);
    if (rate === null) return null;
    const thb = c.committedBudget * rate;
    total += thb;
    if (c.payload.brand_id === brandId) brand += thb;
  }
  return { total, brand };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- routes -----------------------------------------------------------------------------------------

interface BrandRuntimeRow { hostnames: string; google_ads_account: string | null; adkit_project: string | null }

const invalid = (context: AdminRequestContext, path: string, message: string) =>
  adminError(context, { error: "invalid", issues: [{ path, message }] });

function capRefusal(context: AdminRequestContext, reason: "brand_cap" | "total_cap", caps: AdsCaps, requestedThb: number): Response {
  const cap = reason === "brand_cap" ? `${ADS_CAP_BRAND_KEY} ${caps.brand_thb_day}` : `${ADS_CAP_TOTAL_KEY} ${caps.total_thb_day}`;
  return invalid(context, "daily_budget", `${reason}: ${round2(requestedThb)} THB/day is above ${cap} THB/day with the campaigns already enabled`);
}

/** GET /admin/adkit/campaigns. */
export async function listPanelCampaigns(env: Env): Promise<PanelCampaignsResponse> {
  const [rows, caps, rates] = await Promise.all([loadCampaignJobs(env), readAdsCaps(env.FACTORY), loadRates(env)]);
  const campaigns = deriveCampaigns(rows);
  let enabledTotal = 0;
  const items = campaigns.map((c): PanelCampaign => {
    const rate = rates(c.payload.account);
    const thb = rate === null ? null : round2(c.budget * rate);
    if (c.spending && rate !== null) enabledTotal += c.committedBudget * rate;
    return {
      draft_job_id: c.draft.id, campaign_id: c.campaign_id, brand_id: c.payload.brand_id, account: c.payload.account,
      name: c.payload.name, daily_budget: c.budget, currency: rates.currency(c.payload.account),
      daily_budget_thb: thb, state: c.state, updated_at: c.updated_at,
    };
  });
  return PanelCampaignsResponse.parse({ campaigns: items, caps, enabled_total_thb_day: round2(enabledTotal) });
}

/** POST /admin/adkit/campaign-jobs. 201 with the new row, 200 with the row the key already holds. */
export async function createCampaignJob(request: Request, env: Env, context: AdminRequestContext, nowMs = Date.now()): Promise<Response> {
  const body = await parseBody(request, CampaignJobCreateRequest, JOB_BODY_LIMIT);
  if (!body.ok) return adminError(context, { error: "invalid", issues: body.issues ?? [{ path: "body", message: body.message }] });
  const req = body.data;
  const role = CAMPAIGN_JOB_ROLES[req.kind];
  if (!roleAtLeast(context.actor_role, role.min_role)) {
    return adminError(context, { error: "forbidden_role", required_role: role.min_role, message: `${role.action} needs the ${role.min_role} role` });
  }

  const [rows, caps, rates] = await Promise.all([loadCampaignJobs(env), readAdsCaps(env.FACTORY), loadRates(env)]);
  const campaigns = deriveCampaigns(rows);
  const at = new Date(nowMs).toISOString();

  if (req.kind === "campaign.draft.create") {
    const brand = await env.LEADS.prepare("SELECT hostnames, google_ads_account, adkit_project FROM brand_runtime WHERE brand_id = ?1")
      .bind(req.brand_id).first<BrandRuntimeRow>();
    if (!brand) return adminError(context, { error: "not_found", resource: "brand", message: "No brand with this id" });
    if (!brand.google_ads_account) return invalid(context, "brand_id", "The brand has no Google Ads account");
    if (!req.name.startsWith(`${req.brand_id}-search-`)) return invalid(context, "name", `The name must start with ${req.brand_id}-search-`);
    const hostnames = JSON.parse(brand.hostnames) as string[];
    if (!hostnames.includes(new URL(req.final_url).hostname)) return invalid(context, "final_url", "The Final URL must be on a hostname of the brand");

    const payload = CampaignDraftPayload.parse({
      brand_id: req.brand_id, account: brand.google_ads_account, project: brand.adkit_project, name: req.name,
      daily_budget: req.daily_budget, bid_strategy: req.bid_strategy, geo: req.geo, keywords: req.keywords, final_url: req.final_url,
    });
    const key = await campaignIdempotencyKey(req.kind, payload.brand_id, payload.account, payload.name);
    const known = await findByKey(env, key);
    if (known) return json(AdkitJobCreateResponse.parse({ job: publicJob(known), created: false }), 200);

    const rate = rates(payload.account);
    if (rate === null) return invalid(context, "brand_id", "The Google Ads account currency is unknown or not THB or USD");
    const enabled = enabledThb(campaigns, rates, payload.brand_id);
    if (!enabled) return invalid(context, "daily_budget", "An enabled campaign has an account currency core cannot convert");
    const check = checkBudget({
      requested: payload.daily_budget * rate, capBrand: caps.brand_thb_day, capTotal: caps.total_thb_day,
      enabledTotalToday: enabled.total, enabledBrandToday: enabled.brand,
    });
    if (!check.ok) return capRefusal(context, check.reason, caps, payload.daily_budget * rate);
    return insertJob(env, context, req.kind, payload, key, at, null);
  }

  const c = campaigns.find((x) => x.campaign_id === req.campaign_id);
  if (!c) return adminError(context, { error: "not_found", resource: "campaign", message: "No panel campaign with this campaign_id" });
  const ref = CampaignRefPayload.parse({
    campaign_id: req.campaign_id, brand_id: c.payload.brand_id, account: c.payload.account, project: c.payload.project, name: c.payload.name,
  });
  const key = await campaignIdempotencyKey(req.kind, ref.brand_id, ref.account, ref.name, c.finished[req.kind] ?? 0);
  const known = await findByKey(env, key);
  if (known) return json(AdkitJobCreateResponse.parse({ job: publicJob(known), created: false }), 200);

  if (req.kind === "campaign.pause") {
    if (c.state !== "enabled") return conflict(context, c, "Only an enabled campaign can be paused");
    return insertJob(env, context, req.kind, ref, key, at, null);
  }
  if (req.kind === "campaign.enable" && (c.state === "enabled" || c.state === "enabling")) {
    return conflict(context, c, "The campaign is already enabled");
  }

  const payload = req.kind === "campaign.update_budget" ? CampaignBudgetPayload.parse({ ...ref, daily_budget: req.daily_budget }) : ref;
  const requested = req.kind === "campaign.update_budget" ? req.daily_budget : c.committedBudget;
  const rate = rates(ref.account);
  if (rate === null) return invalid(context, "campaign_id", "The Google Ads account currency is unknown or not THB or USD");
  const enabled = enabledThb(campaigns, rates, ref.brand_id, c);
  if (!enabled) return invalid(context, "daily_budget", "An enabled campaign has an account currency core cannot convert");
  const check = checkBudget({
    requested: requested * rate, capBrand: caps.brand_thb_day, capTotal: caps.total_thb_day,
    enabledTotalToday: enabled.total, enabledBrandToday: enabled.brand,
  });
  if (!check.ok) return capRefusal(context, check.reason, caps, requested * rate);
  return insertJob(env, context, req.kind, payload, key, at, new Date(nowMs + CAMPAIGN_HOLD_MS).toISOString(), ref.brand_id);
}

function conflict(context: AdminRequestContext, c: Campaign, message: string): Response {
  return adminError(context, { error: "conflict", current_updated_at: c.updated_at, message });
}

async function findByKey(env: Env, key: string): Promise<JobRow | null> {
  return env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE idempotency_key = ?1").bind(key).first<JobRow>();
}

/**
 * Insert one row (ON CONFLICT DO NOTHING keeps one per key). With `holdUntil`, the row is not claimable until the
 * caps are checked again over every row; a row that breaks a cap is failed before any executor sees it.
 */
async function insertJob(
  env: Env, context: AdminRequestContext, kind: CampaignJobKind, payload: object, key: string, at: string,
  holdUntil: string | null, recheckBrand?: string,
): Promise<Response> {
  const id = crypto.randomUUID();
  await env.LEADS.prepare(`
    INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, next_attempt_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'queued', NULL, 0, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT (idempotency_key) DO NOTHING`)
    .bind(id, kind, JSON.stringify(payload), key, context.actor_id, holdUntil, at).run();
  let row = await findByKey(env, key);
  if (!row) throw new Error("campaign job row missing after insert");
  if (row.id !== id) return json(AdkitJobCreateResponse.parse({ job: publicJob(row), created: false }), 200);

  if (holdUntil !== null && recheckBrand !== undefined) {
    const [rows, caps, rates] = await Promise.all([loadCampaignJobs(env), readAdsCaps(env.FACTORY), loadRates(env)]);
    const enabled = enabledThb(deriveCampaigns(rows), rates, recheckBrand);
    const check = enabled
      ? checkBudget({ requested: 0, capBrand: caps.brand_thb_day, capTotal: caps.total_thb_day, enabledTotalToday: enabled.total, enabledBrandToday: enabled.brand })
      : ({ ok: false, reason: "total_cap" } as const);
    if (!check.ok) {
      await env.LEADS.prepare(`
        UPDATE adkit_jobs SET status = 'failed', result = json_object('error', ?2), next_attempt_at = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'queued'`)
        .bind(id, `refused: ${check.reason} after a concurrent job`, at).run();
      await audit(env, { id: context.actor_id, role: context.actor_role }, "adkit.job.refused", id, { kind, reason: check.reason }, at);
      return capRefusal(context, check.reason, caps, enabled?.total ?? 0);
    }
    await env.LEADS.prepare("UPDATE adkit_jobs SET next_attempt_at = NULL WHERE id = ?1 AND status = 'queued'").bind(id).run();
    row = (await findByKey(env, key))!;
  }
  await audit(env, { id: context.actor_id, role: context.actor_role }, "adkit.job.create", id, { kind, ...payload }, at);
  return json(AdkitJobCreateResponse.parse({ job: publicJob(row), created: true }), 201);
}
