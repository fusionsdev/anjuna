import type { PanelSpendReportResponse } from "@anjuna/contracts";

/** The window of equal length that ends where `range` starts. Both ends are ISO instants. */
export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const length = Date.parse(range.to) - Date.parse(range.from);
  return { from: new Date(Date.parse(range.from) - length).toISOString(), to: range.from };
}

/** Percent change from `previous` to `current`. `null` while either value loads (`undefined`); a dash when there is nothing to compare. */
export function delta(current: number | null | undefined, previous: number | null | undefined) {
  if (current === undefined || previous === undefined) return null;
  if (current === null || previous === null || previous === 0) return { text: "–", dir: "flat" as const };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" as const };
  return pct > 0 ? { text: `▲ ${pct}%`, dir: "up" as const } : { text: `▼ ${Math.abs(pct)}%`, dir: "down" as const };
}

/**
 * Owner spend for Home. `thb` is the baht spent: THB rows as billed plus any USD rows at the server's
 * rate. `usd` is the server's `total_cost_usd`, the only figure profit may subtract from USD revenue.
 * Null when the period has no AdKit rows: nothing was synced, which is not the same as nothing spent.
 */
export function spendTotals(report: PanelSpendReportResponse): { thb: number; usd: number; clicks: number } | null {
  const { THB, USD } = report.totals.cost_by_currency;
  if (report.brands.length === 0 && THB === 0 && USD === 0 && report.totals.clicks === 0) return null;
  return { thb: THB + USD * report.fx.thbPerUsd, usd: report.total_cost_usd, clicks: report.totals.clicks };
}
