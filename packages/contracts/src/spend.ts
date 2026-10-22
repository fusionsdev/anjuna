/**
 * Ad spend (FUS-368). The VPS `spend-sync.mjs` job reads AdKit results per brand and POSTs them to
 * core `POST /api/spend/ingest` (drain token, header only). Core upserts `ad_spend` rows keyed by
 * (brand_id, date, hour, source). The panel reads totals through `GET /admin/spend?period=`.
 * Cost is USD. `hour` is 0-23 for an hourly row and null for a whole-day row.
 */
import { z } from "zod";
import { BrandId } from "./common.js";

/** Most rows one ingest request may carry: 30 days x 24 hours x 6 brands, with headroom. */
export const SPEND_INGEST_MAX_ROWS = 5000;

const Count = z.number().int().min(0);

export const SpendRow = z.strictObject({
  brand_id: BrandId,
  /** Calendar day YYYY-MM-DD in the ad account's time zone, as AdKit reports it. */
  date: z.iso.date(),
  hour: z.number().int().min(0).max(23).nullable().optional(),
  cost: z.number().finite().min(0),
  clicks: Count,
  impressions: Count,
});
export type SpendRow = z.infer<typeof SpendRow>;

export const SpendIngestRequest = z.strictObject({
  rows: z.array(SpendRow).max(SPEND_INGEST_MAX_ROWS),
});
export type SpendIngestRequest = z.infer<typeof SpendIngestRequest>;

export const SpendIngestResponse = z.strictObject({
  status: z.literal("accepted"),
  upserted: Count,
});
export type SpendIngestResponse = z.infer<typeof SpendIngestResponse>;

/** today = the current UTC day; 7d and 30d end today and include it. */
export const SPEND_PERIODS = ["today", "7d", "30d"] as const;
export const SpendPeriod = z.enum(SPEND_PERIODS);
export type SpendPeriod = z.infer<typeof SpendPeriod>;

export const SpendQuery = z.strictObject({ period: SpendPeriod });
export type SpendQuery = z.infer<typeof SpendQuery>;

const SpendTotals = z.strictObject({
  cost: z.number().finite().min(0),
  clicks: Count,
  impressions: Count,
});

export const SpendReportResponse = z.strictObject({
  period: SpendPeriod,
  from: z.iso.date(),
  to: z.iso.date(),
  totals: SpendTotals,
  brands: z.array(SpendTotals.extend({
    brand_id: BrandId,
    /** Latest ingest time of any row counted for this brand. */
    updated_at: z.iso.datetime(),
  })),
});
export type SpendReportResponse = z.infer<typeof SpendReportResponse>;

/** Inclusive UTC day range for a period, ending on the day of `now`. */
export function spendPeriodRange(period: SpendPeriod, now: Date = new Date()): { from: string; to: string } {
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}
