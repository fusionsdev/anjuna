/**
 * Ad spend (FUS-368). The VPS spend-sync job POSTs AdKit results to /api/spend/ingest with the
 * drain token; the panel reads per-brand totals through GET /admin/spend (owner only).
 * `cost` is in the account's billing currency (THB or USD, THB when a row names none). The report
 * groups by brand and currency and never adds baht to dollars; the panel converts to USD.
 */
import {
  AdsAllocationMode,
  CampaignSpendIngestRequest,
  SpendIngestRequest,
  SpendReportResponse,
  spendPeriodRange,
  type CampaignSpendRow,
  type SpendCurrency,
  type SpendPeriod,
} from "@anjuna/contracts";
import { drainAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import { json, unauthorized } from "./http.js";
import { allocateSpend, deriveCampaignMap } from "./spend-allocation.js";

/** 5000 rows of about 110 bytes each, with headroom. */
const INGEST_BODY_LIMIT = 1_000_000;

/**
 * One statement for the whole batch: the rows travel as a single JSON parameter, so a 5000-row
 * POST stays far below D1's per-query bound-parameter and per-invocation query limits.
 * `WHERE true` is SQLite's required disambiguation for INSERT ... SELECT ... ON CONFLICT.
 * The conflict target is the ad_spend_key unique index expression (NULL hour = whole day).
 * A row without `allocation` is exact: the account level path writes brands alone on their account.
 * A row without `account` stores NULL: only the campaign level path names the account it split.
 */
const UPSERT_SQL = `
  INSERT INTO ad_spend (brand_id, date, hour, cost, currency, clicks, impressions, source, allocation, account, updated_at)
  SELECT json_extract(value, '$.brand_id'), json_extract(value, '$.date'), json_extract(value, '$.hour'),
         json_extract(value, '$.cost'), json_extract(value, '$.currency'), json_extract(value, '$.clicks'),
         json_extract(value, '$.impressions'), 'google', COALESCE(json_extract(value, '$.allocation'), 'exact'),
         json_extract(value, '$.account'), ?2
  FROM json_each(?1) WHERE true
  ON CONFLICT (brand_id, date, COALESCE(hour, -1), source) DO UPDATE SET
    cost = excluded.cost, currency = excluded.currency, clicks = excluded.clicks, impressions = excluded.impressions,
    allocation = excluded.allocation, account = excluded.account, updated_at = excluded.updated_at`;

const invalid = (message: string, extra: Record<string, unknown> = {}, status = 400) =>
  json({ status: "invalid", message, ...extra }, status);

/** The part of a zod schema readBody uses; core does not depend on zod directly. */
interface BodySchema<T> {
  safeParse(raw: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/** Read and validate a JSON body under the ingest size bound. Returns the parsed value or the 4xx response. */
async function readBody<T>(request: Request, schema: BodySchema<T>): Promise<{ data: T } | { response: Response }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > INGEST_BODY_LIMIT) return { response: invalid("Request body is too large", {}, 413) };
  const text = await request.text();
  if (text.length > INGEST_BODY_LIMIT) return { response: invalid("Request body is too large", {}, 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { response: invalid("Invalid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { response: invalid("Invalid body", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "body", message: i.message })),
    }) };
  }
  return { data: parsed.data };
}

export async function handleSpendIngest(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();

  const body = await readBody(request, SpendIngestRequest);
  if ("response" in body) return body.response;
  const { rows } = body.data;

  // Every brand_id must belong to this core. One unknown id rejects the whole batch unwritten.
  const { results } = await env.LEADS.prepare("SELECT brand_id FROM brand_runtime").all<{ brand_id: string }>();
  const known = new Set(results.map((r) => r.brand_id));
  const unknown = [...new Set(rows.map((r) => r.brand_id).filter((id) => !known.has(id)))].sort();
  if (unknown.length) return invalid("Unknown brand_id", { unknown_brand_ids: unknown }, 422);

  if (rows.length === 0) return json({ status: "accepted", upserted: 0 });
  // A row without a currency is baht: every account billed in THB before spend-sync sent the field.
  const payload = rows.map((r) => ({ ...r, hour: r.hour ?? null, currency: r.currency ?? "THB" }));
  await env.LEADS.prepare(UPSERT_SQL).bind(JSON.stringify(payload), new Date().toISOString()).run();
  return json({ status: "accepted", upserted: rows.length });
}

/** Panel setting `ads_allocation_mode` from factory panel_settings. A missing or unreadable row is `estimated`. */
async function loadAllocationMode(env: Env): Promise<AdsAllocationMode> {
  const row = await env.FACTORY.prepare("SELECT value_json FROM panel_settings WHERE key = 'ads_allocation_mode'")
    .first<{ value_json: string }>();
  if (!row) return "estimated";
  try {
    const mode = AdsAllocationMode.safeParse(JSON.parse(row.value_json));
    return mode.success ? mode.data : "estimated";
  } catch {
    return "estimated";
  }
}

const UNALLOCATED_UPSERT_SQL = `
  INSERT INTO ad_spend_unallocated (account, date, hour, cost, currency, updated_at)
  SELECT ?3, json_extract(value, '$.date'), json_extract(value, '$.hour'), json_extract(value, '$.cost'), ?4, ?2
  FROM json_each(?1) WHERE true
  ON CONFLICT (account, date, COALESCE(hour, -1), currency) DO UPDATE SET
    cost = excluded.cost, updated_at = excluded.updated_at`;

/** A slot with no unallocated cost keeps no unallocated row, so a rerun in `estimated` mode clears it. */
const UNALLOCATED_CLEAR_SQL = `
  DELETE FROM ad_spend_unallocated
  WHERE account = ?2 AND currency = ?3 AND EXISTS (
    SELECT 1 FROM json_each(?1) j
    WHERE json_extract(j.value, '$.date') = ad_spend_unallocated.date
      AND COALESCE(json_extract(j.value, '$.hour'), -1) = COALESCE(ad_spend_unallocated.hour, -1))`;

/**
 * A brand that left the account keeps no share: in every posted slot (?3), delete this account's google
 * rows of brands not in the current list (?2). Rows with account NULL never match `account = ?1`.
 */
const STALE_BRAND_CLEAR_SQL = `
  DELETE FROM ad_spend
  WHERE account = ?1 AND source = 'google' AND brand_id NOT IN (SELECT value FROM json_each(?2))
    AND EXISTS (
      SELECT 1 FROM json_each(?3) j
      WHERE json_extract(j.value, '$.date') = ad_spend.date
        AND COALESCE(json_extract(j.value, '$.hour'), -1) = COALESCE(ad_spend.hour, -1))`;

/**
 * Paid clicks (a Google click id) of the given brands per local day and hour of the ad account, with
 * click_seen_at (UTC ISO 8601) inside [?2, ?3). ?4 is the SQLite modifier that moves UTC to the account
 * zone, for example '+420 minutes'.
 */
const PAID_CLICKS_SQL = `
  SELECT brand_id, strftime('%Y-%m-%d', click_seen_at, ?4) AS date,
         CAST(strftime('%H', click_seen_at, ?4) AS INTEGER) AS hour, COUNT(*) AS n
  FROM click_sessions
  WHERE brand_id IN (SELECT value FROM json_each(?1))
    AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
    AND click_seen_at >= ?2 AND click_seen_at < ?3
  GROUP BY brand_id, date, hour`;

const slotKey = (date: string, hour: number | null) => `${date}|${hour ?? -1}`;
const DAY_MS = 86_400_000;
/** UTC instant of local midnight at the start of `date` (plus `days`) in a zone `offsetMinutes` ahead of UTC. */
const localMidnightUtc = (date: string, offsetMinutes: number, days = 0) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS - offsetMinutes * 60_000).toISOString();

