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
  // A core that predates `daily` sends none; the contract makes it optional, so that reads as an empty series.
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

const HOUR_MS = 3_600_000;

/**
 * True when `updatedAt` (an ISO instant, the newest AdKit sync of a brand) is more than `maxHours` before `now`.
 * A time that cannot be read counts as stale, so a number of unknown age is never shown.
 */
export function isStale(updatedAt: string, now: Date, maxHours = 2): boolean {
  const at = Date.parse(updatedAt);
  return Number.isNaN(at) || now.getTime() - at > maxHours * HOUR_MS;
}

/**
 * True when fewer than 5 percent of the paid clicks reached the site, judged only from 20 paid clicks up:
 * a handful of clicks says nothing. `reachedSite` is the count of visitors the brands' funnel recorded.
 */
export function clickLossWarning(paidClicks: number, reachedSite: number): boolean {
  return paidClicks >= 20 && reachedSite / paidClicks < 0.05;
}

/** The checklist items a live brand needs. A brand is failing while any of them has no evidence row. */
const CHECKLIST_ITEMS = ["drain_route", "leadsgate_postbacks", "test_sold", "final_url"] as const;

/**
 * What one brand's checklist rows say, in the three fields the brand screens read.
 * `rows` is the brand's entry of GET /api/brands/checklists, or undefined when the brand is not in it
 * (not live) or the read failed: then nothing is known and every field is undefined, so nothing is raised.
 */
export function checklistFlags(rows: ReadonlyArray<{ item: string }> | undefined): { checklistFailing?: boolean; drain_route?: boolean; test_sold?: boolean } {
  if (!rows) return {};
  const has = (item: string) => rows.some((row) => row.item === item);
  return { checklistFailing: CHECKLIST_ITEMS.some((item) => !has(item)), drain_route: has("drain_route"), test_sold: has("test_sold") };
}
