import type { AlertsReportResponse, NotificationLogRow } from "@anjuna/contracts";
import { Bell, BellRing, Coins, MousePointerBan, RotateCcw, ThumbsDown, Timer, Webhook, XCircle, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel, useBrandDomains } from "../brand-labels";
import { Chip, type ChipTone } from "../components/Chip";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { scopeAlerts } from "../home-metrics";
import { useBrandScope } from "../useBrandScope";
import "./Leads.css";
import "./Alerts.css";

type RuleId = "conversion_stalled" | "brands_without_postbacks" | "submit_error_rate" | "reject_rate" | "click_risk" | "ad_spend_unallocated";
type Level = "ok" | "warn" | "alert";
type Filter = "open" | "closed" | "all";
type Tab = "alerts" | "history";

const RULE_TITLE: Record<RuleId, string> = {
  conversion_stalled: "คอนเวอร์ชันค้าง",
  brands_without_postbacks: "แบรนด์ไม่มีโพสต์แบ็ก",
  submit_error_rate: "อัตราส่งฟอร์มผิดพลาด",
  reject_rate: "อัตราปฏิเสธ",
  click_risk: "คลิกเสี่ยงสูง",
  ad_spend_unallocated: "ค่าโฆษณายังไม่จัดสรร",
};
const RULE_ICON: Record<RuleId, LucideIcon> = {
  conversion_stalled: Timer,
  brands_without_postbacks: Webhook,
  submit_error_rate: XCircle,
  reject_rate: ThumbsDown,
  click_risk: MousePointerBan,
  ad_spend_unallocated: Coins,
};
const LEVEL_LABEL: Record<Level, string> = { ok: "ปกติ", warn: "เตือน", alert: "ผิดปกติ" };
const LEVEL_TONE: Record<Level, ChipTone> = { ok: "success", warn: "warning", alert: "danger" };
const DOT_COLOR: Record<Level, string> = { ok: "var(--ok)", warn: "var(--warn)", alert: "var(--bad)" };
const ORDER: Record<Level, number> = { alert: 0, warn: 1, ok: 2 };

const pct = (rate: number, digits = 0) => (rate * 100).toLocaleString("th-TH", { maximumFractionDigits: digits });
const when = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

/** One row of the alert list. `key` is the `<rule>:<brand>` key core stores ack and close under, or null when it cannot be known here. */
interface Incident { id: string; rule: RuleId; level: Level; key: string | null; brand: string | null; detail: string }

/**
 * Turns the alerts report into rows. Core keys an alert as `<rule>:<brand>` and the report names the brand for three rules, so
 * those rows can be acknowledged. The stalled-conversion row has no brand in the report and a click risk row has a hostname, so
 * a hostname that matches a brand domain uses that brand and the rest cannot be acknowledged from here.
 */
