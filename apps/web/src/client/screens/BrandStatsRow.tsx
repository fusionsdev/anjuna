/** The numbers of the brands screen: the 7-day stats row under each brand, and the per-period money columns of the table. An unknown number is "—", never 0. */
import type { BrandSummary, FunnelReportResponse, PanelSpendReportResponse, SpendCurrency } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";
export { sortWorstProfitFirst } from "../brand-health";

export interface BrandStats {
  clicks: number | null;
  leads: number | null;
  sold: number | null;
  pending: number | null;
}

export type BrandPeriod = "today" | "7d" | "30d";
export const BRAND_PERIODS: Array<[BrandPeriod, string]> = [["today", "วันนี้"], ["7d", "7 วัน"], ["30d", "30 วัน"]];
const PERIOD_DAYS: Record<BrandPeriod, number> = { today: 1, "7d": 7, "30d": 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar days like the spend report: from the first day at 00:00 to the end of today, so 7d is exactly 7 days. */
export function periodWindow(period: BrandPeriod, now: Date = new Date()): { from: string; to: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(today - (PERIOD_DAYS[period] - 1) * DAY_MS).toISOString(), to: new Date(today + DAY_MS).toISOString() };
}

/**
 * Leads, sold and pending come from the core brand list (stats_7d), clicks from the core funnel report, both over the last 7 days.
 * A number is known only when its source loaded and core lists the brand: a brand core does not know (a draft, a failed install)
 * and a source that failed show "—". A listed brand with no click rows in a loaded report did get 0 clicks.
 */
export function brandStats(brandId: string, runtime: BrandSummary[] | null, funnel: FunnelReportResponse | null): BrandStats {
  const listed = runtime?.find((brand) => brand.brand_id === brandId);
  return {
    clicks: listed && funnel ? funnel.rows.filter((row) => row.brand === brandId).reduce((sum, row) => sum + row.clicks, 0) : null,
    leads: listed?.stats_7d.leads ?? null,
    sold: listed?.stats_7d.sold ?? null,
    pending: listed?.stats_7d.pending ?? null,
  };
}

/** The core funnel report of a period, reloaded when `refreshKey` changes. Null while loading, when it failed, or when `period` is null. */
function useFunnelWindow(period: BrandPeriod | null, refreshKey: number): FunnelReportResponse | null {
  // The period travels with the report so that a report of the previous period is never shown for the new one.
  const [loaded, setLoaded] = useState<{ period: BrandPeriod; report: FunnelReportResponse } | null>(null);
  useEffect(() => {
    if (!period) return;
    let active = true;
    void api.funnel(periodWindow(period))
      .then((report) => { if (active) setLoaded({ period, report }); }, () => { if (active) setLoaded(null); });
    return () => { active = false; };
  }, [period, refreshKey]);
  return loaded && loaded.period === period ? loaded.report : null;
}

/** The core funnel report of the last 7 days for every brand, reloaded when `refreshKey` changes. Null while loading or when it failed. */
export function useWeekFunnel(refreshKey: number): FunnelReportResponse | null {
  return useFunnelWindow("7d", refreshKey);
}

/** The funnel report of the chosen period. The 7-day period reuses the stats row's report, so one request serves both. */
export function usePeriodFunnel(period: BrandPeriod, refreshKey: number, week: FunnelReportResponse | null): FunnelReportResponse | null {
  const own = useFunnelWindow(period === "7d" ? null : period, refreshKey);
  return period === "7d" ? week : own;
}

/** GET /api/spend?period= (owner only; cost in the account currency, cost_usd at the panel's rate). */
export type SpendReport = PanelSpendReportResponse;

/** The ad spend per brand of a period. Only the Owner asks: the API answers 403 to an Employee. Null while loading or when it failed. */
export function useSpendReport(period: BrandPeriod, enabled: boolean, refreshKey: number): SpendReport | null {
  const [loaded, setLoaded] = useState<{ period: BrandPeriod; report: SpendReport } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api.spend(period).then((report) => { if (active) setLoaded({ period, report }); }, () => { if (active) setLoaded(null); });
    return () => { active = false; };
  }, [period, enabled, refreshKey]);
  return enabled && loaded && loaded.period === period ? loaded.report : null;
}

/** An amount per billing currency. Baht and dollars are never added together. */
export type ByCurrency = Partial<Record<SpendCurrency, number>>;

