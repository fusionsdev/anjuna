import type { AlertsReportResponse, FunnelReportResponse, PanelSpendReportResponse } from "@anjuna/contracts";

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
 * True when the report holds spend rows for the brand and every one was synced within `maxHours`.
 * No report, no rows, or one stale currency row gives false: the brand page then shows "—" and never a number of unknown age.
 */
export function brandSpendFresh(report: PanelSpendReportResponse | null, brandId: string, now: Date, maxHours = 2): boolean {
  const rows = report?.brands.filter((row) => row.brand_id === brandId) ?? [];
  return rows.length > 0 && rows.every((row) => !isStale(row.updated_at, now, maxHours));
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
 * `entry` is the brand's entry of GET /api/brands/checklists, or undefined when the brand is not in it (not live) or the read failed.
 * An `unknown` entry means core did not answer, so the rows cannot tell a missing setting from an outage.
 * In both cases nothing is known and every field is undefined: nothing is raised and no step is offered.
 */
export function checklistFlags(entry: { checklist: ReadonlyArray<{ item: string }>; unknown?: boolean } | undefined): { checklistFailing?: boolean; drain_route?: boolean; test_sold?: boolean } {
  if (!entry || entry.unknown) return {};
  const rows = entry.checklist;
  const has = (item: string) => rows.some((row) => row.item === item);
  return { checklistFailing: CHECKLIST_ITEMS.some((item) => !has(item)), drain_route: has("drain_route"), test_sold: has("test_sold") };
}

/** The funnel report with only the brands the scope shows. The same object when nothing is hidden. */
export function scopeFunnel(report: FunnelReportResponse, inScope: (brandId: string) => boolean): FunnelReportResponse {
  const rows = report.rows.filter((row) => inScope(row.brand));
  return rows.length === report.rows.length ? report : { ...report, rows };
}

/**
 * The spend report with only the brands the scope shows, its totals added up again from those rows.
 * The daily series has no brand, so it is dropped when any brand is hidden.
 */
export function scopeSpend(report: PanelSpendReportResponse, inScope: (brandId: string) => boolean): PanelSpendReportResponse {
  const brands = report.brands.filter((row) => inScope(row.brand_id));
  if (brands.length === report.brands.length) return report;
  const cost_by_currency = { THB: 0, USD: 0 };
  let clicks = 0;
  let impressions = 0;
  let total_cost_usd = 0;
  for (const row of brands) {
    cost_by_currency[row.currency] += row.cost;
    clicks += row.clicks;
    impressions += row.impressions;
    total_cost_usd += row.cost_usd;
  }
  const { daily: _daily, ...rest } = report;
  return { ...rest, brands, total_cost_usd, totals: { cost_by_currency, clicks, impressions } };
}

/** The alerts report with only the brands the scope shows in each brand list. The alert states come from core and cover every brand. */
export function scopeAlerts(report: AlertsReportResponse, inScope: (brandId: string) => boolean): AlertsReportResponse {
  const only = <T extends { brand: string }>(rows: T[]): T[] => rows.filter((row) => inScope(row.brand));
  return {
    ...report,
    brands_without_postbacks: { ...report.brands_without_postbacks, detail: { ...report.brands_without_postbacks.detail, brands: only(report.brands_without_postbacks.detail.brands) } },
    submit_error_rate: { ...report.submit_error_rate, detail: { ...report.submit_error_rate.detail, samples: only(report.submit_error_rate.detail.samples) } },
    reject_rate: { ...report.reject_rate, detail: { ...report.reject_rate.detail, brands: only(report.reject_rate.detail.brands) } },
  };
}

/**
 * Baht spent over `days` UTC days that end `offset` days before `report.to`, added up from the daily rows (a USD row at the server's rate).
 * Null when core sent no daily rows, or when the report does not reach back far enough for the window (a 30 day report holds 30 days,
 * so a 7 day window and the 7 days before it fit, and a 30 day window and the 30 days before it do not).
 */
export function spendWindowThb(report: PanelSpendReportResponse, days: number, offset: number): number | null {
  const daily = report.daily ?? [];
  if (daily.length === 0) return null;
  const end = Date.parse(`${report.to}T00:00:00.000Z`) - offset * 86_400_000;
  const start = end - (days - 1) * 86_400_000;
  const first = Date.parse(`${report.from}T00:00:00.000Z`);
  if (start < first) return null;
  let total = 0;
  for (const row of daily) {
    const at = Date.parse(`${row.date}T00:00:00.000Z`);
    if (at >= start && at <= end) total += row.currency === "USD" ? row.cost * report.fx.thbPerUsd : row.cost;
  }
  return total;
}
