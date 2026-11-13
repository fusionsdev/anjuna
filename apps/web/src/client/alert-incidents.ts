import type { AlertsReportResponse } from "@anjuna/contracts";

/**
 * The alert rows of the Alerts screen and the open count the sidebar badge shows. Pure, so GET /api/nav/counts runs the same code
 * as the screen and the badge equals the screen's เปิดอยู่ count.
 */

export type RuleId = "conversion_stalled" | "brands_without_postbacks" | "submit_error_rate" | "reject_rate" | "click_risk" | "ad_spend_unallocated";
export type Level = "ok" | "warn" | "alert";

const ORDER: Record<Level, number> = { alert: 0, warn: 1, ok: 2 };

export const pct = (rate: number, digits = 0) => (rate * 100).toLocaleString("th-TH", { maximumFractionDigits: digits });
export const when = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

/** One row of the alert list. `key` is the `<rule>:<brand>` key core stores ack and close under, or null when it cannot be known here. */
export interface Incident { id: string; rule: RuleId; level: Level; key: string | null; brand: string | null; detail: string }

/**
 * Turns the alerts report into rows. Core keys an alert as `<rule>:<brand>` and the report names the brand for three rules, so
 * those rows can be acknowledged. The stalled-conversion row has no brand in the report and a click risk row has a hostname, so
 * a hostname that matches a brand domain uses that brand and the rest has no key: its buttons show disabled with the reason.
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
    // Core keys a click risk alert by brand. A hostname that matches no brand domain has no key, so its buttons stay disabled.
    rows.push({ id: `click_risk:${h.hostname}`, rule: "click_risk", level: "alert", key: brand ? `click_risk:${brand}` : null, brand: null, detail: `${h.hostname} · เสี่ยงสูง ${h.high_risk} จาก ${h.visits} คน (${Math.round(h.rate * 100)}%)` });
  }
  const spend = report.ad_spend_unallocated;
  if (spend) {
    if (spend.detail.accounts.length === 0) rows.push({ id: "ad_spend_unallocated", rule: "ad_spend_unallocated", level: spend.state, key: null, brand: null, detail: `ไม่มีบัญชีที่แคมเปญยังไม่จัดสรรเกิน ${Math.round(spend.detail.alert_at * 100)}% ของค่าโฆษณา ${spend.detail.window_days} วัน` });
    for (const a of spend.detail.accounts) rows.push({ id: `ad_spend_unallocated:${a.account}:${a.currency}`, rule: "ad_spend_unallocated", level: spend.state === "ok" ? "warn" : spend.state, key: null, brand: null, detail: `บัญชี ${a.account.slice(0, 3)}-${a.account.slice(3, 6)}-${a.account.slice(6)} · ${a.currency} · ยังไม่จัดสรร ${(a.share * 100).toLocaleString("th-TH", { maximumFractionDigits: 1 })}%` });
  }
  return rows.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

/** The brand whose domain is the hostname, ignoring case and a leading www. Null when no brand domain matches. */
export function hostnameBrand(domains: ReadonlyMap<string, string>): (hostname: string) => string | null {
  return (hostname) => {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    for (const [id, domain] of domains) if (domain.toLowerCase().replace(/^www\./, "") === host) return id;
    return null;
  };
}

/** Open under เปิดอยู่: not healthy, and core stored no close for its key. An acknowledged incident stays open. */
export function isOpenIncident(incident: Incident, states: ReadonlyMap<string, { closed_at: string | null }>): boolean {
  if (incident.level === "ok") return false;
  return !(incident.key && states.get(incident.key)?.closed_at);
}

/** The เปิดอยู่ count of the Alerts screen for a report already cut to the brand scope. */
export function openAlertCount(report: AlertsReportResponse, states: ReadonlyMap<string, { closed_at: string | null }>, brandOfHostname: (hostname: string) => string | null): number {
  return incidentsOf(report, brandOfHostname).filter((incident) => isOpenIncident(incident, states)).length;
}