/**
 * POST /api/spend/campaign-ingest (drain token, header only). Body: one account's campaign level cost.
 * Core first refreshes `click` map rows, then allocates each (date, hour) slot to the account's brands
 * (see spend-allocation.ts) and writes one ad_spend row per brand per slot, 0 included, so a rerun or a
 * changed mapping overwrites every earlier share. Weights for unmapped campaigns are the brands' paid
 * clicks in the same local hour of the account (utc_offset_minutes), else that local day, else equal.
 * All writes run in one D1 batch.
 */
export async function handleCampaignSpendIngest(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();

  const body = await readBody(request, CampaignSpendIngestRequest);
  if ("response" in body) return body.response;
  const { account, currency, utc_offset_minutes: offset, rows } = body.data;

  const slots = new Map<string, { date: string; hour: number | null; campaigns: CampaignSpendRow[]; ids: Set<string> }>();
  for (const row of rows) {
    const hour = row.hour ?? null;
    const key = slotKey(row.date, hour);
    const slot = slots.get(key) ?? { date: row.date, hour, campaigns: [], ids: new Set<string>() };
    if (slot.ids.has(row.campaign_id)) {
      return invalid("Duplicate campaign row", { date: row.date, hour, campaign_id: row.campaign_id });
    }
    slot.ids.add(row.campaign_id);
    slot.campaigns.push(row);
    slots.set(key, slot);
  }

  const { results: brandRows } = await env.LEADS.prepare(
    "SELECT brand_id FROM brand_runtime WHERE google_ads_account = ?1 ORDER BY brand_id",
  ).bind(account).all<{ brand_id: string }>();
  const brands = brandRows.map((r) => r.brand_id);
  if (!brands.length) return invalid("Unknown account", {}, 422);
  if (!slots.size) return json({ status: "accepted", upserted: 0, unallocated: 0 });

  await deriveCampaignMap(env.LEADS);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const [mapResult, clickResult] = await env.LEADS.batch([
    env.LEADS.prepare("SELECT campaign_id, brand_id FROM campaign_brand_map WHERE account = ?1").bind(account),
    env.LEADS.prepare(PAID_CLICKS_SQL).bind(
      JSON.stringify(brands), localMidnightUtc(dates[0]!, offset), localMidnightUtc(dates.at(-1)!, offset, 1),
      `${offset < 0 ? "-" : "+"}${Math.abs(offset)} minutes`,
    ),
  ]);
  const map = new Map((mapResult as D1Result<{ campaign_id: string; brand_id: string }>).results.map((r) => [r.campaign_id, r.brand_id]));
  const hourClicks = new Map<string, Record<string, number>>();
  const dayClicks = new Map<string, Record<string, number>>();
  for (const r of (clickResult as D1Result<{ brand_id: string; date: string; hour: number; n: number }>).results) {
    for (const [index, key] of [[hourClicks, slotKey(r.date, Number(r.hour))], [dayClicks, r.date]] as const) {
      const counts = index.get(key) ?? {};
      counts[r.brand_id] = (counts[r.brand_id] ?? 0) + Number(r.n);
      index.set(key, counts);
    }
  }
  const mode = await loadAllocationMode(env);

  const spend: Record<string, unknown>[] = [];
  const unallocated: { date: string; hour: number | null; cost: number }[] = [];
  const cleared: { date: string; hour: number | null }[] = [];
  let unallocatedUnits = 0;
  for (const { date, hour, campaigns } of slots.values()) {
    const weightsFrom = (counts: Record<string, number> | undefined) =>
      Object.fromEntries(brands.map((b) => [b, counts?.[b] ?? 0]));
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    let brandClicks = weightsFrom(hour === null ? undefined : hourClicks.get(slotKey(date, hour)));
    if (total(brandClicks) === 0) brandClicks = weightsFrom(dayClicks.get(date));
    const result = allocateSpend({ campaigns, map, brandClicks, mode });
    for (const brand of brands) {
      const parts = result.rows.filter((r) => r.brand_id === brand);
      spend.push({
        brand_id: brand, date, hour, currency, account,
        // Each part already has 2 decimals; the sum is rebuilt on hundredths so no float drift is stored.
        cost: parts.reduce((t, p) => t + Math.round(p.cost * 100), 0) / 100,
        clicks: parts.reduce((t, p) => t + p.clicks, 0),
        impressions: parts.reduce((t, p) => t + p.impressions, 0),
        allocation: parts.some((p) => p.allocation === "estimated") ? "estimated" : "exact",
      });
    }
    if (result.unallocated > 0) {
      unallocated.push({ date, hour, cost: result.unallocated });
      unallocatedUnits += Math.round(result.unallocated * 100);
    } else {
      cleared.push({ date, hour });
    }
  }

  // One brand row per slot can reach brands x 5000 rows: chunks of 2000 keep each JSON parameter well
  // under D1's 2 MB value bound. The batch is one transaction, so a failure writes nothing.
  const stamp = new Date().toISOString();
  const chunks = Array.from({ length: Math.ceil(spend.length / 2000) }, (_, i) => spend.slice(i * 2000, (i + 1) * 2000));
  await env.LEADS.batch([
    ...chunks.map((chunk) => env.LEADS.prepare(UPSERT_SQL).bind(JSON.stringify(chunk), stamp)),
    env.LEADS.prepare(STALE_BRAND_CLEAR_SQL).bind(
      account, JSON.stringify(brands), JSON.stringify([...slots.values()].map(({ date, hour }) => ({ date, hour }))),
    ),
    env.LEADS.prepare(UNALLOCATED_UPSERT_SQL).bind(JSON.stringify(unallocated), stamp, account, currency),
    env.LEADS.prepare(UNALLOCATED_CLEAR_SQL).bind(JSON.stringify(cleared), account, currency),
  ]);
  return json({ status: "accepted", upserted: spend.length, unallocated: unallocatedUnits / 100 });
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Rows that count for a period (`?1` = first day, `?2` = last day). A day that has hourly rows counts
 * only those; a whole-day row (hour NULL) counts only for a brand and day with no hourly rows, so
 * switching the job between day and hour breakdowns never double-counts.
 */
const COUNTED_ROWS_SQL = `
    FROM ad_spend s
    WHERE s.date BETWEEN ?1 AND ?2
      AND (s.hour IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM ad_spend h
        WHERE h.brand_id = s.brand_id AND h.date = s.date AND h.source = s.source AND h.hour IS NOT NULL))`;

/**
 * Per-brand, per-currency totals for the period's UTC days, plus one cost per day and currency in
 * `daily` (ascending by date). Totals and `daily` keep one cost sum per currency, never baht plus dollars.
 * Both queries run in one batch so they read the same state.
 */
export async function loadSpendReport(env: Env, period: SpendPeriod, now = new Date()): Promise<SpendReportResponse> {
  const { from, to } = spendPeriodRange(period, now);
  const [brandRows, dayRows] = await env.LEADS.batch([
    env.LEADS.prepare(`
    SELECT s.brand_id, s.currency, SUM(s.cost) AS cost, SUM(s.clicks) AS clicks, SUM(s.impressions) AS impressions,
           MAX(s.updated_at) AS updated_at${COUNTED_ROWS_SQL}
    GROUP BY s.brand_id, s.currency
    ORDER BY s.brand_id, s.currency`).bind(from, to),
    env.LEADS.prepare(`
    SELECT s.date, s.currency, SUM(s.cost) AS cost${COUNTED_ROWS_SQL}
    GROUP BY s.date, s.currency
    ORDER BY s.date, s.currency`).bind(from, to),
  ]);
  const results = (brandRows as D1Result<{
    brand_id: string; currency: SpendCurrency; cost: number; clicks: number; impressions: number; updated_at: string;
  }>).results;
  const daily = (dayRows as D1Result<{ date: string; currency: SpendCurrency; cost: number }>).results
    .map((r) => ({ date: r.date, cost: cents(Number(r.cost)), currency: r.currency }));
  const brands = results.map((r) => ({
    brand_id: r.brand_id,
    currency: r.currency,
    cost: cents(Number(r.cost)),
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    updated_at: r.updated_at,
  }));
  const totals = { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 };
  for (const b of brands) {
    totals.cost_by_currency[b.currency] = cents(totals.cost_by_currency[b.currency] + b.cost);
    totals.clicks += b.clicks;
    totals.impressions += b.impressions;
  }
  return SpendReportResponse.parse({ period, from, to, totals, brands, daily });
}