/** One table row of the brands screen. Every number is null when its source did not load: "—", never 0. */
export interface BrandMoney {
  clicks: number | null;
  leads: number | null;
  /** Spend in each currency the brand's accounts bill in (THB in production). */
  spend: ByCurrency | null;
  costPerLead: ByCurrency | null;
  /** USD: revenue minus the server's cost_usd. */
  profit: number | null;
  /** `spend` and `costPerLead` as the table shows them, e.g. "฿3,500" or "฿350 + $5". */
  spendText: string;
  costPerLeadText: string;
  /** Part of the spend is an unmapped campaign split by click share (T13 A3): the table shows "~". */
  estimated: boolean;
}

/** Tooltip of every "~" number: the brand's share of an unmapped campaign comes from its share of the clicks. */
export const ESTIMATED_TITLE = "ประมาณจากสัดส่วนคลิก";

/** A spend or cost-per-lead text, with "~" and the tooltip when it is estimated. "—" never gets a mark. */
export function SpendText({ text, estimated }: { text: string; estimated: boolean }) {
  return estimated && text !== "—" ? <span className="est" title={ESTIMATED_TITLE}>~{text}</span> : <>{text}</>;
}

/** True when any spend row of the brand is estimated. A row from a core that predates the field reads as exact. */
export function spendEstimated(spend: SpendReport | null | undefined, brandId: string): boolean {
  return !!spend?.brands.some((row) => row.brand_id === brandId && row.allocation === "estimated");
}

const SYMBOL: Record<SpendCurrency, string> = { THB: "฿", USD: "$" };

/** "฿350", "฿350 + $5", or "—" for null. Whole units from 100 up, two decimals below. */
export function byCurrencyText(value: ByCurrency | null): string {
  if (value === null) return "—";
  return (["THB", "USD"] as const).filter((c) => value[c] !== undefined).map((c) => {
    const amount = value[c]!;
    return `${SYMBOL[c]}${amount >= 100 || Number.isInteger(amount) ? Math.round(amount).toLocaleString("en-US") : amount.toFixed(2)}`;
  }).join(" + ");
}

/**
 * Clicks, leads and revenue come from the funnel report of the period (same rule as `brandStats`: known only for a brand core lists),
 * spend from every spend row of the brand (one per currency). A brand missing from the spend report was not synced, so its spend,
 * cost per lead and profit are unknown. Profit subtracts the server's USD cost from USD revenue, never baht.
 */
export function brandMoney(brandId: string, runtime: BrandSummary[] | null, funnel: FunnelReportResponse | null, spend: SpendReport | null): BrandMoney {
  const listed = runtime?.some((brand) => brand.brand_id === brandId);
  const rows = listed && funnel ? funnel.rows.filter((row) => row.brand === brandId) : null;
  const clicks = rows ? rows.reduce((sum, row) => sum + row.clicks, 0) : null;
  const leads = rows ? rows.reduce((sum, row) => sum + row.submits, 0) : null;
  const revenue = rows && !rows.some((row) => row.revenue === null) ? rows.reduce((sum, row) => sum + (row.revenue ?? 0), 0) : null;
  const spendRows = spend ? spend.brands.filter((row) => row.brand_id === brandId) : [];
  let cost: ByCurrency | null = null;
  let costUsd: number | null = null;
  for (const row of spendRows) {
    cost = { ...(cost ?? {}), [row.currency]: (cost?.[row.currency] ?? 0) + row.cost };
    costUsd = (costUsd ?? 0) + row.cost_usd;
  }
  const costPerLead = cost !== null && leads ? Object.fromEntries(Object.entries(cost).map(([c, amount]) => [c, amount / leads])) as ByCurrency : null;
  return {
    clicks,
    leads,
    spend: cost,
    costPerLead,
    profit: costUsd !== null && revenue !== null ? Math.round((revenue - costUsd) * 100) / 100 : null,
    spendText: byCurrencyText(cost),
    costPerLeadText: byCurrencyText(costPerLead),
    estimated: spendEstimated(spend, brandId),
  };
}

const CELLS: Array<{ key: keyof BrandStats; label: string }> = [
  { key: "clicks", label: "คลิก (Clicks)" },
  { key: "leads", label: "ลีด (Leads)" },
  { key: "sold", label: "ขายได้ (Sold)" },
  { key: "pending", label: "รอผล (Pending)" },
];

export function BrandStatsRow({ name, stats }: { name: string; stats: BrandStats }) {
  return (
    <div className="brand-stats" role="group" aria-label={`สถิติ 7 วัน (7-day stats) ${name}`}>
      {CELLS.map(({ key, label }) => (
        <span key={key} title={stats[key] === null ? "ไม่มีข้อมูล (No data)" : undefined}>
          <small className="muted">{label}</small> <b>{stats[key] ?? "—"}</b>
        </span>
      ))}
    </div>
  );
}
