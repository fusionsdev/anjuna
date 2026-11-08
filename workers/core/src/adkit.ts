/**
 * AdKit directory and job queue (panel redesign T9, ADR-0005). Core never calls AdKit.
 *
 * VPS routes (drain token, Authorization header only):
 *   POST /api/adkit/directory/ingest  upsert projects, accounts and conversion actions
 *   GET  /api/adkit/jobs/pending      jobs the executor may claim now
 *   POST /api/adkit/jobs/claim        claim one job in one statement (two claims, one wins)
 *   POST /api/adkit/jobs/result       done, queued again after a backoff, or failed
 *
 * Admin routes (owner, dispatched from admin/index.ts): the directory reads and POST /admin/adkit/jobs.
 * The queue follows conversion-setup.ts: a claim has a lease, attempts count claims, failures back off.
 */
import {
  ADKIT_DIRECTORY_STALE_MS,
  ADKIT_JOB_LEASE_MS,
  ADKIT_JOB_MAX_ATTEMPTS,
  ADMIN_ERROR_STATUS,
  AdkitDirectoryIngestRequest,
  AdkitDirectoryIngestResponse,
  AdkitDirectoryResponse,
  AdkitJob,
  AdkitJobClaimRequest,
  AdkitJobClaimResponse,
  AdkitJobCreateRequest,
  AdkitJobCreateResponse,
  AdkitJobResultRequest,
  AdkitJobsPendingResponse,
  BrandProfile,
  ConversionActionCreatePayload,
  adkitJobBackoffMs,
  type AdkitDirectoryKind,
  type AdminError,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { drainAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import { json, unauthorized } from "./http.js";
import { recordCampaignBrand, type RecordCampaignBrand } from "./campaign-brand-map.js";
import { recheckHeldJobs } from "./campaign-jobs.js";

export const JOB_BODY_LIMIT = 4096;
const INGEST_BODY_LIMIT = 512 * 1024;
const PENDING_LIMIT = 50;

export interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: string;
  result: string | null;
  attempts: number;
  idempotency_key: string;
  requested_by: string;
  claim_id: string | null;
  claimed_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  /** Insert order (migration 0024), set in the INSERT by NEXT_SEQ. */
  seq: number;
}

/** The next insert order value, used inside an INSERT so it is atomic with the row (D1 runs one write at a time). */
export const NEXT_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM adkit_jobs)";

type Schema<T> = {
  safeParse(raw: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
};

const issuesOf = (issues: Array<{ path: PropertyKey[]; message: string }>) =>
  issues.map((i) => ({ path: i.path.map(String).join(".") || "body", message: i.message }));

type Parsed<T> = { ok: true; data: T } | { ok: false; status: number; message: string; issues?: Array<{ path: string; message: string }> };

export async function parseBody<T>(request: Request, schema: Schema<T>, limit: number): Promise<Parsed<T>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, status: 413, message: "Request body is too large" };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) return { ok: false, status: 413, message: "Request body is too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, message: "Invalid body", issues: issuesOf(parsed.error.issues) };
  return { ok: true, data: parsed.data };
}

/** VPS-facing error body: the same `{ status, message }` shape as conversion-setup.ts. */
const vpsError = (failure: Extract<Parsed<unknown>, { ok: false }>) =>
  json({ status: "invalid", message: failure.message, ...(failure.issues ? { issues: failure.issues } : {}) }, failure.status);

export function adminError(context: AdminRequestContext, error: AdminError): Response {
  return json({ ...error, request_id: context.request_id }, ADMIN_ERROR_STATUS[error.error]);
}

/** Rows a claim may take: queued and due, or claimed past the lease; attempts left either way. ?1 now, ?2 lease cutoff, ?3 max. */
const ELIGIBLE = `((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1))
    OR (status = 'claimed' AND claimed_at <= ?2))
  AND attempts < ?3`;

const leaseCutoff = (nowMs: number) => new Date(nowMs - ADKIT_JOB_LEASE_MS).toISOString();

export function publicJob(row: JobRow): AdkitJob {
  return AdkitJob.parse({
    id: row.id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload),
    result: row.result === null ? null : JSON.parse(row.result), attempts: row.attempts,
    idempotency_key: row.idempotency_key, requested_by: row.requested_by,
    next_attempt_at: row.status === "queued" ? row.next_attempt_at : null, // never set on a held row
    created_at: row.created_at, updated_at: row.updated_at,
  });
}

