/**
 * Campaign jobs (T13 Part B). The panel queues them on the T9 AdKit job queue; the VPS executor runs them.
 * Core never calls AdKit.
 *
 * Admin routes (dispatched from admin/index.ts):
 *   POST /admin/adkit/campaign-jobs  queue campaign.draft.create, .enable, .pause, .update_budget or .status_check
 *   GET  /admin/adkit/campaigns      panel campaigns derived from their jobs, with the caps
 *
 * Money rules:
 *   - A draft is created in AdKit without publish. campaign.enable is the only job that turns spend on.
 *   - Who may queue what: CAMPAIGN_JOB_ROLES (an employee may draft; enable, pause and budget are owner only).
 *   - Caps: ads_cap_total_thb_day and ads_cap_brand_thb_day (factory panel_settings, default 3000). checkBudget runs
 *     when the draft is made and again when it is enabled or its budget changes. "Enabled" counts every panel campaign
 *     whose last status job is a done enable, every enable job still held, queued or claimed, and every enable whose
 *     outcome is unknown until a status check or a confirmed pause resolves it. A budget counts at the largest of the
 *     done budget and any pending or unknown budget job.
 *   - A campaign.status_check result confirms the status. It resolves an unknown budget only when it read a budget
 *     (daily_budget not null). Order is the job event counter (claim_seq, result_seq; migration 0025), never a
 *     clock. Its status is ignored when an enable or pause job of its campaign that may have written (done or
 *     unknown) got its result between the check's claim and result; its budget is ignored when a budget job did.
 *     Core then queues a fresh check (adkit.ts requeueStaleStatusCheck). Per field, a check claimed earlier never
 *     overrides one claimed later.
 *   - A budget is in the account currency (adkit_directory). THB counts as is, USD is converted with fx_thb_per_usd,
 *     any other or unknown currency is refused.
 *   - Two owner requests at the same moment could each pass the check before the other's row exists. An enable or
 *     budget job is therefore inserted with status 'held'. The claim query only matches 'queued' and 'claimed', so a
 *     held row is never claimable, whatever the clock says. Only a cap recheck releases it ('queued') or refuses it
 *     ('failed'). The recheck of a held row counts every non-held row plus the held rows inserted before it (smaller
 *     seq, migration 0024; seq is set inside the INSERT, so it is the insert order whatever created_at or the id say).
 *     The recheck snapshot is read after the row's own insert, so of two rows the later-inserted one always counts
 *     the other. The release UPDATE runs only while the campaign job rows still match the snapshot (compare and set
 *     on a fingerprint of id, status, updated_at and seq); a mismatch reads again, at most RECHECK_TRIES times.
 *     A crash, a D1 error or a recheck that never settles leaves the row held; the next GET /api/adkit/jobs/pending
 *     rechecks every held row (recheckHeldJobs, in seq order) before it lists anything.
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
import { JOB_BODY_LIMIT, NEXT_EVENT, NEXT_SEQ, adminError, audit, parseBody, publicJob, type JobRow } from "./adkit.js";
import type { Env } from "./env.js";
import { json } from "./http.js";

/** Test seams around the insert of a held row. Production passes none. */
export interface CampaignJobHooks {
  /** After the first cap check, before the INSERT. */
  afterPrecheck?: () => Promise<void>;
  /** After the INSERT of a held row, before its recheck. A throw here is a crash between the two. */
  beforeRecheck?: () => Promise<void>;
  /** Inside the recheck: after the snapshot read, before the release UPDATE. */
  beforeRelease?: () => Promise<void>;
  /** The new row's id (default crypto.randomUUID()). */
  newId?: () => string;
}

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
  /** Budget for the caps: the larger of `budget` and any budget job still pending or unknown. */
  committedBudget: number;
  /** Counts toward the caps: enabled, an enable job still pending, or an enable whose outcome is unknown. */
  spending: boolean;
  updated_at: string;
  /** Finished (done or failed) jobs per kind, for the idempotency key generation. */
  finished: Record<string, number>;
}

