/**
 * Ad spend (FUS-368). The VPS `spend-sync.mjs` job reads AdKit results per brand and POSTs them to
 * core `POST /api/spend/ingest` (drain token, header only). Core upserts `ad_spend` rows keyed by
 * (brand_id, date, hour, source). The panel reads totals through `GET /admin/spend?period=`.
 * `cost` is in the ad account's billing `currency` (THB or USD; a row without one is THB). `hour` is
 * 0-23 for an hourly row and null for a whole-day row. The panel converts to USD with its own rate.
 */
import { z } from "zod";
import { BrandId } from "./common.js";

/** Most rows one ingest request may carry: 30 days x 24 hours x 6 brands, with headroom. */
export const SPEND_INGEST_MAX_ROWS = 5000;

const Count = z.number().int().min(0);
const Money = z.number().finite().min(0);

/** Billing currency of a Google Ads account. Legacy rows and rows sent without one are THB. */
export const SPEND_CURRENCIES = ["THB", "USD"] as const;
export const SpendCurrency = z.enum(SPEND_CURRENCIES);
export type SpendCurrency = z.infer<typeof SpendCurrency>;

export const SpendRow = z.strictObject({
  brand_id: BrandId,
  /** Calendar day YYYY-MM-DD in the ad account's time zone, as AdKit reports it. */
  date: z.iso.date(),
  hour: z.number().int().min(0).max(23).nullable().optional(),
  cost: Money,
  /** Currency of `cost`. Absent means THB: every account billed in baht before the field existed. */
  currency: SpendCurrency.optional(),
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

/** today = the current UTC day; yesterday = the UTC day before it; 7d and 30d end today and include it. */
export const SPEND_PERIODS = ["today", "yesterday", "7d", "30d"] as const;
export const SpendPeriod = z.enum(SPEND_PERIODS);
export type SpendPeriod = z.infer<typeof SpendPeriod>;

export const SpendQuery = z.strictObject({ period: SpendPeriod });
export type SpendQuery = z.infer<typeof SpendQuery>;

/** Cost summed per currency, never across them. */
export const SpendCostByCurrency = z.strictObject({ THB: Money, USD: Money });
export type SpendCostByCurrency = z.infer<typeof SpendCostByCurrency>;

const SpendBrandRow = z.strictObject({
  brand_id: BrandId,
  /** Currency of `cost`. A brand appears once per currency it has rows in. */
  currency: SpendCurrency,
  cost: Money,
  clicks: Count,
  impressions: Count,
  /** Latest ingest time of any row counted for this brand and currency. */
  updated_at: z.iso.datetime(),
});

/** One UTC day of cost in one currency, all brands together. A day with two currencies has two entries. */
const SpendDailyRow = z.strictObject({
  date: z.iso.date(),
  cost: Money,
  currency: SpendCurrency,
});

export const SpendReportResponse = z.strictObject({
  period: SpendPeriod,
  from: z.iso.date(),
  to: z.iso.date(),
  totals: z.strictObject({ cost_by_currency: SpendCostByCurrency, clicks: Count, impressions: Count }),
  brands: z.array(SpendBrandRow),
  /**
   * Cost per day and currency inside the period, ascending by date, then currency. A day with no rows has no
   * entry. Core always sends it. It is optional so a panel built with this contract still reads a core that
   * predates it (panel deploys first, then core); a reader treats a missing `daily` as an empty series.
   */
  daily: z.array(SpendDailyRow).optional(),
});
export type SpendReportResponse = z.infer<typeof SpendReportResponse>;

/**
 * Panel `GET /api/spend` (owner only): the core report plus USD figures the panel computes with its
 * `fx_thb_per_usd` setting. `cost_usd` and `total_cost_usd` never reach an employee.
 */
export const PanelSpendReportResponse = SpendReportResponse.extend({
  brands: z.array(SpendBrandRow.extend({ cost_usd: Money })),
  total_cost_usd: Money,
  fx: z.strictObject({ thbPerUsd: z.number().finite().positive() }),
});
export type PanelSpendReportResponse = z.infer<typeof PanelSpendReportResponse>;

/** Inclusive UTC day range for a period. `yesterday` is the one day before `now`; the others end on the day of `now`. */
export function spendPeriodRange(period: SpendPeriod, now: Date = new Date()): { from: string; to: string } {
  const days = period === "today" || period === "yesterday" ? 1 : period === "7d" ? 7 : 30;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(today - (period === "yesterday" ? 86_400_000 : 0)).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}
