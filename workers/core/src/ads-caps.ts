/**
 * Baht caps for panel campaigns (T13 Part B). A cap limits the daily budget that may be enabled; it is not a
 * spend target. Every amount is baht per day.
 *
 * checkBudget is pure: the caller passes the caps and the budgets already enabled, so it holds no clock and no
 * database. Core calls it when a draft is made and again when the campaign is enabled.
 */

export interface BudgetCheckInput {
  /** Daily budget of the campaign being drafted or enabled. */
  requested: number;
  /** ads_cap_brand_thb_day */
  capBrand: number;
  /** ads_cap_total_thb_day */
  capTotal: number;
  /** Daily budgets of the other enabled campaigns, every brand. */
  enabledTotalToday: number;
  /** Daily budgets of the other enabled campaigns of this brand. */
  enabledBrandToday: number;
}

export type BudgetCheckResult = { ok: true } | { ok: false; reason: "brand_cap" | "total_cap" };

/** Amounts in satang so 0.1 + 0.2 compares as 30 satang. */
const satang = (baht: number) => Math.round(baht * 100);

const usable = (n: number) => Number.isFinite(n) && n >= 0;

/**
 * Refuses when the brand part or the total would pass its cap. The brand cap is checked first; a brand cap above the
 * total cap never lets the total pass. Any input that is not a finite non-negative number is refused as total_cap.
 */
export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const { requested, capBrand, capTotal, enabledTotalToday, enabledBrandToday } = input;
  if (![requested, capBrand, capTotal, enabledTotalToday, enabledBrandToday].every(usable)) return { ok: false, reason: "total_cap" };
  if (satang(enabledBrandToday) + satang(requested) > satang(capBrand)) return { ok: false, reason: "brand_cap" };
  if (satang(enabledTotalToday) + satang(requested) > satang(capTotal)) return { ok: false, reason: "total_cap" };
  return { ok: true };
}