export async function audit(
  env: Env, actor: { id: string; role: string }, action: string, jobId: string, after: Record<string, unknown>, at: string,
): Promise<void> {
  await env.FACTORY.prepare(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (?1, ?2, ?3, 'adkit_job', ?4, NULL, ?5, ?6)`,
  ).bind(actor.id, actor.role, action, jobId, JSON.stringify(after), at).run();
}
const DRAIN_ACTOR = { id: "drain", role: "system" };

/** The done audit row, once per job. `onlyIfMissing` is the repair path of a repeated result. */
async function writeDoneAudit(env: Env, jobId: string, outcome: Record<string, unknown>, at: string, onlyIfMissing = false): Promise<void> {
  if (onlyIfMissing) {
    const existing = await env.FACTORY.prepare(
      "SELECT 1 FROM audit_log WHERE action = 'adkit.job.done' AND entity_type = 'adkit_job' AND entity_id = ?1",
    ).bind(jobId).first();
    if (existing) return;
  }
  await audit(env, DRAIN_ACTOR, "adkit.job.done", jobId, outcome, at);
}

// --- VPS routes ------------------------------------------------------------------------------------

/** POST /api/adkit/directory/ingest: upsert every item and stamp it now. */
export async function handleDirectoryIngest(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const body = await parseBody(request, AdkitDirectoryIngestRequest, INGEST_BODY_LIMIT);
  if (!body.ok) return vpsError(body);
  const at = new Date().toISOString();
  await env.LEADS.batch(body.data.items.map((item) => env.LEADS.prepare(`
    INSERT INTO adkit_directory (kind, id, parent_id, name, currency, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (kind, id) DO UPDATE SET
      parent_id = excluded.parent_id, name = excluded.name, currency = excluded.currency, updated_at = excluded.updated_at`)
    .bind(item.kind, item.id, item.parent_id, item.name, item.currency, at)));
  return json(AdkitDirectoryIngestResponse.parse({ status: "ok", upserted: body.data.items.length }));
}

/** GET /api/adkit/jobs/pending: fails crashed claims that used their last attempt, then lists claimable jobs. */
export async function handleJobsPending(request: Request, env: Env, nowMs = Date.now()): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const now = new Date(nowMs).toISOString();
  try {
    // A campaign job left held by a crash between its insert and its cap recheck is decided here, before listing.
    await recheckHeldJobs(env, nowMs);
  } catch (e) {
    console.error(`held job recheck failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  // A campaign enable or budget job that ran out of claims may have changed spend remotely: it ends 'unknown'.
  await env.LEADS.prepare(`
    UPDATE adkit_jobs SET status = CASE WHEN kind IN (${SPEND_KINDS}) THEN 'unknown' ELSE 'failed' END,
      result = json_object('error', 'claim lease expired on the last attempt'), updated_at = ?1
    WHERE status = 'claimed' AND claimed_at <= ?2 AND attempts >= ?3`)
    .bind(now, leaseCutoff(nowMs), ADKIT_JOB_MAX_ATTEMPTS).run();
  await queueStatusChecks(env, now);
  const { results } = await env.LEADS.prepare(`
    SELECT id, kind, payload, attempts FROM adkit_jobs WHERE ${ELIGIBLE}
    ORDER BY created_at, id LIMIT ${PENDING_LIMIT}`)
    .bind(now, leaseCutoff(nowMs), ADKIT_JOB_MAX_ATTEMPTS)
    .all<{ id: string; kind: string; payload: string; attempts: number }>();
  return json(AdkitJobsPendingResponse.parse({
    jobs: results.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
  }));
}

/** POST /api/adkit/jobs/claim: one UPDATE takes the job only while it is eligible, so a concurrent claim gets 409. */
export async function handleJobClaim(request: Request, env: Env, nowMs = Date.now()): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const body = await parseBody(request, AdkitJobClaimRequest, JOB_BODY_LIMIT);
  if (!body.ok) return vpsError(body);
  const now = new Date(nowMs).toISOString();
  const claimId = crypto.randomUUID();
  const claimed = await env.LEADS.prepare(`
    UPDATE adkit_jobs
    SET status = 'claimed', claim_id = ?4, claimed_at = ?1, attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?1
    WHERE id = ?5 AND ${ELIGIBLE}
    RETURNING id, kind, payload, attempts`)
    .bind(now, leaseCutoff(nowMs), ADKIT_JOB_MAX_ATTEMPTS, claimId, body.data.job_id)
    .first<{ id: string; kind: string; payload: string; attempts: number }>();
  if (!claimed) {
    // The claim decision is already made; this read only tells an unknown job from a busy or finished one.
    const row = await env.LEADS.prepare("SELECT status FROM adkit_jobs WHERE id = ?1").bind(body.data.job_id).first<{ status: string }>();
    return row ? json({ status: "busy", job_status: row.status }, 409) : json({ status: "invalid", message: "Unknown job_id" }, 404);
  }
  return json(AdkitJobClaimResponse.parse({
    status: "claimed", claim_id: claimId, job: { ...claimed, payload: JSON.parse(claimed.payload) },
  }));
}

const stale = () => json({ status: "stale" }, 409);

export interface JobResultDeps { recordCampaignBrand: RecordCampaignBrand }

/**
 * POST /api/adkit/jobs/result: record the outcome of the named claim. A repeated done result is a no-op 200.
 * `deps` lets tests observe or break the campaign_brand_map write.
 */
export async function handleJobResult(request: Request, env: Env, deps: JobResultDeps = { recordCampaignBrand }): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const body = await parseBody(request, AdkitJobResultRequest, JOB_BODY_LIMIT);
  if (!body.ok) return vpsError(body);
  const data = body.data;
  const at = new Date().toISOString();

  if ("result" in data && !("conversion_action_id" in data.result)) {
    return handleCampaignResult(env, data.job_id, data.claim_id, data.result, at, deps);
  }
  if ("result" in data && "conversion_action_id" in data.result) {
    const outcome = data.result;
    const resultJson = JSON.stringify(outcome);
    // The name check keeps a result from another job's action out of this one. The directory row lands in the same
    // batch and only when this claim's own result is the stored one, so a stale claim's result never writes it.
    const [jobWrite] = await env.LEADS.batch([
      env.LEADS.prepare(`
        UPDATE adkit_jobs SET status = 'done', result = ?3, next_attempt_at = NULL, updated_at = ?4
        WHERE id = ?1 AND claim_id = ?2 AND status = 'claimed' AND kind = 'conversion_action.create'
          AND json_extract(payload, '$.name') = ?5`)
        .bind(data.job_id, data.claim_id, resultJson, at, outcome.name),
      env.LEADS.prepare(`
        INSERT INTO adkit_directory (kind, id, parent_id, name, currency, updated_at)
        SELECT 'conversion_action', ?3, json_extract(payload, '$.account'), ?4, NULL, ?5
        FROM adkit_jobs WHERE id = ?1 AND claim_id = ?2 AND status = 'done' AND result = ?6 AND updated_at = ?5
        ON CONFLICT (kind, id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, updated_at = excluded.updated_at`)
        .bind(data.job_id, data.claim_id, outcome.conversion_action_id, outcome.name, at, resultJson),
    ]);
    if (jobWrite!.meta.changes) {
      await writeDoneAudit(env, data.job_id, outcome, at);
      return json({ status: "done" });
    }
    const row = await loadJob(env, data.job_id);
    if (!row) return json({ status: "invalid", message: "Unknown job_id" }, 404);
    if (row.status === "done") {
      // audit_log is in the FACTORY database, so it cannot share the LEADS batch. A repeat of the done result
      // writes the audit row if the first call stopped between the two databases.
      // Only the stored result repeats as a success; a different result for a done job is stale.
      if (row.result !== resultJson) return stale();
      if (row.claim_id === data.claim_id) await writeDoneAudit(env, data.job_id, outcome, row.updated_at, true);
      return json({ status: "done", already: true });
    }
    return stale();
  }

  if (!("error" in data)) return stale();
  const row = await loadJob(env, data.job_id);
  if (!row) return json({ status: "invalid", message: "Unknown job_id" }, 404);
  if (row.status !== "claimed" || row.claim_id !== data.claim_id) return stale();
  const retry = data.retryable !== false && row.attempts < ADKIT_JOB_MAX_ATTEMPTS;
  // A spend job (enable, budget) that may have written remotely ends 'unknown' and stays counted. Only `wrote: false`
  // from the executor (it failed before any create or update ran) lets it end 'failed'.
  const final = SPEND_KIND_LIST.includes(row.kind) && data.wrote !== false ? "unknown" : "failed";
  const nextAttemptAt = retry ? new Date(Date.now() + adkitJobBackoffMs(row.attempts)).toISOString() : null;
  const update = await env.LEADS.prepare(`
    UPDATE adkit_jobs
    SET status = ?3, result = ?4, claim_id = CASE WHEN ?3 = 'queued' THEN NULL ELSE claim_id END,
        claimed_at = CASE WHEN ?3 = 'queued' THEN NULL ELSE claimed_at END, next_attempt_at = ?5, updated_at = ?6
    WHERE id = ?1 AND claim_id = ?2 AND status = 'claimed' AND attempts = ?7`)
    .bind(data.job_id, data.claim_id, retry ? "queued" : final, JSON.stringify({ error: data.error }), nextAttemptAt, at, row.attempts)
    .run();
  if (!update.meta.changes) return stale();
  if (!retry) await audit(env, DRAIN_ACTOR, `adkit.job.${final}`, data.job_id, { error: data.error, attempts: row.attempts }, at);
  if (!retry && final === "unknown") await queueStatusChecks(env, at);
  return json({ status: retry ? "queued" : final });
}

