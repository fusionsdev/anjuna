/**
 * Ad spend (FUS-368). The VPS spend-sync job POSTs AdKit results to /api/spend/ingest with the
 * drain token; the panel reads per-brand totals through GET /admin/spend (owner only).
 * `cost` is in the account's billing currency (THB or USD, THB when a row names none). The report
 * groups by brand and currency and never adds baht to dollars; the panel converts to USD.
 */
import {
  SpendIngestRequest,
  SpendReportResponse,
  spendPeriodRange,
  type SpendCurrency,
  type SpendPeriod,
} from "@anjuna/contracts";
import { drainAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import { json, unauthorized } from "./http.js";

/** 5000 rows of about 110 bytes each, with headroom. */
const INGEST_BODY_LIMIT = 1_000_000;

/**
 * One statement for the whole batch: the rows travel as a single JSON parameter, so a 5000-row
 * POST stays far below D1's per-query bound-parameter and per-invocation query limits.
 * `WHERE true` is SQLite's required disambiguation for INSERT ... SELECT ... ON CONFLICT.
 * The conflict target is the ad_spend_key unique index expression (NULL hour = whole day).
 */
const UPSERT_SQL = `
  INSERT INTO ad_spend (brand_id, date, hour, cost, currency, clicks, impressions, source, updated_at)
  SELECT json_extract(value, '$.brand_id'), json_extract(value, '$.date'), json_extract(value, '$.hour'),
         json_extract(value, '$.cost'), json_extract(value, '$.currency'), json_extract(value, '$.clicks'),
         json_extract(value, '$.impressions'), 'google', ?2
  FROM json_each(?1) WHERE true
  ON CONFLICT (brand_id, date, COALESCE(hour, -1), source) DO UPDATE SET
    cost = excluded.cost, currency = excluded.currency, clicks = excluded.clicks, impressions = excluded.impressions,
    updated_at = excluded.updated_at`;

const invalid = (message: string, extra: Record<string, unknown> = {}, status = 400) =>
  json({ status: "invalid", message, ...extra }, status);

export async function handleSpendIngest(request: Request, env: Env): Promise<Response> {
  if (!await drainAuthorized(request, env)) return unauthorized();

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > INGEST_BODY_LIMIT) return invalid("Request body is too large", {}, 413);
  const text = await request.text();
  if (text.length > INGEST_BODY_LIMIT) return invalid("Request body is too large", {}, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("Invalid JSON");
  }
  const parsed = SpendIngestRequest.safeParse(raw);
  if (!parsed.success) {
    return invalid("Invalid body", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "body", message: i.message })),
    });
  }
  const { rows } = parsed.data;

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

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Per-brand, per-currency totals for the period's UTC days. Totals keep one cost sum per currency. A day that has hourly rows counts only those; a
 * whole-day row (hour NULL) counts only for a brand and day with no hourly rows, so switching the
 * job between day and hour breakdowns never double-counts.
 */
export async function loadSpendReport(env: Env, period: SpendPeriod, now = new Date()): Promise<SpendReportResponse> {
  const { from, to } = spendPeriodRange(period, now);
  const { results } = await env.LEADS.prepare(`
    SELECT s.brand_id, s.currency, SUM(s.cost) AS cost, SUM(s.clicks) AS clicks, SUM(s.impressions) AS impressions,
           MAX(s.updated_at) AS updated_at
    FROM ad_spend s
    WHERE s.date BETWEEN ?1 AND ?2
      AND (s.hour IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM ad_spend h
        WHERE h.brand_id = s.brand_id AND h.date = s.date AND h.source = s.source AND h.hour IS NOT NULL))
    GROUP BY s.brand_id, s.currency
    ORDER BY s.brand_id, s.currency`).bind(from, to).all<{
    brand_id: string; currency: SpendCurrency; cost: number; clicks: number; impressions: number; updated_at: string;
  }>();
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
  return SpendReportResponse.parse({ period, from, to, totals, brands });
}
