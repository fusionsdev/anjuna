/**
 * Ad spend in USD (panel redesign, Task 1). Google Ads accounts bill in THB, conversion values are
 * USD, so the panel converts spend with the owner's `fx_thb_per_usd` rate before any profit is
 * computed. Only the owner-gated `/api/spend` route calls `withUsd`, so no other role receives a USD figure.
 */
import { PanelSpendReportResponse, type SpendCurrency, type SpendReportResponse } from "@anjuna/contracts";

/** `amount` in `currency` as US dollars. Throws a RangeError on a rate that is not a positive finite number. */
export function toUsd(amount: number, currency: SpendCurrency, thbPerUsd: number): number {
  if (!Number.isFinite(thbPerUsd) || thbPerUsd <= 0) throw new RangeError(`thbPerUsd must be a positive number, got ${thbPerUsd}`);
  return currency === "USD" ? amount : amount / thbPerUsd;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * The core report plus `cost_usd` per brand row and `total_cost_usd`, both rounded to cents. The
 * total sums the unrounded conversions, so it can differ by a cent from the sum of the brand rows.
 */
export function withUsd(report: SpendReportResponse, thbPerUsd: number): PanelSpendReportResponse {
  let total = 0;
  const brands = report.brands.map((row) => {
    const usd = toUsd(row.cost, row.currency, thbPerUsd);
    total += usd;
    return { ...row, cost_usd: cents(usd) };
  });
  return PanelSpendReportResponse.parse({ ...report, brands, total_cost_usd: cents(total), fx: { thbPerUsd } });
}
