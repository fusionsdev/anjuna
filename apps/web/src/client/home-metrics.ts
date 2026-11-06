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

/**
 * Baht spent per UTC day from `report.from` to `report.to`, for the Home sparkline. A USD entry counts
 * at the server's rate, like `spendTotals`. A day with no entry is 0. Null when core sent no daily rows
 * (nothing synced), so the card shows no line instead of a flat one.
 */
export function spendSeries(report: PanelSpendReportResponse): number[] | null {
  // Tolerates an answer without `daily` (a stale mock or cached payload); the contract requires it.
  const daily = report.daily ?? [];
  if (daily.length === 0) return null;
  const byDay = new Map<string, number>();
  for (const row of daily) {
    const thb = row.currency === "USD" ? row.cost * report.fx.thbPerUsd : row.cost;
    byDay.set(row.date, (byDay.get(row.date) ?? 0) + thb);
  }
  const first = Date.parse(`${report.from}T00:00:00.000Z`);
  const count = Math.round((Date.parse(`${report.to}T00:00:00.000Z`) - first) / 86_400_000) + 1;
  return Array.from({ length: count }, (_, i) => byDay.get(new Date(first + i * 86_400_000).toISOString().slice(0, 10)) ?? 0);
}
