// spec traffic
import { TRAFFIC_LOG_PERIODS, TRAFFIC_METRICS, type TrafficLogPeriod, type TrafficMetrics, type TrafficReportResponse } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { BrandLabel, useBrandDomains } from "../brand-labels";
import { type Column, DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { TrendChart } from "../components/TrendChart";
import { navigate, useSearch, viewPath } from "../router";
import { DEFAULT_TRAFFIC_LOG_PERIOD, TRAFFIC_LOG_PERIOD_LABEL, readTrafficLogPeriod } from "../traffic-periods";
import "./Traffic.css";

type Breakdown = keyof TrafficReportResponse["breakdowns"];
type BreakdownRow = TrafficReportResponse["breakdowns"][Breakdown][number];
type RecentRow = TrafficReportResponse["recent"][number] & { n: number };

const METRIC_LABEL: Record<(typeof TRAFFIC_METRICS)[number], string> = {
  landing_views: "เข้าชมหน้าแรก (Landing views)",
  form_starts: "เริ่มกรอกฟอร์ม (Form starts)",
  leads: "ส่งลีด (Leads)",
  validation_errors: "กรอกผิด (Validation errors)",
  redirect_errors: "ส่งต่อไม่สำเร็จ (Redirect errors)",
};
const TABS: Array<[Breakdown, string]> = [
  ["brand", "แบรนด์"], ["hostname", "โดเมน (Hostname)"], ["device", "อุปกรณ์"], ["browser", "เบราว์เซอร์"], ["source", "แหล่งที่มา (Source)"],
];

export function readTrafficPeriod(search: string): TrafficLogPeriod {
  return readTrafficLogPeriod(new URLSearchParams(search).get("period"));
}

/** The default period leaves a clean /traffic. */
export function trafficPath(period: TrafficLogPeriod): string {
  return period === DEFAULT_TRAFFIC_LOG_PERIOD ? viewPath("traffic") : `${viewPath("traffic")}?period=${period}`;
}

const count = (n: number) => n.toLocaleString("en-US");
/** UTC, read from the ISO string and never from the viewer's time zone. */
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
const dash = (value: string | number | null) => (value === null || value === "" ? "—" : String(value));

type Load = { report: TrafficReportResponse } | { error: string } | null;

export function TrafficScreen() {
  const period = readTrafficPeriod(useSearch());
  const domains = useBrandDomains();
  const [tab, setTab] = useState<Breakdown>("brand");
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>(null);

  // A late answer for an old period is dropped.
  useEffect(() => {
    let active = true;
    setLoad(null);
    api.trafficReport(period).then(
      (report) => active && setLoad({ report }),
      (e: unknown) => active && setLoad({ error: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" }),
    );
    return () => { active = false; };
  }, [period, attempt]);

  const labelOf = (id: string) => domains.get(id) ?? id;
  const metricColumns = <T extends TrafficMetrics>(): Column<T>[] =>
    TRAFFIC_METRICS.map((key) => ({ key, header: METRIC_LABEL[key], align: "right", cell: (row: T) => count(row[key]) }));

  const breakdownColumns: Column<BreakdownRow>[] = [
    {
      key: "key",
      header: TABS.find(([key]) => key === tab)![1],
      cell: (row) => (tab === "brand" ? <BrandLabel brandId={row.key} domain={labelOf(row.key)} /> : row.key),
    },
    ...metricColumns<BreakdownRow>(),
  ];
  const recentColumns: Column<RecentRow>[] = [
    { key: "at", header: "เวลา (UTC)", cell: (row) => utc(row.at) },
    { key: "event", header: "เหตุการณ์", cell: (row) => row.event_type },
    { key: "brand", header: "แบรนด์", cell: (row) => <BrandLabel brandId={row.brand_id} domain={labelOf(row.brand_id)} /> },
    { key: "step", header: "ขั้น", align: "right", cell: (row) => dash(row.form_step) },
    { key: "error", header: "รหัสข้อผิดพลาด", cell: (row) => dash(row.error_code) },
    { key: "device", header: "อุปกรณ์", cell: (row) => dash(row.device) },
    { key: "browser", header: "เบราว์เซอร์", cell: (row) => dash(row.browser) },
    { key: "source", header: "แหล่งที่มา (Source)", cell: (row) => dash(row.source) },
    { key: "ref", header: "เซสชัน (Session ref)", mono: true, cell: (row) => row.session_ref },
  ];
  const report = load && "report" in load ? load.report : null;

  return (
    <div className="traffic-page">
      <div className="head">
        <div>
          <h1>ทราฟฟิก</h1>
          <p className="sub">นับเซสชันไม่ซ้ำ เวลา UTC (ดูอย่างเดียว)</p>
        </div>
        <div className="seg" role="group" aria-label="ช่วงเวลา">
          {TRAFFIC_LOG_PERIODS.map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => navigate(trafficPath(key), { replace: true })}>{TRAFFIC_LOG_PERIOD_LABEL[key]}</button>
          ))}
        </div>
      </div>
      {!load && <Spinner />}
      {load && "error" in load && (
        <div className="note neg traffic-error" role="alert">
          <p>{load.error}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>ลองอีกครั้ง</button>
        </div>
      )}
      {report && (
        <div className="traffic-stack">
          <div className="ledger" role="group" aria-label="สรุปทราฟฟิก">
            {TRAFFIC_METRICS.map((key) => (
              <div className="cell" key={key}><p className="k">{METRIC_LABEL[key]}</p><p className="v">{count(report.totals[key])}</p></div>
            ))}
          </div>
          <section className="panel" aria-label="แนวโน้ม (Trend)">
            <TrendChart trend={report.trend} bucket={report.bucket} />
          </section>
          <section className="panel" aria-label="แยกตาม (Breakdown)">
            <div className="seg" role="group" aria-label="แยกตาม">
              {TABS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
            <DataTable
              label="แยกตาม (Breakdown)"
              columns={breakdownColumns}
              rows={report.breakdowns[tab]}
              rowKey={(row) => row.key}
              empty={<EmptyState title="ยังไม่มีทราฟฟิกในช่วงนี้" />}
            />
          </section>
          <section className="panel" aria-label="เหตุการณ์ล่าสุด">
            <div className="traffic-recent-head">
              <h2>เหตุการณ์ล่าสุด</h2>
              <a className="btn" href={api.trafficReportCsvUrl(period)} download>ดาวน์โหลด CSV</a>
            </div>
            <DataTable
              label="เหตุการณ์ล่าสุด (Recent events)"
              columns={recentColumns}
              rows={report.recent.map((row, n) => ({ ...row, n }))}
              rowKey={(row) => `${row.n}`}
              empty={<EmptyState title="ยังไม่มีทราฟฟิกในช่วงนี้" />}
            />
          </section>
        </div>
      )}
    </div>
  );
}
