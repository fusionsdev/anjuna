/**
 * Ad spend (FUS-368). The VPS `spend-sync.mjs` job reads AdKit results per brand and POSTs them to
 * core `POST /api/spend/ingest` (drain token, header only). Core upserts `ad_spend` rows keyed by
 * (brand_id, date, hour, source). The panel reads totals through `GET /admin/spend?period=`.
 * `cost` is in the ad account's billing `currency` (THB or USD; a row without one is THB). `hour` is
 * 0-23 for an hourly row and null for a whole-day row. The panel converts to USD with its own rate.
 */
import { z } from "zod";
import { BrandId, GoogleAdsAccount } from "./common.js";

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

/** Google Ads campaign id: digits only, as `{campaignid}` substitutes it and AdKit reports it. */
export const CampaignId = z.string().regex(/^[0-9]{1,20}$/, "Invalid campaign_id");
export type CampaignId = z.infer<typeof CampaignId>;

/** How a brand's ad_spend row was made: from mapped campaigns, or with an unmapped campaign split by click share. */
export const SPEND_ALLOCATIONS = ["exact", "estimated"] as const;
export const SpendAllocation = z.enum(SPEND_ALLOCATIONS);
export type SpendAllocation = z.infer<typeof SpendAllocation>;

/** Panel setting `ads_allocation_mode`. `estimated` (default) splits unmapped cost; `exact_only` keeps it off every brand. */
export const ADS_ALLOCATION_MODES = ["estimated", "exact_only"] as const;
export const AdsAllocationMode = z.enum(ADS_ALLOCATION_MODES);
export type AdsAllocationMode = z.infer<typeof AdsAllocationMode>;

export const CampaignSpendRow = z.strictObject({
  /** Calendar day YYYY-MM-DD in the ad account's time zone, as AdKit reports it. */
  date: z.iso.date(),
  /** 0-23 for an hourly row, null or absent for a whole-day row. */
  hour: z.number().int().min(0).max(23).nullable().optional(),
  campaign_id: CampaignId,
  cost: Money,
  clicks: Count,
  impressions: Count,
});
export type CampaignSpendRow = z.infer<typeof CampaignSpendRow>;

/**
 * VPS `spend-sync.mjs` -> core `POST /api/spend/campaign-ingest` (drain token, header only): campaign level
 * cost of one Google Ads account. Core maps campaigns to the account's brands and writes `ad_spend`.
 * Every (date, hour) in the body is rewritten for every brand of the account, so a rerun overwrites.
 * One (date, hour, campaign_id) may appear once; a duplicate rejects the request.
 */
export const CampaignSpendIngestRequest = z.strictObject({
  account: GoogleAdsAccount,
  /** Billing currency of the account. Every row of the request is in it. */
  currency: SpendCurrency,
  /**
   * Offset of the account time zone from UTC in minutes (420 for Asia/Bangkok). `date` and `hour` of
   * every row are in that zone; core buckets click weights with the same offset.
   */
  utc_offset_minutes: z.number().int().min(-720).max(840),
  rows: z.array(CampaignSpendRow).max(SPEND_INGEST_MAX_ROWS),
});
export type CampaignSpendIngestRequest = z.infer<typeof CampaignSpendIngestRequest>;

export const CampaignSpendIngestResponse = z.strictObject({
  status: z.literal("accepted"),
  /** ad_spend rows written: one per brand of the account per (date, hour) in the body. */
  upserted: Count,
  /** Cost in the request currency that no brand got (`exact_only` mode), 2 decimals. */
  unallocated: Money,
});
export type CampaignSpendIngestResponse = z.infer<typeof CampaignSpendIngestResponse>;

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