/** Campaign kinds whose lost outcome may have changed what a live campaign spends. */
const SPEND_KIND_LIST = ["campaign.enable", "campaign.update_budget"];
const SPEND_KINDS = SPEND_KIND_LIST.map((k) => `'${k}'`).join(", ");

/**
 * One campaign.status_check per unknown job (key `campaign.status_check:<job id>`), so the executor lists the
 * campaign and core learns its real status and budget. Idempotent: ON CONFLICT DO NOTHING on the key.
 */
async function queueStatusChecks(env: Env, at: string): Promise<void> {
  const { results } = await env.LEADS.prepare(`
    SELECT u.id, u.payload FROM adkit_jobs u
    WHERE u.status = 'unknown' AND u.kind IN (${SPEND_KINDS})
      AND NOT EXISTS (SELECT 1 FROM adkit_jobs c WHERE c.idempotency_key = 'campaign.status_check:' || u.id)`)
    .all<{ id: string; payload: string }>();
  for (const row of results) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const ref = { campaign_id: p.campaign_id, brand_id: p.brand_id, account: p.account, project: p.project, name: p.name };
    await env.LEADS.prepare(`
      INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
      VALUES (?1, 'campaign.status_check', ?2, 'queued', NULL, 0, ?3, 'core', ?4, ?4, ${NEXT_SEQ})
      ON CONFLICT (idempotency_key) DO NOTHING`)
      .bind(crypto.randomUUID(), JSON.stringify(ref), `campaign.status_check:${row.id}`, at).run();
  }
}

