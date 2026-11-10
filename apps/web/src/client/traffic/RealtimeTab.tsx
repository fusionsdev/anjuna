import { TRAFFIC_LOG_PERIODS, type TrafficLogPeriod, type TrafficRealtimeResponse } from "@anjuna/contracts";
import { Download, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { useBrandDomains } from "../brand-labels";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { navigate, useSearch, viewPath } from "../router";
import { DEFAULT_TRAFFIC_LOG_PERIOD, readTrafficLogPeriod } from "../traffic-periods";
import { useBrandScope } from "../useBrandScope";
import { AdsbotBanner, type AdsbotVisit } from "./AdsbotBanner";
import { BotsDay, BotsNow } from "./BotsNow";
import { ConnectionStrip } from "./ConnectionStrip";
import { LiveStream } from "./LiveStream";
import { clockIso, csvText, deltaText } from "./live";
import { useAdsbotSound } from "./sound";
import { useTrafficTail } from "./useTrafficTail";
import "./Realtime.css";

type Report = TrafficRealtimeResponse;
const PERIOD_LABEL: Record<TrafficLogPeriod, string> = { "24h": "24 ชม.", "7d": "7 วัน", "30d": "30 วัน" };
const count = (n: number) => n.toLocaleString("en-US");
const dash = (value: string | number | null) => (value === null || value === "" ? "—" : String(value));

export function realtimePath(period: TrafficLogPeriod): string {
  return period === DEFAULT_TRAFFIC_LOG_PERIOD ? viewPath("realtime") : `${viewPath("realtime")}?period=${period}`;
}

/** A rise is bad for these, so the delta takes the warning colour instead of the good one. */
type KpiKey = "landing_views" | "form_starts" | "leads" | "validation_errors" | "redirect_errors" | "suspicious_sessions" | "no_gclid_landings" | "gate_drops" | "non_us_pct";
const RISE_IS_BAD = new Set<KpiKey>(["validation_errors", "redirect_errors", "suspicious_sessions", "no_gclid_landings", "gate_drops", "non_us_pct"]);

function kpiValue(report: Report, key: KpiKey): string {
  const k = report.kpis;
  switch (key) {
    case "no_gclid_landings": return `${count(k.no_gclid_landings.count)} · ${k.no_gclid_landings.pct}%`;
    case "non_us_pct": return k.non_us_pct === null ? "—" : `${k.non_us_pct}%`;
    case "suspicious_sessions": return k.suspicious_sessions === null ? "—" : count(k.suspicious_sessions);
    default: return count(k[key]);
  }
}

const PRIMARY: ReadonlyArray<[KpiKey, string]> = [
  ["landing_views", "เข้าชมหน้าแรก"], ["form_starts", "เริ่มกรอกฟอร์ม"], ["leads", "ส่งลีด"],
  ["validation_errors", "กรอกผิด"], ["redirect_errors", "ส่งต่อไม่สำเร็จ"], ["suspicious_sessions", "เซสชันน่าสงสัย"],
];
const EXTRA: ReadonlyArray<[KpiKey, string, string]> = [
  ["no_gclid_landings", "หน้าแรกที่ไม่มี gclid", "เข้ามาโดยไม่มีรหัสคลิกจากโฆษณา"],
  ["gate_drops", "ถูกด่านตรวจตัดออก", "ไม่ผ่านเงื่อนไขหน้าแรกก่อนเข้าฟอร์ม"],
  ["non_us_pct", "ผู้เข้าจากนอกสหรัฐฯ", "สัดส่วนของเซสชันที่ไม่ได้มาจากสหรัฐฯ"],
];

function Kpi({ report, id, label, hint }: { report: Report; id: KpiKey; label: string; hint?: string }) {
  const delta = report.deltas[id];
  const bad = delta !== null && delta !== 0 && (RISE_IS_BAD.has(id) ? delta > 0 : delta < 0);
  return (
    <div className="cell rt-kpi" data-kpi={id}>
      <p className="k">{label}</p>
      <p className="v num">{kpiValue(report, id)}</p>
      <p className={`rt-delta ${bad ? "rt-bad" : ""}`}><span className="num">{deltaText(delta)}</span> <span className="hint">เทียบช่วงก่อนหน้า</span></p>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/** Three series per bucket as div bars: landing views, form starts and leads, each scaled to the largest value on the chart. */
function Trend({ trend }: { trend: Report["trend"] }) {
  const most = Math.max(1, ...trend.flatMap((b) => [b.landing_views, b.form_starts, b.leads]));
  const hourly = trend.length > 1 && Date.parse(trend[1]!.at) - Date.parse(trend[0]!.at) < 86_400_000;
  if (trend.every((b) => b.landing_views + b.form_starts + b.leads === 0)) return <EmptyState title="ยังไม่มีทราฟฟิกในช่วงนี้" />;
  return (
    <>
      <div className="rt-trend" role="img" aria-label="แนวโน้มทราฟฟิก">
        {trend.map((b) => (
          <div key={b.at} className="rt-trend-col" title={`${hourly ? `${b.at.slice(11, 13)}:00` : b.at.slice(0, 10)} UTC: เข้าชม ${b.landing_views}, เริ่มกรอก ${b.form_starts}, ลีด ${b.leads}`}>
            <span className="rt-bar rt-bar-landing" style={{ height: `${(b.landing_views / most) * 100}%` }} />
            <span className="rt-bar rt-bar-form" style={{ height: `${(b.form_starts / most) * 100}%` }} />
            <span className="rt-bar rt-bar-lead" style={{ height: `${(b.leads / most) * 100}%` }} />
          </div>
        ))}
      </div>
      <ul className="trend-legend">
        <li><span className="rt-swatch rt-bar-landing" />เข้าชมหน้าแรก</li>
        <li><span className="rt-swatch rt-bar-form" />เริ่มกรอกฟอร์ม</li>
        <li><span className="rt-swatch rt-bar-lead" />ส่งลีด</li>
      </ul>
    </>
  );
}

const BREAKDOWNS: ReadonlyArray<[keyof Report["breakdowns"], string]> = [
  ["source", "แหล่งที่มา"], ["hostname", "โดเมน"], ["device", "อุปกรณ์"], ["browser", "เบราว์เซอร์"], ["brand", "แบรนด์"],
];

const RECENT_HEADERS = ["เวลา (UTC)", "เหตุการณ์", "โดเมน", "แบรนด์", "แหล่งที่มา", "แคมเปญ", "อุปกรณ์", "เบราว์เซอร์", "ขั้น", "รหัสข้อผิดพลาด", "เซสชัน", "ผู้เข้า"] as const;

function downloadCsv(name: string, text: string) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type Load = { report: Report } | { error: string } | null;

/**
 * เรียลไทม์: the live tab of Traffic. A report of the chosen period (KPIs, trend, breakdowns, bots, recent rows) and a live stream.
 * Both follow the brand scope: when the scope hides brands, the report and the stream are asked for the visible brands only.
 * The stream asks the report to reload after a connect and after each burst of events, so the numbers follow the feed.
 */
export function RealtimeTab() {
  const { list, isVisible, hidesBrands, inScopeId } = useBrandScope();
  const period = readTrafficLogPeriod(new URLSearchParams(useSearch()).get("period"));
  const domains = useBrandDomains();
  const labelOf = useCallback((id: string) => domains.get(id) ?? id, [domains]);
  const sound = useAdsbotSound();

  const scopedIds = useMemo(() => (hidesBrands && list ? list.filter((entry) => isVisible(entry.scope)).map((entry) => entry.brand.brand_id) : []), [hidesBrands, list, isVisible]);
  const scopeKey = scopedIds.join(",");
  const nothingVisible = hidesBrands && scopedIds.length === 0;

  const [load, setLoad] = useState<Load>(null);
  const [attempt, setAttempt] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const askedKey = useRef("");
  useEffect(() => {
    if (nothingVisible) { setLoad(null); return; }
    let active = true;
    const key = `${period}|${scopeKey}|${attempt}`;
    // A new period or scope clears the page; a refresh from the stream keeps the old numbers until the new ones arrive.
    if (askedKey.current !== key) { setLoad(null); askedKey.current = key; }
    api.trafficRealtime(period, scopedIds).then(
      (report) => { if (active) setLoad({ report }); },
      (e: unknown) => { if (active) setLoad((cur) => (cur && "report" in cur ? cur : { error: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" })); },
    );
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, scopeKey, attempt, refreshTick, nothingVisible]);

  const [adsbotLive, setAdsbotLive] = useState<AdsbotVisit | null>(null);
  // A visit seen under one scope is dropped when the scope changes: it could belong to a brand the new scope hides.
  useEffect(() => { setAdsbotLive(null); }, [scopeKey]);
  const tail = useTrafficTail({
    brandIds: scopedIds,
    enabled: !nothingVisible,
    onRefresh: () => setRefreshTick((n) => n + 1),
    onAdsbot: (event) => {
      setAdsbotLive({ brand: event.brand, brandLabel: event.domain, url: event.url, httpStatus: event.http_status, responseMs: event.response_ms, gatePassed: event.gate_passed, at: event.ts, sessionRef: event.session_ref });
      sound.beep();
    },
  });

  const report = load && "report" in load ? load.report : null;
  // The newest AdsBot visit: the one that just arrived on the stream, else the latest one in the report.
  const adsbotVisit = useMemo<AdsbotVisit | null>(() => {
    // The live visit counts only while its brand is in scope; the report is already asked for the scoped brands.
    if (adsbotLive && inScopeId(adsbotLive.brand)) return adsbotLive;
    const latest = report?.adsbot_last.filter((hit) => inScopeId(hit.brand)).sort((a, b) => b.at.localeCompare(a.at))[0];
    return latest ? { brand: latest.brand, brandLabel: labelOf(latest.brand), url: latest.url, httpStatus: latest.http_status, responseMs: latest.response_ms, gatePassed: latest.gate_passed, at: Date.parse(latest.at), sessionRef: null } : null;
  }, [adsbotLive, report, inScopeId, labelOf]);

  const showSession = (ref: string) => {
    const row = document.getElementById(`session-${ref}`);
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView?.({ behavior: calm ? "auto" : "smooth", block: "center" });
    row?.focus?.();
  };

  const recent = report?.recent.filter((row) => row.brand === null || inScopeId(row.brand)) ?? [];
  const exportRecent = () => downloadCsv(`realtime-${period}.csv`, csvText(RECENT_HEADERS, recent.map((row) => [
    row.at, row.event_type, row.hostname, row.brand, row.source, row.campaign, row.device, row.browser, row.form_step, row.error_code, row.session_ref, row.user_agent_family,
  ])));

  return (
    <div className="traffic-page rt-page">
      <div className="head">
        <div>
          <h1>เรียลไทม์</h1>
          <p className="sub">เหตุการณ์สดจากหน้าเว็บของแบรนด์ เวลา UTC (ดูอย่างเดียว)</p>
        </div>
        <div className="seg" role="group" aria-label="ช่วงเวลา">
          {TRAFFIC_LOG_PERIODS.map((key) => (
            <button key={key} type="button" aria-pressed={period === key} onClick={() => navigate(realtimePath(key), { replace: true })}>{PERIOD_LABEL[key]}</button>
          ))}
        </div>
      </div>
      <div className="rt-stack">
        <p className="rt-info" role="note"><Info aria-hidden="true" size={18} />ตัวเลขด้านล่างโหลดใหม่เองเมื่อมีเหตุการณ์เข้ามา ส่วนฟีดสดแสดงเฉพาะเหตุการณ์ที่เข้ามาหลังเปิดหน้านี้</p>
        <ConnectionStrip status={tail.status} lastEventAt={tail.lastEventAt} perMinute={tail.perMinute} sound={sound.enabled} onSound={sound.setEnabled} />
        {sound.saveFailed && <p className="hint" role="status">บันทึกการตั้งค่าเสียงเตือนไม่สำเร็จ ใช้ค่านี้ได้เฉพาะในหน้านี้</p>}
        {adsbotVisit && <AdsbotBanner visit={adsbotVisit} onShowSession={showSession} />}
        {nothingVisible && <EmptyState title="ขอบเขตแบรนด์ไม่มีแบรนด์ที่แสดง" hint="แก้ขอบเขตแบรนด์เพื่อดูทราฟฟิก" />}
        {!nothingVisible && !load && <Spinner />}
        {load && "error" in load && (
          <div className="note neg traffic-error" role="alert">
            <p>{load.error}</p>
            <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>ลองอีกครั้ง</button>
          </div>
        )}
        {report && (
          <>
            <section className="rt-kpis" aria-label="ตัวเลขสำคัญ">
              <div className="ledger rt-ledger">{PRIMARY.map(([id, label]) => <Kpi key={id} report={report} id={id} label={label} />)}</div>
              <div className="ledger rt-ledger rt-ledger-extra">{EXTRA.map(([id, label, hint]) => <Kpi key={id} report={report} id={id} label={label} hint={hint} />)}</div>
            </section>
            <BotsNow bots={report.bots_now} />
          </>
        )}
        {/* Keyed by the scope: a new scope starts the feed over, so a paused feed or a brand filter never keeps what the old scope showed. */}
        {!nothingVisible && <LiveStream key={scopeKey} events={tail.events} labelOf={labelOf} />}
        {report && (
          <>
            <section className="panel" aria-label="แนวโน้ม">
              <h2>แนวโน้ม</h2>
              <Trend trend={report.trend} />
            </section>
            <section className="rt-breakdowns" aria-label="แยกตาม">
              {BREAKDOWNS.map(([key, title]) => {
                const rows = key === "brand" ? report.breakdowns.brand.filter((row) => inScopeId(row.key)) : report.breakdowns[key];
                return (
                  <div className="panel" key={key} data-breakdown={key}>
                    <h2>{title}</h2>
                    {rows.length === 0 ? <p className="hint">ยังไม่มีข้อมูล</p> : (
                      <ul className="rt-rows">
                        {rows.map((row) => (
                          <li key={row.key}>
                            <span className="rt-row-key">{key === "brand" ? labelOf(row.key) : row.key}</span>
                            <span className="num">{count(row.count)} · {row.pct}%</span>
                            <span className="rt-row-bar" aria-hidden="true"><span style={{ width: `${row.pct}%` }} /></span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
            <BotsDay bots={report.bots_now} hits={report.adsbot_last.filter((hit) => inScopeId(hit.brand))} labelOf={labelOf} />
            <section className="panel" aria-label="ทราฟฟิกล่าสุด">
              <div className="traffic-recent-head">
                <h2>ทราฟฟิกล่าสุด</h2>
                <button type="button" className="btn" onClick={exportRecent} disabled={recent.length === 0}><Download aria-hidden="true" size={16} />ดาวน์โหลด CSV</button>
              </div>
              {recent.length === 0 ? <EmptyState title="ยังไม่มีทราฟฟิกในช่วงนี้" /> : (
                <div className="rt-recent stack-table">
                  <table>
                    <caption className="sr-only">ทราฟฟิกล่าสุด {recent.length} แถว</caption>
                    <thead><tr>{RECENT_HEADERS.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                    <tbody>
                      {recent.map((row, n) => (
                        <tr key={n}>
                          <td className="num">{clockIso(row.at)}</td>
                          <td>{row.event_type}</td>
                          <td>{dash(row.hostname)}</td>
                          <td>{row.brand === null ? "—" : labelOf(row.brand)}</td>
                          <td>{dash(row.source)}</td>
                          <td>{dash(row.campaign)}</td>
                          <td>{dash(row.device)}</td>
                          <td>{dash(row.browser)}</td>
                          <td className="num">{dash(row.form_step)}</td>
                          <td>{dash(row.error_code)}</td>
                          <td className="rt-mono">{dash(row.session_ref)}</td>
                          <td>{dash(row.user_agent_family)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
