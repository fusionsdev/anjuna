/**
 * Auto-created Google Ads conversion action (FUS-384). The VPS conversion-sync job lists brands that
 * need an action (`pending`), claims one (`claim`), creates it in Google Ads and reports the id or
 * an error (`result`). The panel reads one brand's state through GET /admin/brands/:id/conversion-setup.
 */
import {
  CONVERSION_SETUP_LEASE_MS,
  CONVERSION_SETUP_MAX_ATTEMPTS,
  ConversionSetupClaimRequest,
  ConversionSetupClaimResponse,
  ConversionSetupPendingResponse,
  ConversionSetupResultRequest,
  ConversionSetupStateResponse,
  conversionSetupBackoffMs,
} from "@anjuna/contracts";
import { drainAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import { json, unauthorized } from "./http.js";

const BODY_LIMIT = 4096;

interface SetupRow {
  brand_id: string;
  account: string;
  name: string;
  status: "claimed" | "created" | "failed";
  claim_id: string;
  claimed_at: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  conversion_action_id: string | null;
  updated_at: string;
}

/**
 * One statement: insert the first claim, or take over an existing row that is eligible (account
 * changed, crashed claim older than the lease, failed row past its backoff with attempts left, or
 * a created row whose brand lost its action). A changed account restarts the row with the proposed
 * name and attempts 0. RETURNING is empty when the brand is unknown, does not need an action or
 * holds a live claim. Parameters: 1 brand_id, 2 name, 3 claim_id, 4 now, 5 stale cutoff, 6 max attempts.
 */
const CLAIM_SQL = `
  INSERT INTO conversion_setup
    (brand_id, account, name, status, claim_id, claimed_at, attempts, next_attempt_at, last_error, conversion_action_id, updated_at)
  SELECT brand_id, google_ads_account, ?2, 'claimed', ?3, ?4, 0, NULL, NULL, NULL, ?4
  FROM brand_runtime
  WHERE brand_id = ?1 AND google_ads_account IS NOT NULL AND google_conversion_action IS NULL
  ON CONFLICT (brand_id) DO UPDATE SET
    name = CASE WHEN conversion_setup.account = excluded.account THEN conversion_setup.name ELSE excluded.name END,
    attempts = CASE WHEN conversion_setup.account = excluded.account THEN conversion_setup.attempts ELSE 0 END,
    account = excluded.account,
    status = 'claimed',
    claim_id = excluded.claim_id,
    claimed_at = excluded.claimed_at,
    next_attempt_at = NULL,
    last_error = NULL,
    conversion_action_id = NULL,
    updated_at = excluded.updated_at
  WHERE conversion_setup.account != excluded.account
     OR conversion_setup.status = 'created'
     OR (conversion_setup.status = 'claimed' AND conversion_setup.claimed_at <= ?5)
     OR (conversion_setup.status = 'failed' AND conversion_setup.next_attempt_at <= ?4
         AND conversion_setup.attempts < ?6)
  RETURNING name, account`;

const invalid = (message: string, extra: Record<string, unknown> = {}, status = 400) =>
  json({ status: "invalid", message, ...extra }, status);

/** Same rule as the panel PATCH: strictly after the previous value so the row always moves forward. */
function nextTimestamp(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

type Body<T> = { ok: true; data: T } | { ok: false; response: Response };

async function readBody<T>(
  request: Request,
  schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
): Promise<Body<T>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return { ok: false, response: invalid("Request body is too large", {}, 413) };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > BODY_LIMIT) return { ok: false, response: invalid("Request body is too large", {}, 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: invalid("Invalid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: invalid("Invalid body", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "body", message: i.message })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** GET /api/conversions/setup/pending: every brand that may be claimed now, ordered by brand_id. */
export async function handleSetupPending(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const now = new Date();
  const { results } = await env.LEADS.prepare(`
    SELECT b.brand_id AS brand_id, b.google_ads_account AS account, b.adkit_project AS project,
           CASE WHEN s.account = b.google_ads_account THEN s.name END AS name
    FROM brand_runtime b
    LEFT JOIN conversion_setup s ON s.brand_id = b.brand_id
    WHERE b.google_ads_account IS NOT NULL AND b.google_conversion_action IS NULL
      AND (s.brand_id IS NULL
        OR s.account != b.google_ads_account
        OR s.status = 'created'
        OR (s.status = 'claimed' AND s.claimed_at <= ?1)
        OR (s.status = 'failed' AND s.next_attempt_at <= ?2 AND s.attempts < ?3))
    ORDER BY b.brand_id`)
    .bind(new Date(now.getTime() - CONVERSION_SETUP_LEASE_MS).toISOString(), now.toISOString(), CONVERSION_SETUP_MAX_ATTEMPTS)
    .all<{ brand_id: string; account: string; project: string | null; name: string | null }>();
  return json(ConversionSetupPendingResponse.parse({ brands: results }));
}

/** POST /api/conversions/setup/claim: store the name before any create, answer the claim id. */
export async function handleSetupClaim(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const body = await readBody(request, ConversionSetupClaimRequest);
  if (!body.ok) return body.response;
  const { brand_id, name } = body.data;

  const now = new Date();
  const claimId = crypto.randomUUID();
  const { results } = await env.LEADS.prepare(CLAIM_SQL)
    .bind(
      brand_id, name, claimId, now.toISOString(),
      new Date(now.getTime() - CONVERSION_SETUP_LEASE_MS).toISOString(), CONVERSION_SETUP_MAX_ATTEMPTS,
    )
    .all<{ name: string; account: string }>();

  // The claim decision is already made; this read only tells an unknown brand from a busy one.
  const brand = await env.LEADS.prepare("SELECT adkit_project FROM brand_runtime WHERE brand_id = ?1")
    .bind(brand_id).first<{ adkit_project: string | null }>();
  if (!brand) return invalid("Unknown brand_id", {}, 404);
  const claimed = results[0];
  if (!claimed) return json({ status: "busy" }, 409);
  return json(ConversionSetupClaimResponse.parse({
    status: "claimed", claim_id: claimId, name: claimed.name, account: claimed.account, project: brand.adkit_project,
  }));
}

const stale = () => json({ status: "stale" }, 409);

async function writeDrainAudit(
  env: Env,
  action: "brand.conversion_create" | "brand.conversion_create_failed",
  brandId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  at: string,
): Promise<void> {
  await env.FACTORY.prepare(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES ('drain', 'system', ?1, 'brand', ?2, ?3, ?4, ?5)`,
  ).bind(action, brandId, before === null ? null : JSON.stringify(before), JSON.stringify(after), at).run();
}

const MAX_VERSION_TRIES = 3;

/** Test seams around the id-result batch; the router passes none. */
export interface ResultHooks {
  beforeBatch?: () => Promise<void>;
  afterBatch?: () => Promise<void>;
}

/** POST /api/conversions/setup/result: record the created id or the failure of a claim. */
export async function handleSetupResult(request: Request, env: Env, hooks: ResultHooks = {}): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();
  const body = await readBody(request, ConversionSetupResultRequest);
  if (!body.ok) return body.response;
  const data = body.data;

  const brand = await env.LEADS.prepare("SELECT updated_at FROM brand_runtime WHERE brand_id = ?1")
    .bind(data.brand_id).first<{ updated_at: string }>();
  if (!brand) return invalid("Unknown brand_id", {}, 404);

  if ("conversion_action_id" in data) {
    const id = data.conversion_action_id;
    let updatedAt = brand.updated_at;
    for (let attempt = 1; ; attempt++) {
      const at = nextTimestamp(updatedAt);
      await hooks.beforeBatch?.();
      // The brand write runs first so its guard still sees the claim as 'claimed'. It needs the claim
      // to match, the action to be NULL, the brand account to equal the claimed account and updated_at
      // to still be the value read above (a panel save in between moves it).
      // The setup write proceeds when the brand write landed or when the brand truly fails the NULL-action
      // or account guard (stale, row 'created'). A version race alone leaves the row 'claimed' for a retry.
      const [brandWrite, setupWrite] = await env.LEADS.batch([
        env.LEADS.prepare(`
          UPDATE brand_runtime SET google_conversion_action = ?3, updated_at = ?4
          WHERE brand_id = ?1 AND google_conversion_action IS NULL AND updated_at = ?5
            AND google_ads_account = (SELECT account FROM conversion_setup WHERE brand_id = ?1 AND claim_id = ?2 AND status = 'claimed')`)
          .bind(data.brand_id, data.claim_id, id, at, updatedAt),
        env.LEADS.prepare(`
          UPDATE conversion_setup
          SET status = 'created', conversion_action_id = ?3, last_error = NULL, next_attempt_at = NULL, updated_at = ?4
          WHERE brand_id = ?1 AND claim_id = ?2 AND status = 'claimed'
            AND (EXISTS (SELECT 1 FROM brand_runtime WHERE brand_id = ?1 AND google_conversion_action = ?3 AND updated_at = ?4)
              OR NOT EXISTS (SELECT 1 FROM brand_runtime WHERE brand_id = ?1 AND google_conversion_action IS NULL
                AND google_ads_account = conversion_setup.account))
          RETURNING name, account`)
          .bind(data.brand_id, data.claim_id, id, at),
      ]);
      await hooks.afterBatch?.();
      if (setupWrite!.meta.changes) {
        // The row is 'created' either way so the name is not reused; a hand-set action or a changed account stays untouched.
        if (!brandWrite!.meta.changes) return stale();
        const recorded = setupWrite!.results[0] as { name: string; account: string };
        await writeDrainAudit(env, "brand.conversion_create", data.brand_id,
          { google_conversion_action: null },
          { google_conversion_action: id, name: recorded.name, account: recorded.account }, at);
        return json({ status: "created" });
      }
      const row = await loadSetupRow(env, data.brand_id);
      if (row && row.claim_id === data.claim_id && row.status === "claimed" && attempt < MAX_VERSION_TRIES) {
        const fresh = await env.LEADS.prepare("SELECT updated_at FROM brand_runtime WHERE brand_id = ?1")
          .bind(data.brand_id).first<{ updated_at: string }>();
        if (!fresh) return invalid("Unknown brand_id", {}, 404);
        updatedAt = fresh.updated_at;
        continue;
      }
      if (row && row.claim_id === data.claim_id && row.status === "created" && row.conversion_action_id === id) {
        // A repeat is only a success while the brand still holds that id on the claimed account.
        const current = await env.LEADS.prepare("SELECT google_conversion_action, google_ads_account FROM brand_runtime WHERE brand_id = ?1")
          .bind(data.brand_id).first<{ google_conversion_action: string | null; google_ads_account: string | null }>();
        if (current?.google_conversion_action === id && current.google_ads_account === row.account) {
          return json({ status: "created", already: true });
        }
      }
      return stale();
    }
  }

  const row = await loadSetupRow(env, data.brand_id);
  if (!row || row.claim_id !== data.claim_id || row.status !== "claimed") return stale();
  const attempts = row.attempts + 1;
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const nextAttemptAt = new Date(nowMs + conversionSetupBackoffMs(attempts)).toISOString();
  const update = await env.LEADS.prepare(`
    UPDATE conversion_setup
    SET status = 'failed', attempts = ?3, last_error = ?4, next_attempt_at = ?5, updated_at = ?6
    WHERE brand_id = ?1 AND claim_id = ?2 AND status = 'claimed' AND attempts = ?7
      AND account = (SELECT google_ads_account FROM brand_runtime WHERE brand_id = ?1)`)
    .bind(data.brand_id, data.claim_id, attempts, data.error, nextAttemptAt, at, row.attempts).run();
  if (!update.meta.changes) return stale();
  await writeDrainAudit(env, "brand.conversion_create_failed", data.brand_id, null,
    { error: data.error, attempts, name: row.name, account: row.account }, at);
  return json({ status: "failed" });
}

async function loadSetupRow(env: Env, brandId: string): Promise<SetupRow | null> {
  return env.LEADS.prepare("SELECT * FROM conversion_setup WHERE brand_id = ?1").bind(brandId).first<SetupRow>();
}

/** Panel state for one brand (spec section 6); null for an unknown brand. */
export async function loadConversionSetupState(env: Env, brandId: string): Promise<ConversionSetupStateResponse | null> {
  const brand = await env.LEADS.prepare(
    "SELECT google_ads_account, google_conversion_action FROM brand_runtime WHERE brand_id = ?1",
  ).bind(brandId).first<{ google_ads_account: string | null; google_conversion_action: string | null }>();
  if (!brand) return null;
  const empty = { error: null, name: null, conversion_action_id: null, attempts: 0, updated_at: null };
  if (!brand.google_ads_account) return ConversionSetupStateResponse.parse({ conversion_setup: { status: "none", ...empty } });

  const row = await loadSetupRow(env, brandId);
  const current = row && row.account === brand.google_ads_account ? row : null;
  if (brand.google_conversion_action) {
    const named = current?.status === "created" && current.conversion_action_id === brand.google_conversion_action;
    return ConversionSetupStateResponse.parse({
      conversion_setup: {
        status: "created", error: null, name: named ? current.name : null,
        conversion_action_id: brand.google_conversion_action,
        attempts: named ? current.attempts : 0, updated_at: named ? current.updated_at : null,
      },
    });
  }
  if (current?.status === "failed") {
    return ConversionSetupStateResponse.parse({
      conversion_setup: {
        status: "failed", error: current.last_error, name: current.name, conversion_action_id: null,
        attempts: current.attempts, updated_at: current.updated_at,
      },
    });
  }
  return ConversionSetupStateResponse.parse({
    conversion_setup: {
      status: "pending", error: null, name: current?.name ?? null, conversion_action_id: null,
      attempts: current?.attempts ?? 0, updated_at: current?.updated_at ?? null,
    },
  });
}