type CampaignOutcome = Exclude<Extract<AdkitJobResultRequest, { result: unknown }>["result"], { conversion_action_id: string }>;

/**
 * A campaign job's result. The kind the result shape implies and the payload must match the claimed row: a draft
 * result carries the job's campaign name and budget, a status or budget result the job's campaign id (and budget).
 * So a result meant for another job, an adopt of a campaign with another budget, or an ENABLED result on a pause
 * job never marks this row done.
 */
async function handleCampaignResult(
  env: Env, jobId: string, claimId: string, outcome: CampaignOutcome, at: string, deps: JobResultDeps,
): Promise<Response> {
  // A done draft maps its campaign to the brand (source = 'create'). The job row is already done, so a failed map
  // write is logged and the result still answers done; the campaign then falls back to click mapping or the estimate.
  const recordMap = async (payloadJson: string) => {
    if (!("name" in outcome)) return;
    const payload = JSON.parse(payloadJson) as { account: string; brand_id: string };
    try {
      await deps.recordCampaignBrand(env.LEADS, { account: payload.account, campaign_id: outcome.campaign_id, brand_id: payload.brand_id });
    } catch (e) {
      console.error(`campaign_brand_map write failed for job ${jobId}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  };
  const resultJson = JSON.stringify(outcome);
  let kind: string;
  let guard: string;
  let guardValue: string | number;
  if ("name" in outcome) {
    kind = "campaign.draft.create";
    guard = "json_extract(payload, '$.name') = ?6 AND json_extract(payload, '$.daily_budget') = ?7";
    guardValue = outcome.name;
  } else if ("observed_status" in outcome) {
    kind = "campaign.status_check";
    guard = "json_extract(payload, '$.campaign_id') = ?6";
    guardValue = outcome.campaign_id;
  } else if ("status" in outcome) {
    kind = outcome.status === "ENABLED" ? "campaign.enable" : "campaign.pause";
    guard = "json_extract(payload, '$.campaign_id') = ?6";
    guardValue = outcome.campaign_id;
  } else {
    kind = "campaign.update_budget";
    guard = "json_extract(payload, '$.campaign_id') = ?6 AND json_extract(payload, '$.daily_budget') = ?7";
    guardValue = outcome.campaign_id;
  }
  const write = await env.LEADS.prepare(`
    UPDATE adkit_jobs SET status = 'done', result = ?3, next_attempt_at = NULL, updated_at = ?4
    WHERE id = ?1 AND claim_id = ?2 AND status = 'claimed' AND kind = ?5 AND ${guard}
    RETURNING payload`)
    .bind(jobId, claimId, resultJson, at, kind, guardValue,
      ...((kind === "campaign.update_budget" || kind === "campaign.draft.create") && "daily_budget" in outcome ? [outcome.daily_budget] : []))
    .first<{ payload: string }>();
  if (write) {
    await writeDoneAudit(env, jobId, outcome, at);
    await recordMap(write.payload);
    if (kind === "campaign.status_check") await requeueStaleStatusCheck(env, jobId, write.payload, at);
    return json({ status: "done" });
  }
  const row = await loadJob(env, jobId);
  if (!row) return json({ status: "invalid", message: "Unknown job_id" }, 404);
  if (row.status === "done" && row.result === resultJson) {
    if (row.claim_id === claimId) {
      await writeDoneAudit(env, jobId, outcome, row.updated_at, true);
      await recordMap(row.payload);
    }
    return json({ status: "done", already: true });
  }
  return stale();
}

/**
 * A status check is stale when an enable, pause or budget job of its campaign that may have written (done or
 * unknown) finished between the check's claim and its result: it may describe the campaign before that write.
 * deriveCampaigns ignores it (staleStatusCheck); this queues a fresh check (key `campaign.status_check:stale:<job id>`)
 * so core still learns the current state. The same rule on both sides, ties included.
 */
async function requeueStaleStatusCheck(env: Env, jobId: string, payload: string, at: string): Promise<void> {
  await env.LEADS.prepare(`
    INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
    SELECT ?1, 'campaign.status_check', ?2, 'queued', NULL, 0, ?3, 'core', ?4, ?4, ${NEXT_SEQ}
    WHERE EXISTS (
      SELECT 1 FROM adkit_jobs w
      WHERE w.status IN ('done', 'unknown') AND w.kind IN ('campaign.enable', 'campaign.pause', 'campaign.update_budget')
        AND json_extract(w.payload, '$.campaign_id') = json_extract(?2, '$.campaign_id')
        AND w.updated_at >= (SELECT COALESCE(claimed_at, '') FROM adkit_jobs WHERE id = ?5)
        AND w.updated_at <= ?4)
    ON CONFLICT (idempotency_key) DO NOTHING`)
    .bind(crypto.randomUUID(), payload, `campaign.status_check:stale:${jobId}`, at, jobId).run();
}

async function loadJob(env: Env, id: string): Promise<JobRow | null> {
  return env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// --- admin routes ----------------------------------------------------------------------------------

/** Fresh directory rows of one kind (and parent), newest sync time; rows older than 2 hours are left out. */
export async function loadAdkitDirectory(env: Env, kind: AdkitDirectoryKind, parentId: string | null): Promise<AdkitDirectoryResponse> {
  const cutoff = new Date(Date.now() - ADKIT_DIRECTORY_STALE_MS).toISOString();
  const { results } = await env.LEADS.prepare(`
    SELECT id, name, currency, updated_at FROM adkit_directory
    WHERE kind = ?1 AND (?2 IS NULL OR parent_id = ?2) AND updated_at > ?3
    ORDER BY name, id`)
    .bind(kind, parentId, cutoff)
    .all<{ id: string; name: string; currency: string | null; updated_at: string }>();
  const syncedAt = results.reduce<string | null>((max, row) => (max === null || row.updated_at > max ? row.updated_at : max), null);
  return AdkitDirectoryResponse.parse({ items: results, synced_at: syncedAt });
}

/** The draft's Google Ads account and AdKit project from its latest revision, or why there is none. */
async function draftAds(env: Env, brandId: string): Promise<{ account: string; project: string | null } | "missing" | "no_account"> {
  const row = await env.FACTORY.prepare(`
    SELECT r.config_json FROM brands b JOIN brand_revisions r ON r.brand_id = b.brand_id
    WHERE b.brand_id = ?1 AND b.status IN ('draft', 'failed')
    ORDER BY r.revision DESC LIMIT 1`).bind(brandId).first<{ config_json: string }>();
  if (!row) return "missing";
  let stored: unknown;
  try {
    stored = (JSON.parse(row.config_json) as { profile?: { ads?: unknown } }).profile?.ads;
  } catch {
    return "no_account";
  }
  // Only the ads group is read, so an older profile group that no longer parses does not block the job.
  const parsed = BrandProfile.shape.ads.safeParse(stored);
  const ads = parsed.success ? parsed.data : undefined;
  if (!ads?.google_ads_account) return "no_account";
  return { account: ads.google_ads_account, project: ads.adkit_project ?? null };
}

/** Opaque conversion name, fixed per job so a retried executor run adopts the action it created. */
function conversionName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `cv-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * POST /admin/adkit/jobs. The key is the client's or `<kind>:<brand_draft_id>`. INSERT ... ON CONFLICT DO NOTHING
 * keeps one row per key, and the answer is always that row: 201 when this call inserted it, 200 otherwise.
 */
export async function createAdkitJob(request: Request, env: Env, context: AdminRequestContext): Promise<Response> {
  const body = await parseBody(request, AdkitJobCreateRequest, JOB_BODY_LIMIT);
  if (!body.ok) {
    return adminError(context, { error: "invalid", issues: body.issues ?? [{ path: "body", message: body.message }] });
  }
  const { kind, brand_draft_id: brandId } = body.data;
  const key = body.data.idempotency_key ?? `${kind}:${brandId}`;

  // A known key answers its row before the draft is read, so a repeat after the brand left draft still finds the job.
  const existing = await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE idempotency_key = ?1").bind(key).first<JobRow>();
  if (existing) return existingJob(context, existing, kind, brandId);

  const ads = await draftAds(env, brandId);
  if (ads === "missing") return adminError(context, { error: "not_found", resource: "brand", message: "No draft brand with this id" });
  if (ads === "no_account") {
    return adminError(context, { error: "invalid", issues: [{ path: "brand_draft_id", message: "The draft has no Google Ads account" }] });
  }

  // A new key for the same draft and account keeps the earlier job's name, so the executor adopts the action that
  // job may already have created instead of making a second one.
  const prior = await env.LEADS.prepare(`
    SELECT json_extract(payload, '$.name') AS name FROM adkit_jobs
    WHERE kind = ?1 AND json_extract(payload, '$.brand_draft_id') = ?2 AND json_extract(payload, '$.account') = ?3
    ORDER BY created_at DESC, id DESC LIMIT 1`).bind(kind, brandId, ads.account).first<{ name: string }>();

  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const payload = ConversionActionCreatePayload.parse({
    brand_draft_id: brandId, account: ads.account, project: ads.project, name: prior?.name ?? conversionName(),
  });
  await env.LEADS.prepare(`
    INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
    VALUES (?1, ?2, ?3, 'queued', NULL, 0, ?4, ?5, ?6, ?6, ${NEXT_SEQ})
    ON CONFLICT (idempotency_key) DO NOTHING`)
    .bind(id, kind, JSON.stringify(payload), key, context.actor_id, at).run();
  const row = await env.LEADS.prepare("SELECT * FROM adkit_jobs WHERE idempotency_key = ?1").bind(key).first<JobRow>();
  if (!row) throw new Error("adkit job row missing after insert");
  if (row.id !== id) return existingJob(context, row, kind, brandId);
  await audit(env, { id: context.actor_id, role: context.actor_role }, "adkit.job.create", id, { kind, ...payload }, at);
  return json(AdkitJobCreateResponse.parse({ job: publicJob(row), created: true }), 201);
}

/** The row an idempotency key already holds: 200 with `created: false`, or 409 when the key names another job. */
function existingJob(context: AdminRequestContext, row: JobRow, kind: string, brandId: string): Response {
  const job = publicJob(row);
  if (job.kind !== kind || !("brand_draft_id" in job.payload) || job.payload.brand_draft_id !== brandId) {
    return adminError(context, { error: "conflict", current_updated_at: job.updated_at, message: "idempotency_key belongs to another job" });
  }
  return json(AdkitJobCreateResponse.parse({ job, created: false }), 200);
}
