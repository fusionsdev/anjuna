import { CONVERSION_STALLED_HOURS, type AlertsReportResponse, type ConversionsReportResponse } from "@anjuna/contracts";
import { conversionsPath } from "../Conversions";
import { inApp } from "./shared";

export type HomePeriod = "today" | "7d" | "30d";

export type FixKind = "gclid" | "retry" | "drain-route" | "leads" | "details";
/** What the item's button says. Every kind not listed here reads "ดูรายละเอียด". */
export const FIX_LABEL: Record<FixKind, string> = { gclid: "ตรวจ gclid", retry: "ลองใหม่", "drain-route": "ตั้ง drain route", leads: "ดูลีด", details: "ดูรายละเอียด" };
/**
 * An item with a `path` links there; one with `onAct` runs that; one with neither opens the alerts screen.
 * `kind` picks the button label.
 */
export interface FixItem { id: string; level: "bad" | "warn"; brand: string; message: string; path?: string; kind?: FixKind; onAct?: () => void }

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

const level = (state: "ok" | "warn" | "alert"): "bad" | "warn" => (state === "alert" ? "bad" : "warn");

/** The conversion items. The links keep the period Home shows; stalled rows count at any age, so theirs uses the widest list. */
function conversionItems(report: ConversionsReportResponse, period: HomePeriod): FixItem[] {
  const items: FixItem[] = [];
  if (report.totals.dead > 0) items.push({ id: "conversions:dead", level: "bad", brand: "ทุกแบรนด์", kind: "retry", message: `คอนเวอร์ชันส่งไม่ได้ ${report.totals.dead} รายการ`, path: conversionsPath({ period, status: "dead", brand: null }) });
  if (report.stalled > 0) items.push({ id: "conversions:stalled", level: "warn", brand: "ทุกแบรนด์", message: `คอนเวอร์ชันค้างเกิน ${CONVERSION_STALLED_HOURS} ชม. ${report.stalled} รายการ`, path: conversionsPath({ period: "30d", status: "pending", brand: null }) });
  return items;
}

/** The stalled alert counts the same pending rows as the conversions report, so `stalledElsewhere` drops it and one entry remains. */
function alertItems(report: AlertsReportResponse, stalledElsewhere: boolean): FixItem[] {
  const items: FixItem[] = [];
  const stalled = report.conversion_stalled;
  if (stalled.state !== "ok" && stalled.detail.stuck_count > 0 && !stalledElsewhere) {
    items.push({ id: "stalled", level: level(stalled.state), brand: "ทุกแบรนด์", message: `${stalled.detail.stuck_count} คอนเวอร์ชันยังไม่ถูกส่งเกิน ${stalled.detail.max_hours} ชั่วโมง` });
  }
  const noPostback = report.brands_without_postbacks;
  if (noPostback.state !== "ok") {
    for (const b of noPostback.detail.brands) items.push({ id: `postback:${b.brand}`, level: level(noPostback.state), brand: b.brand, kind: "leads", path: `/leads?brand=${encodeURIComponent(b.brand)}`, message: `${b.leads} ลีดยังไม่มีผลจาก LeadsGate เกิน ${noPostback.detail.window_hours} ชั่วโมง` });
  }
  const submitErrors = report.submit_error_rate;
  if (submitErrors.state !== "ok") {
    for (const s of submitErrors.detail.samples) items.push({ id: `submit:${s.brand}`, level: level(submitErrors.state), brand: s.brand, message: `ส่งฟอร์มผิดพลาด ${percent(s.rate)} (${s.errors} จาก ${s.submits + s.errors} ครั้ง)` });
  }
  const rejects = report.reject_rate;
  if (rejects.state !== "ok") {
    for (const b of rejects.detail.brands) items.push({ id: `reject:${b.brand}`, level: level(rejects.state), brand: b.brand, message: `อัตรา reject ${percent(b.rate)} สูงกว่าค่าปกติ ${percent(rejects.detail.warn_at)}` });
  }
  return items;
}

/** Each source adds its items once it answered: `undefined` is loading and `null` is failed, and neither blocks the other. Bad items come first. */
export function fixItems(alerts: AlertsReportResponse | null | undefined, conversions: ConversionsReportResponse | null | undefined, period: HomePeriod, extra: FixItem[] = []): FixItem[] {
  const items = [...(conversions ? conversionItems(conversions, period) : []), ...(alerts ? alertItems(alerts, (conversions?.stalled ?? 0) > 0) : []), ...extra];
  return items.sort((a, b) => Number(b.level === "bad") - Number(a.level === "bad"));
}

/** The top 4 things to fix. A source that is still loading or failed says so on its own line and never reads as "nothing to fix". */
export function NeedsFixList({ alerts, conversions, fixes, onAlerts }: {
  alerts: AlertsReportResponse | null | undefined;
  conversions: ConversionsReportResponse | null | undefined;
  fixes: FixItem[];
  onAlerts: () => void;
}) {
  return (
    <section className="panel" aria-label="ต้องแก้">
      <div className="home-ptitle">
        <h2>ต้องแก้</h2>
        <button type="button" className="btn" onClick={onAlerts}>ดูทั้งหมด</button>
      </div>
      {alerts === undefined && <p className="hint">…</p>}
      {alerts === null && <p className="hint">— โหลดการแจ้งเตือนไม่สำเร็จ</p>}
      {conversions === null && <p className="hint">— โหลดคอนเวอร์ชันไม่สำเร็จ</p>}
      {/* Each source shows its items on its own. "Nothing to fix" needs both to have answered, since a missing source may hide items.
          While alerts load, their own "…" line already stands, so the conversions line waits for alerts to answer or fail. */}
      {alerts !== undefined && conversions === undefined && fixes.length === 0 && <p className="hint">…</p>}
      {alerts && conversions && fixes.length === 0 && <p className="hint">ไม่มีเรื่องที่ต้องแก้</p>}
      {fixes.slice(0, 4).map((item) => (
        <div className="home-item" key={item.id}>
          <span className="dot" style={{ background: item.level === "bad" ? "var(--bad)" : "var(--leak)" }} aria-hidden="true" />
          <div className="t"><b style={{ fontWeight: 500 }}>{item.brand}</b><span>{item.message}</span></div>
          {item.path
            ? <a className="btn" href={item.path} onClick={inApp(item.path)}>{FIX_LABEL[item.kind ?? "details"]}</a>
            : <button type="button" className="btn" onClick={item.onAct ?? onAlerts}>{FIX_LABEL[item.kind ?? "details"]}</button>}
        </div>
      ))}
    </section>
  );
}
