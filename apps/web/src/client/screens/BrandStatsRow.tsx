/** The 7-day numbers under each brand of the brands list: clicks, leads, sold and pending. An unknown number is "—", never 0. */
import type { BrandSummary, FunnelReportResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "../api";

export interface BrandStats {
  clicks: number | null;
  leads: number | null;
  sold: number | null;
  pending: number | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

/** The core funnel report of the last 7 days for every brand, reloaded when `refreshKey` changes. Null while loading or when it failed. */
export function useWeekFunnel(refreshKey: number): FunnelReportResponse | null {
  const [report, setReport] = useState<FunnelReportResponse | null>(null);
  useEffect(() => {
    let active = true;
    const now = Date.now();
    void api.funnel({ from: new Date(now - WEEK_MS).toISOString(), to: new Date(now + 60_000).toISOString() })
      .then((result) => { if (active) setReport(result); }, () => { if (active) setReport(null); });
    return () => { active = false; };
  }, [refreshKey]);
  return report;
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