const pending = (row: JobRow) => row.status === "queued" || row.status === "claimed" || row.status === "held";
const byCreated = (a: JobRow, b: JobRow) =>
  (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/**
 * Event order of results (migration 0025 result_seq); rows without one sort by updated_at among themselves. A NULL
 * result_seq is read as 0 and sorts FIRST. For a pending row that is harmless (it is never applied). For a done
 * write recorded by the old core after 0025 was applied, it is the hazard: an old-core done enable would sort before
 * a backfilled pause and the campaign would stop counting. Hence scripts/drain/README.md "Deploy 0025": stop the
 * adkit executor on hstgr and maimax and verify it stopped before applying 0025, deploy core, and restart it only when
 * the NULL-row gate counts 0. No SQL repair exists (renumbering an old result can apply it after newer ones); a
 * non-zero count leaves the executor stopped, sets ads_cap_total_thb_day to 0 and goes to the owner.
 */
const byResult = (a: JobRow, b: JobRow) => ((a.result_seq ?? 0) - (b.result_seq ?? 0))
  || (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : byCreated(a, b));

const CAMPAIGN_ROWS = "SELECT * FROM adkit_jobs WHERE kind LIKE 'campaign.%' ORDER BY created_at, id";
/** One string that changes whenever a campaign job row is inserted or changes status (compare and set). */
const CAMPAIGN_FINGERPRINT = `(SELECT COALESCE(group_concat(f, ','), '') FROM (
  SELECT id || ':' || status || ':' || updated_at || ':' || seq AS f FROM adkit_jobs WHERE kind LIKE 'campaign.%' ORDER BY seq, id))`;
const RECHECK_TRIES = 5;

async function loadCampaignJobs(env: Env): Promise<JobRow[]> {
  const { results } = await env.LEADS.prepare(CAMPAIGN_ROWS).all<JobRow>();
  return results;
}

/** The rows and their fingerprint from one read transaction (a D1 batch), so the two always agree. */
async function loadCampaignSnapshot(env: Env): Promise<{ rows: JobRow[]; fingerprint: string }> {
  const [rows, fp] = await env.LEADS.batch([
    env.LEADS.prepare(CAMPAIGN_ROWS),
    env.LEADS.prepare(`SELECT ${CAMPAIGN_FINGERPRINT} AS fp`),
  ]);
  return { rows: rows!.results as JobRow[], fingerprint: (fp!.results[0] as { fp: string }).fp };
}

/**
 * Every panel campaign, one per draft job, from the job rows alone. `heldUpTo` is the held row being rechecked:
 * held rows inserted after it (larger seq) are left out, so the recheck order is the insert order.
 */
export function deriveCampaigns(allRows: JobRow[], options: { heldUpTo?: JobRow } = {}): Campaign[] {
  const cutoff = options.heldUpTo;
  const rows = cutoff ? allRows.filter((r) => r.status !== "held" || r.seq <= cutoff.seq) : allRows;
  const campaigns: Campaign[] = [];
  const byId = new Map<string, Campaign>();
  for (const row of rows.filter((r) => r.kind === "campaign.draft.create").sort(byCreated)) {
    const payload = CampaignDraftPayload.parse(JSON.parse(row.payload));
    let campaignId: string | null = null;
    const result = row.status === "done" && row.result ? JSON.parse(row.result) as { campaign_id?: string; status?: string } : null;
    if (result) campaignId = result.campaign_id ?? null;
    // A draft result reports what AdKit holds: DRAFT for a new campaign, PAUSED for an adopted paused one.
    const state = row.status === "done" ? (result?.status === "PAUSED" ? "paused" : "draft")
      : row.status === "failed" ? "failed" : "drafting";
    const c: Campaign = {
      draft: row, payload, campaign_id: campaignId, state, budget: payload.daily_budget, committedBudget: payload.daily_budget,
      spending: false, updated_at: row.updated_at, finished: {},
    };
    campaigns.push(c);
    if (campaignId && !byId.has(campaignId)) byId.set(campaignId, c);
  }
  // Done rows set the state and budget in result order (result_seq, the event counter; no clock).
  const others = rows.filter((r) => r.kind !== "campaign.draft.create").sort(byResult);
  // A status check describes the campaign as it was when it was claimed. Its status and its budget are judged
  // separately (checkStaleness, on claim_seq and result_seq): an enable or pause job that may have written (done or
  // unknown) and got its result inside the check's window makes the status stale; a budget job does that to the
  // budget only. So a budget job never erases ENABLED evidence. Per field, a check with a later claim_seq that read
  // the field wins: an older read never overrides a newer one, and a check that read no budget leaves the budget be.
  const writes = writesByCampaign(rows);
  const lastStatusClaim = new Map<Campaign, number>();
  const lastBudgetClaim = new Map<Campaign, number>();
  /** Which parts of each done status check stand (not stale); used to resolve unknown jobs. */
  const checkParts = new Map<JobRow, { status: boolean; budget: boolean }>();
  const unknowns = new Map<Campaign, JobRow[]>();
  const dones = new Map<Campaign, JobRow[]>();
  for (const row of others) {
    const ref = JSON.parse(row.payload) as { campaign_id?: string; daily_budget?: number };
    const c = ref.campaign_id ? byId.get(ref.campaign_id) : undefined;
    if (!c) continue;
    if (!pending(row)) c.finished[row.kind] = (c.finished[row.kind] ?? 0) + 1;
    if (row.updated_at > c.updated_at) c.updated_at = row.updated_at;
    if (row.status === "unknown") unknowns.set(c, [...(unknowns.get(c) ?? []), row]);
    if (row.status !== "done") continue;
    dones.set(c, [...(dones.get(c) ?? []), row]);
    if (row.kind === "campaign.enable") c.state = "enabled";
    if (row.kind === "campaign.pause") c.state = "paused";
    if (row.kind === "campaign.update_budget" && typeof ref.daily_budget === "number") c.budget = ref.daily_budget;
    if (row.kind === "campaign.status_check" && row.result) {
      const seen = JSON.parse(row.result) as { observed_status: string; daily_budget: number | null };
      const stale = checkStaleness(row, writes.get(ref.campaign_id!) ?? []);
      checkParts.set(row, { status: !stale.status, budget: !stale.budget && typeof seen.daily_budget === "number" });
      const claimed = row.claim_seq ?? 0;
      if (!stale.status && claimed >= (lastStatusClaim.get(c) ?? 0)) {
        lastStatusClaim.set(c, claimed);
        c.state = seen.observed_status === "ENABLED" ? "enabled" : seen.observed_status === "PAUSED" ? "paused"
          : seen.observed_status === "DRAFT" ? "draft" : "removed";
      }
      if (!stale.budget && typeof seen.daily_budget === "number" && claimed >= (lastBudgetClaim.get(c) ?? 0)) {
        lastBudgetClaim.set(c, claimed);
        c.budget = seen.daily_budget;
      }
    }
  }
  // An unknown enable or budget stays open (counted) until a done row resolves it: a status check claimed after it
  // became unknown (claim_seq above its result_seq), or a pause or enable (for an enable) or a budget job (for a
  // budget) inserted after it. Insert
  // order (seq) is used because a job is always inserted after the job it follows. A status check that could not read
  // the budget (daily_budget null) confirms the status only: it never resolves an unknown budget job.
  // A check resolves an unknown only with a part that stands: its status for an enable, a read budget for a budget.
  const resolves = (u: JobRow, r: JobRow) => (r.kind === "campaign.status_check"
    ? (r.claim_seq ?? 0) > (u.result_seq ?? 0)
      && (u.kind === "campaign.enable" ? checkParts.get(r)?.status === true : checkParts.get(r)?.budget === true)
    : u.kind === "campaign.enable" ? (r.kind === "campaign.pause" || r.kind === "campaign.enable") && r.seq > u.seq
      : r.kind === "campaign.update_budget" && r.seq > u.seq);
  for (const c of campaigns) {
    const open = (unknowns.get(c) ?? []).filter((u) => !(dones.get(c) ?? []).some((r) => resolves(u, r)));
    const openEnable = open.some((u) => u.kind === "campaign.enable");
    const openBudgets = open.filter((u) => u.kind === "campaign.update_budget")
      .map((u) => (JSON.parse(u.payload) as { daily_budget: number }).daily_budget);
    c.committedBudget = Math.max(c.budget, ...openBudgets);
    c.spending = c.state === "enabled" || openEnable;
    if (openEnable && c.state !== "enabled") c.state = "unknown";
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

const WRITE_KINDS = new Set(["campaign.enable", "campaign.pause", "campaign.update_budget"]);

/**
 * Per campaign id, the result_seq of every enable, pause or budget job that may have written: done, or unknown (its
 * outcome was lost after the write may have run).
 */
export function writesByCampaign(rows: JobRow[]): Map<string, Array<{ kind: string; seq: number }>> {
  const writes = new Map<string, Array<{ kind: string; seq: number }>>();
  for (const row of rows) {
    if ((row.status !== "done" && row.status !== "unknown") || !WRITE_KINDS.has(row.kind)) continue;
    const id = (JSON.parse(row.payload) as { campaign_id?: string }).campaign_id;
    if (id) writes.set(id, [...(writes.get(id) ?? []), { kind: row.kind, seq: row.result_seq ?? 0 }]);
  }
  return writes;
}

/**
 * Which parts of a done status check are stale. A write of its campaign that got its result between the check's
 * claim and its result (claim_seq < write result_seq < check result_seq) may have
 * changed what the check read: an enable or pause makes the status stale, a budget job the budget. A write that got
 * its result after the check's result is applied after it anyway. The counter is unique per statement; one
 * lease-expiry UPDATE that ends several rows may give them one shared value, all of them unknown or failed writes,
 * never a check, so a tie never sits on a window edge. A check whose claim_seq is NULL (claimed by the old core
 * during the deploy gap) reads as 0, so every earlier write falls in its window and its ENABLED evidence is dropped:
 * stopping and verifying the executor before 0025 (scripts/drain/README.md "Deploy 0025") is the only guard; no SQL
 * repair exists.
 */
export function checkStaleness(row: JobRow, writes: Array<{ kind: string; seq: number }>): { status: boolean; budget: boolean } {
  const inside = writes.filter((w) => (row.claim_seq ?? 0) < w.seq && w.seq < (row.result_seq ?? 0));
  return {
    status: inside.some((w) => w.kind === "campaign.enable" || w.kind === "campaign.pause"),
    budget: inside.some((w) => w.kind === "campaign.update_budget"),
  };
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
export async function createCampaignJob(
  request: Request, env: Env, context: AdminRequestContext, nowMs = Date.now(), hooks: CampaignJobHooks = {},
): Promise<Response> {
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
    return insertJob(env, context, req.kind, payload, key, at, false);
  }

  const c = campaigns.find((x) => x.campaign_id === req.campaign_id);
  if (!c) return adminError(context, { error: "not_found", resource: "campaign", message: "No panel campaign with this campaign_id" });
  const ref = CampaignRefPayload.parse({
    campaign_id: req.campaign_id, brand_id: c.payload.brand_id, account: c.payload.account, project: c.payload.project, name: c.payload.name,
  });
  const key = await campaignIdempotencyKey(req.kind, ref.brand_id, ref.account, ref.name, c.finished[req.kind] ?? 0);
  const known = await findByKey(env, key);
  if (known && req.kind === "campaign.update_budget"
    && (JSON.parse(known.payload) as { daily_budget: number }).daily_budget !== req.daily_budget) {
    // The key holds a pending budget job with another amount: answering it with 200 would drop the new amount.
    return adminError(context, {
      error: "conflict", current_updated_at: known.updated_at,
      message: pendingBudgetMessage(known),
    });
  }
  if (known) return json(AdkitJobCreateResponse.parse({ job: publicJob(known), created: false }), 200);

  if (req.kind === "campaign.status_check") return insertJob(env, context, req.kind, ref, key, at, false);
  if (req.kind === "campaign.pause") {
    if (c.state !== "enabled" && c.state !== "unknown") return conflict(context, c, "Only an enabled campaign can be paused");
    return insertJob(env, context, req.kind, ref, key, at, false);
  }
  if (req.kind === "campaign.enable" && (c.state === "enabled" || c.state === "enabling" || c.state === "unknown")) {
    return conflict(context, c, c.state === "unknown"
      ? "The last enable has an unknown outcome; wait for its status check or pause the campaign"
      : "The campaign is already enabled");
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
  await hooks.afterPrecheck?.();
  return insertJob(env, context, req.kind, payload, key, at, true, hooks);
}

const pendingBudgetMessage = (row: JobRow) =>
  `A budget change is still pending (job ${row.id}, status ${row.status}); wait for it before another amount`;

function conflict(context: AdminRequestContext, c: Campaign, message: string): Response {
  return adminError(context, { error: "conflict", current_updated_at: c.updated_at, message });
}

async function findByKey(env: Env, key: string): Promise<JobRow | null> {
  return env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE idempotency_key = ?1").bind(key).first<JobRow>();
}

type Recheck = { outcome: "released" } | { outcome: "refused"; reason: "brand_cap" | "total_cap"; caps: AdsCaps; enabledThb: number }
  | { outcome: "gone" } | { outcome: "unsettled" };

/**
 * Recheck one held row: every non-held row plus the held rows inserted up to it (seq) must stay within both caps.
 * The release UPDATE moves the row only while it is still held and the campaign rows still match the snapshot
 * fingerprint, so a row inserted or changed after the read sends the recheck round again. After RECHECK_TRIES
 * rounds the row stays held ("unsettled") for the next pending poll.
 */
async function recheckHeldJob(env: Env, jobId: string, at: string, hooks: CampaignJobHooks = {}): Promise<Recheck> {
  for (let round = 0; round < RECHECK_TRIES; round++) {
    const [{ rows, fingerprint }, caps, rates] = await Promise.all([loadCampaignSnapshot(env), readAdsCaps(env.FACTORY), loadRates(env)]);
    const job = rows.find((r) => r.id === jobId);
    if (!job || job.status !== "held") return { outcome: "gone" };
    const brandId = (JSON.parse(job.payload) as { brand_id: string }).brand_id;
    const enabled = enabledThb(deriveCampaigns(rows, { heldUpTo: job }), rates, brandId);
    const check = enabled
      ? checkBudget({ requested: 0, capBrand: caps.brand_thb_day, capTotal: caps.total_thb_day, enabledTotalToday: enabled.total, enabledBrandToday: enabled.brand })
      : ({ ok: false, reason: "total_cap" } as const);
    if (!check.ok) {
      await env.LEADS.prepare(`
        UPDATE adkit_jobs SET status = 'failed', result = json_object('error', ?2), updated_at = ?3, result_seq = ${NEXT_EVENT}
        WHERE id = ?1 AND status = 'held'`)
        .bind(jobId, `refused: ${check.reason} on the cap recheck`, at).run();
      await audit(env, { id: "core", role: "system" }, "adkit.job.refused", jobId, { kind: job.kind, reason: check.reason }, at);
      return { outcome: "refused", reason: check.reason, caps, enabledThb: enabled?.total ?? 0 };
    }
    await hooks.beforeRelease?.();
    const released = await env.LEADS.prepare(`
      UPDATE adkit_jobs SET status = 'queued', updated_at = ?2
      WHERE id = ?1 AND status = 'held' AND ${CAMPAIGN_FINGERPRINT} = ?3`)
      .bind(jobId, at, fingerprint).run();
    if (released.meta.changes) return { outcome: "released" };
  }
  return { outcome: "unsettled" };
}

/**
 * Recheck every held row, oldest first. GET /api/adkit/jobs/pending calls it before listing, so a row left held by
 * a crash is decided before any executor can see it. A D1 error leaves the rest held for the next call.
 */
export async function recheckHeldJobs(env: Env, nowMs = Date.now()): Promise<void> {
  const { results } = await env.LEADS.prepare("SELECT id FROM adkit_jobs WHERE status = 'held' ORDER BY seq, created_at, id").all<{ id: string }>();
  const at = new Date(nowMs).toISOString();
  for (const { id } of results) await recheckHeldJob(env, id, at);
}

/**
 * Insert one row (ON CONFLICT DO NOTHING keeps one per key). A `held` row is not claimable until its cap recheck
 * releases it; a row that breaks a cap is failed before any executor sees it, and the caller gets 422.
 */
async function insertJob(
  env: Env, context: AdminRequestContext, kind: CampaignJobKind, payload: object, key: string, at: string,
  held: boolean, hooks: CampaignJobHooks = {},
): Promise<Response> {
  const id = hooks.newId?.() ?? crypto.randomUUID();
  await env.LEADS.prepare(`
    INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, next_attempt_at, created_at, updated_at, seq)
    VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?6, NULL, ?7, ?7, ${NEXT_SEQ})
    ON CONFLICT (idempotency_key) DO NOTHING`)
    .bind(id, kind, JSON.stringify(payload), held ? "held" : "queued", key, context.actor_id, at).run();
  let row = await findByKey(env, key);
  if (!row) throw new Error("campaign job row missing after insert");
  if (row.id !== id) {
    // A concurrent request with the same key won the INSERT. For a budget with another amount, answering 200 with
    // that row would drop this amount, so it is 409 (the same answer as a key found before the insert).
    if (kind === "campaign.update_budget"
      && (JSON.parse(row.payload) as { daily_budget: number }).daily_budget !== (payload as { daily_budget: number }).daily_budget) {
      return adminError(context, { error: "conflict", current_updated_at: row.updated_at, message: pendingBudgetMessage(row) });
    }
    return json(AdkitJobCreateResponse.parse({ job: publicJob(row), created: false }), 200);
  }
  await audit(env, { id: context.actor_id, role: context.actor_role }, "adkit.job.create", id, { kind, ...payload }, at);

  if (held) {
    await hooks.beforeRecheck?.();
    let recheck: Recheck | null = null;
    try {
      recheck = await recheckHeldJob(env, id, at, hooks);
    } catch (e) {
      // The row stays held and unclaimable; the next pending poll rechecks it.
      console.error(`cap recheck failed for job ${id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    if (recheck?.outcome === "refused") {
      return invalid(context, "daily_budget",
        `${recheck.reason}: the campaigns already enabled or queued hold ${round2(recheck.enabledThb)} THB/day, above `
        + `${ADS_CAP_TOTAL_KEY} ${recheck.caps.total_thb_day} or ${ADS_CAP_BRAND_KEY} ${recheck.caps.brand_thb_day}`);
    }
    row = (await findByKey(env, key))!;
  }
  return json(AdkitJobCreateResponse.parse({ job: publicJob(row), created: true }), 201);
}