export function incidentsOf(report: AlertsReportResponse, brandOfHostname: (hostname: string) => string | null): Incident[] {
  const rows: Incident[] = [];
  const stalled = report.conversion_stalled;
  rows.push({
    id: "conversion_stalled", rule: "conversion_stalled", level: stalled.state, key: null, brand: null,
    detail: stalled.state === "ok"
      ? `ไม่มีรายการค้างเกิน ${stalled.detail.max_hours} ชม.`
      : `ค้าง ${stalled.detail.stuck_count} รายการ เกิน ${stalled.detail.max_hours} ชม.${stalled.detail.oldest_created_at ? ` · เก่าสุด ${when(stalled.detail.oldest_created_at)}` : ""}`,
  });
  const nobody = report.brands_without_postbacks.detail;
  if (nobody.brands.length === 0) rows.push({ id: "brands_without_postbacks", rule: "brands_without_postbacks", level: report.brands_without_postbacks.state, key: null, brand: null, detail: "ไม่มีแบรนด์เกินเกณฑ์" });
  for (const b of nobody.brands) rows.push({ id: `brands_without_postbacks:${b.brand}`, rule: "brands_without_postbacks", level: "alert", key: `brands_without_postbacks:${b.brand}`, brand: b.brand, detail: `${b.leads} ลีด ไม่มีโพสต์แบ็กใน ${nobody.window_hours} ชม.` });
  const errors = report.submit_error_rate.detail;
  if (errors.samples.length === 0) rows.push({ id: "submit_error_rate", rule: "submit_error_rate", level: report.submit_error_rate.state, key: null, brand: null, detail: "ไม่มีแบรนด์เกินเกณฑ์" });
  for (const b of errors.samples) rows.push({ id: `submit_error_rate:${b.brand}`, rule: "submit_error_rate", level: b.rate >= errors.alert_at ? "alert" : "warn", key: `submit_error_rate:${b.brand}`, brand: b.brand, detail: `ผิดพลาด ${b.errors} · ส่งฟอร์ม ${b.submits} · ${pct(b.rate, 1)}%` });
  const rejects = report.reject_rate.detail;
  if (rejects.brands.length === 0) rows.push({ id: "reject_rate", rule: "reject_rate", level: report.reject_rate.state, key: null, brand: null, detail: "ไม่มีแบรนด์เกินเกณฑ์" });
  for (const b of rejects.brands) rows.push({ id: `reject_rate:${b.brand}`, rule: "reject_rate", level: b.rate >= rejects.alert_at ? "alert" : "warn", key: `reject_rate:${b.brand}`, brand: b.brand, detail: `ปฏิเสธ ${b.rejected} จาก ${b.decided} · ${pct(b.rate, 1)}%` });
  const risk = report.click_risk.detail;
  if (risk.hostnames.length === 0) rows.push({ id: "click_risk", rule: "click_risk", level: report.click_risk.state, key: null, brand: null, detail: `ไม่มีโดเมนที่คนเข้าเว็บได้คะแนนเสี่ยงสูงเกิน ${Math.round(risk.alert_at * 100)}% ใน ${risk.window_hours} ชม.` });
  for (const h of risk.hostnames) {
    const brand = brandOfHostname(h.hostname);
    rows.push({ id: `click_risk:${h.hostname}`, rule: "click_risk", level: "alert", key: `click_risk:${brand ?? h.hostname}`, brand: null, detail: `${h.hostname}: ${Math.round(h.rate * 100)}% ของคนเข้าเว็บได้คะแนนเสี่ยงสูง` });
  }
  const spend = report.ad_spend_unallocated;
  if (spend) {
    if (spend.detail.accounts.length === 0) rows.push({ id: "ad_spend_unallocated", rule: "ad_spend_unallocated", level: spend.state, key: null, brand: null, detail: `ไม่มีบัญชีที่แคมเปญยังไม่จัดสรรเกิน ${Math.round(spend.detail.alert_at * 100)}% ของค่าโฆษณา ${spend.detail.window_days} วัน` });
    for (const a of spend.detail.accounts) rows.push({ id: `ad_spend_unallocated:${a.account}:${a.currency}`, rule: "ad_spend_unallocated", level: spend.state === "ok" ? "warn" : spend.state, key: null, brand: null, detail: `บัญชี ${a.account.slice(0, 3)}-${a.account.slice(3, 6)}-${a.account.slice(6)} · ${a.currency} · ยังไม่จัดสรร ${(a.share * 100).toLocaleString("th-TH", { maximumFractionDigits: 1 })}%` });
  }
  return rows.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

function Rule({ rule, level, text }: { rule: RuleId; level: Level; text: string }) {
  const Icon = RULE_ICON[rule];
  return (
    <li className="alert-rule">
      <Icon aria-hidden="true" className="alert-icon" />
      <div className="alert-main">
        <p className="alert-title">{RULE_TITLE[rule]}</p>
        <p className="hint">{text}</p>
      </div>
      <Chip tone={LEVEL_TONE[level]}>{LEVEL_LABEL[level]}</Chip>
      <button type="button" role="switch" aria-checked="true" disabled className="alert-switch" aria-label={`เปิดหรือปิดกฎ ${RULE_TITLE[rule]}`} title="ตั้งเปิดหรือปิดกฎไม่ได้จากหน้านี้ ยังไม่มี API กฎการแจ้งเตือน">
        <span aria-hidden="true" />
      </button>
    </li>
  );
}

function RulesCard({ report }: { report: AlertsReportResponse }) {
  const spend = report.ad_spend_unallocated;
  return (
    <section className="panel" aria-label="กฎการแจ้งเตือน">
      <h2>กฎการแจ้งเตือน</h2>
      <p className="hint">ค่าปัจจุบันของระบบ อ่านอย่างเดียว ปุ่มเปิดปิดใช้ไม่ได้จนกว่าจะมี API กฎ</p>
      <ul className="alert-rules">
        <Rule rule="conversion_stalled" level={report.conversion_stalled.state} text={`คอนเวอร์ชันค้างส่ง Google เกิน ${report.conversion_stalled.detail.max_hours} ชั่วโมง`} />
        <Rule rule="brands_without_postbacks" level={report.brands_without_postbacks.state} text={`แบรนด์ที่มีลีดแต่ไม่มีโพสต์แบ็กใน ${report.brands_without_postbacks.detail.window_hours} ชั่วโมง`} />
        <Rule rule="submit_error_rate" level={report.submit_error_rate.state} text={`เตือนที่ ${pct(report.submit_error_rate.detail.warn_at)}% ผิดปกติที่ ${pct(report.submit_error_rate.detail.alert_at)}% ใน ${report.submit_error_rate.detail.window_hours} ชั่วโมง`} />
        <Rule rule="reject_rate" level={report.reject_rate.state} text={`เตือนที่ ${pct(report.reject_rate.detail.warn_at)}% ผิดปกติที่ ${pct(report.reject_rate.detail.alert_at)}% ใน ${report.reject_rate.detail.window_hours} ชั่วโมง`} />
        <Rule rule="click_risk" level={report.click_risk.state} text={`โดเมนที่คนเข้าเว็บได้คะแนนเสี่ยงสูงเกิน ${Math.round(report.click_risk.detail.alert_at * 100)}% (อย่างน้อย ${report.click_risk.detail.min_visits} คน) ใน ${report.click_risk.detail.window_hours} ชั่วโมง`} />
        {spend && <Rule rule="ad_spend_unallocated" level={spend.state} text={`แคมเปญที่ยังไม่จัดสรรเกิน ${Math.round(spend.detail.alert_at * 100)}% ของค่าโฆษณา ${spend.detail.window_days} วัน`} />}
      </ul>
    </section>
  );
}

const FILTERS: Array<[Filter, string]> = [["open", "เปิดอยู่"], ["closed", "ปิดแล้ว"], ["all", "ทั้งหมด"]];

function AlertList({ report, domains }: { report: AlertsReportResponse; domains: Map<string, string> }) {
  const [filter, setFilter] = useState<Filter>("open");
  // What this session did. Core keeps the state but has no call that lists it, so a reload shows the report again.
  const [done, setDone] = useState<Record<string, "ack" | "close">>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const brandOfHostname = useCallback((hostname: string) => {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    for (const [id, domain] of domains) if (domain.toLowerCase().replace(/^www\./, "") === host) return id;
    return null;
  }, [domains]);
  const incidents = useMemo(() => incidentsOf(report, brandOfHostname), [report, brandOfHostname]);
  const isOpen = (i: Incident) => i.level !== "ok" && !(i.key && done[i.key]);
  const counts: Record<Filter, number> = { all: incidents.length, open: incidents.filter(isOpen).length, closed: incidents.filter((i) => !isOpen(i)).length };
  const visible = incidents.filter((i) => filter === "all" || (filter === "open") === isOpen(i));

  async function act(incident: Incident, action: "ack" | "close") {
    if (!incident.key) return;
    setNotice(null);
    setBusyKey(incident.key);
    try {
      await api.alertAction(incident.key, action);
      setDone((prev) => ({ ...prev, [incident.key!]: action }));
      setNotice({ kind: "ok", text: action === "ack" ? "รับทราบการแจ้งเตือนแล้ว" : "ปิดการแจ้งเตือนแล้ว" });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof ApiError && e.status === 404 ? "ไม่พบการแจ้งเตือนนี้ อาจกลับเป็นปกติแล้ว ลองโหลดหน้าใหม่" : e instanceof ApiError ? e.thai : "ไม่สำเร็จ" });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      <div className="filter-chips" role="group" aria-label="กรองการแจ้งเตือน">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={filter === id} aria-label={label} onClick={() => setFilter(id)}>{label}<span className="num">{counts[id]}</span></button>
        ))}
      </div>
      {notice && <p className={notice.kind === "ok" ? "alert-notice" : "alert-notice err"} role={notice.kind === "ok" ? "status" : "alert"}>{notice.text}</p>}
      <section className="panel" aria-label="รายการแจ้งเตือน">
        <h2>การแจ้งเตือน</h2>
        {visible.length === 0 ? <EmptyState title="ไม่มีการแจ้งเตือนในมุมมองนี้" /> : (
          <ul className="alert-list">
            {visible.map((i) => {
              const Icon = RULE_ICON[i.rule];
              const state = i.key ? done[i.key] : undefined;
              return (
                <li key={i.id} className={state ? "alert-row is-done" : "alert-row"}>
                  <span className="alert-dot" aria-hidden="true" style={{ background: DOT_COLOR[i.level] }} />
                  <Icon aria-hidden="true" className="alert-icon" />
                  <div className="alert-main">
                    <p className="alert-title">{RULE_TITLE[i.rule]}{i.brand && <> · <BrandLabel brandId={i.brand} domain={domains.get(i.brand)} /></>}</p>
                    <p className="hint">{i.detail}</p>
                  </div>
                  <Chip tone={LEVEL_TONE[i.level]}>{LEVEL_LABEL[i.level]}</Chip>
                  {state && <Chip tone="neutral">{state === "ack" ? "รับทราบแล้ว" : "ปิดแล้ว"}</Chip>}
                  {isOpen(i) && i.key && (
                    <span className="alert-actions">
                      <button type="button" className="btn" disabled={busyKey === i.key} aria-label={`รับทราบ ${RULE_TITLE[i.rule]}${i.brand ? ` ${domains.get(i.brand) ?? i.brand}` : ""}`} onClick={() => void act(i, "ack")}>รับทราบ</button>
                      <button type="button" className="btn" disabled={busyKey === i.key} aria-label={`ปิด ${RULE_TITLE[i.rule]}${i.brand ? ` ${domains.get(i.brand) ?? i.brand}` : ""}`} onClick={() => void act(i, "close")}>ปิด</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">ข้อมูล ณ {when(report.generated_at)}</p>
      </section>
    </>
  );
}

/** The rule and brand a notification key stands for. Keys are `<rule>:<brand>`, `digest:<day>`, `test:panel` or `adsbot:<brand>`. */
function describeKey(key: string): { title: string; brand: string | null } {
  const [rule, ...rest] = key.split(":");
  const tail = rest.join(":");
  if (rule === "digest") return { title: `สรุปรายวัน ${tail}`, brand: null };
  if (rule === "test") return { title: "ทดสอบการแจ้งเตือน", brand: null };
  if (rule === "adsbot") return { title: "AdsBot เข้าเว็บ", brand: tail || null };
  if (rule && rule in RULE_TITLE) return { title: RULE_TITLE[rule as RuleId], brand: tail && tail !== "all" ? tail : null };
  return { title: key, brand: null };
}

function History({ me, domains }: { me?: Me; domains: Map<string, string> }) {
  const [rows, setRows] = useState<NotificationLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const owner = me?.role === "owner";
  const load = useCallback(() => api.alertsLog().then(setRows, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ")), []);
  useEffect(() => { void load(); }, [load]);

  async function retry(row: NotificationLogRow) {
    setNotice(null);
    setBusyId(row.id);
    try {
      const result = await api.retryAlertSend(row.id);
      setNotice(result.status === "sent" ? { kind: "ok", text: "ส่งใหม่แล้ว" } : { kind: "err", text: `ส่งใหม่ไม่สำเร็จ${result.response_code ? ` (${result.response_code})` : ""}` });
      await load();
    } catch (e) {
      const known: Record<string, string> = { not_configured: "ยังไม่ได้ตั้งค่า Telegram", already_sent: "ส่งสำเร็จไปแล้ว", alert_resolved: "การแจ้งเตือนนี้กลับเป็นปกติแล้ว ไม่ต้องส่งใหม่" };
      setNotice({ kind: "err", text: e instanceof ApiError ? (known[e.body?.error ?? ""] ?? e.thai) : "ไม่สำเร็จ" });
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <p className="alert-notice err" role="alert">{error}</p>;
  if (!rows) return <Spinner />;
  return (
    <section className="panel" aria-label="ประวัติการส่ง">
      <h2>ประวัติการส่ง</h2>
      {notice && <p className={notice.kind === "ok" ? "alert-notice" : "alert-notice err"} role={notice.kind === "ok" ? "status" : "alert"}>{notice.text}</p>}
      {rows.length === 0 ? <EmptyState title="ยังไม่มีการส่งแจ้งเตือน" /> : (
        <div className="tw data-table">
          <table aria-label="ประวัติการส่ง">
            <thead><tr><th scope="col">เวลา</th><th scope="col">ช่องทาง</th><th scope="col">กฎ</th><th scope="col">แบรนด์</th><th scope="col">สถานะ</th><th scope="col"><span className="sr-only">ส่งใหม่</span></th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const key = describeKey(row.alert_key);
                const failed = row.status === "failed";
                return (
                  <tr key={row.id}>
                    <td data-label="เวลา">{when(row.sent_at)}</td>
                    <td data-label="ช่องทาง"><Chip tone="info"><Bell aria-hidden="true" />Telegram</Chip></td>
                    <td data-label="กฎ">{key.title}</td>
                    <td data-label="แบรนด์">{key.brand ? <BrandLabel brandId={key.brand} domain={domains.get(key.brand)} /> : "—"}</td>
                    <td data-label="สถานะ"><Chip tone={failed ? "danger" : "success"}>{failed ? `ล้มเหลว${row.response_code ? ` ${row.response_code}` : ""}` : "ส่งแล้ว"}</Chip></td>
                    <td data-label="">
                      {failed && owner && (
                        <button type="button" className="btn" disabled={busyId === row.id} aria-label={`ส่งใหม่ ${key.title}`} onClick={() => void retry(row)}><RotateCcw aria-hidden="true" className="alert-retry-icon" />ส่งใหม่</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AlertsScreen({ me }: { me?: Me } = {}) {
  const [raw, setReport] = useState<AlertsReportResponse | null>(null);
  // The brand lists follow the scope. The alert states come from core and cover every brand.
  const { inScopeId, hidesBrands } = useBrandScope();
  const report = useMemo(() => (raw ? scopeAlerts(raw, inScopeId) : raw), [raw, inScopeId]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("alerts");
  const domains = useBrandDomains();

  useEffect(() => {
    api.alerts().then(setReport, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <h1 aria-label="การแจ้งเตือน (Alerts)">การแจ้งเตือน</h1>
        <p className="hint">เรื่องที่ระบบตรวจพบและยังไม่ปิด{hidesBrands ? " · สถานะแจ้งเตือนนับทุกแบรนด์ รายชื่อแบรนด์ตามขอบเขต" : ""}</p>
      </div>
      <nav className="alert-tabs" aria-label="มุมมองการแจ้งเตือน">
        {([["alerts", "การแจ้งเตือน"], ["history", "ประวัติการส่ง"]] as const).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {tab === "history" ? <History me={me} domains={domains} /> : error ? (
        <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{error}</div>
      ) : !report ? (
        <div className="hint" role="status"><BellRing aria-hidden="true" className="alert-icon" /> กำลังโหลด…</div>
      ) : (
        <div className="alert-stack">
          <AlertList report={report} domains={domains} />
          <RulesCard report={report} />
        </div>
      )}
    </>
  );
}
