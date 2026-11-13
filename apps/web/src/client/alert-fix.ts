import type { AlertsReportResponse } from "@anjuna/contracts";
import type { Incident } from "./alert-incidents";

/**
 * The cause of an open alert in plain Thai and the one page that fixes it. Pure, so the Alerts cards and the
 * Home banner and fix list say the same cause and open the same page.
 */
export interface AlertFix { cause: string; path: string; label: string }

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const HOUR_MS = 3_600_000;

/** The instant `hours` before `iso`, in the same form hoursBefore in packages/insights alerts.ts writes. */
const hoursBefore = (iso: string, hours: number): string => new Date(Date.parse(iso) - hours * HOUR_MS).toISOString();

/**
 * `/leads?brand=<id>&status=rejected&time=decided&from=<iso>&to=<iso>`: the rejected leads of one brand whose postback
 * landed in the alert window. The rule counts postbacks from `generated_at - window_hours` up to `generated_at`, so the
 * link names that exact window and the postback time, and the list holds the leads the card counted.
 */
export function rejectedLeadsPath(brand: string, report: AlertsReportResponse): string {
  const from = hoursBefore(report.generated_at, report.reject_rate.detail.window_hours);
  return `/leads?${new URLSearchParams({ brand, status: "rejected", time: "decided", from, to: report.generated_at })}`;
}

/**
 * `/conversions?status=pending&created_before=<iso>`: every pending row the stalled rule counts. The rule counts pending rows
 * created before `generated_at - max_hours`, of any age, so the link carries that cutoff instead of a period.
 */
export function stalledConversionsPath(report: AlertsReportResponse, brand: string | null = null): string {
  const created_before = hoursBefore(report.generated_at, report.conversion_stalled.detail.max_hours);
  return `/conversions?${new URLSearchParams({ status: "pending", created_before, ...(brand ? { brand } : {}) })}`;
}

/** `/alerts?key=<key>`: the Alerts screen with that card selected. */
export const alertPath = (key: string): string => `/alerts?${new URLSearchParams({ key })}`;

/** What follows `<rule>:` in an incident id or key, or null. */
const suffix = (value: string | null | undefined, rule: string): string | null =>
  value?.startsWith(`${rule}:`) ? value.slice(rule.length + 1) : null;

const account = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

/**
 * The fix of one incident. Null only for a healthy row. A click risk row names a hostname: its brand comes from the
 * core key and its hostname from the row id. An ad spend row names an account and currency in its id.
 */
export function alertFix(
  incident: Pick<Incident, "rule" | "brand" | "level"> & Partial<Pick<Incident, "id" | "key">>,
  report: AlertsReportResponse,
): AlertFix | null {
  if (incident.level === "ok") return null;
  const brand = incident.brand;
  switch (incident.rule) {
    case "reject_rate": {
      const detail = report.reject_rate.detail;
      const row = brand ? detail.brands.find((b) => b.brand === brand) : undefined;
      if (!brand || !row) return { cause: `มีแบรนด์ที่ลีดโดนปฏิเสธเกินเกณฑ์ใน ${detail.window_hours} ชม.`, path: "/leads?status=rejected", label: "ดูลีดโดนปฏิเสธ" };
      return {
        cause: `ลีดโดนปฏิเสธ ${row.rejected} จาก ${row.decided} ราย (${percent(row.rate)}) ใน ${detail.window_hours} ชม.`,
        path: rejectedLeadsPath(brand, report),
        label: "ดูลีดโดนปฏิเสธ",
      };
    }
    case "brands_without_postbacks": {
      const detail = report.brands_without_postbacks.detail;
      const row = brand ? detail.brands.find((b) => b.brand === brand) : undefined;
      if (!brand || !row) return { cause: `มีแบรนด์ที่ลีดยังไม่มีผลจาก LeadsGate เกิน ${detail.window_hours} ชม.`, path: "/leads?status=pending", label: "ดูลีด" };
      return {
        cause: `${row.leads} ลีดยังไม่มีผลจาก LeadsGate เกิน ${detail.window_hours} ชม.`,
        path: `/leads?${new URLSearchParams({ brand, status: "pending" })}`,
        label: "ดูลีด",
      };
    }
    case "conversion_stalled": {
      const detail = report.conversion_stalled.detail;
      return {
        cause: `คอนเวอร์ชัน ${detail.stuck_count} รายการยังไม่ถูกส่งเกิน ${detail.max_hours} ชม.`,
        path: stalledConversionsPath(report, brand),
        label: "ดูคอนเวอร์ชันค้าง",
      };
    }
    case "submit_error_rate": {
      const detail = report.submit_error_rate.detail;
      const row = brand ? detail.samples.find((s) => s.brand === brand) : undefined;
      return {
        cause: row
          ? `ฟอร์มส่งไม่สำเร็จ ${row.errors} จาก ${row.submits + row.errors} ครั้ง (${percent(row.rate)}) ใน ${detail.window_hours} ชม.`
          : `มีแบรนด์ที่ฟอร์มส่งไม่สำเร็จเกินเกณฑ์ใน ${detail.window_hours} ชม.`,
        path: brand ? `/errors?${new URLSearchParams({ brand })}` : "/errors",
        label: "ดูข้อผิดพลาดของฟอร์ม",
      };
    }
    case "click_risk": {
      const detail = report.click_risk.detail;
      const hostname = suffix(incident.id, "click_risk");
      const row = hostname ? detail.hostnames.find((h) => h.hostname === hostname) : undefined;
      const riskBrand = brand ?? suffix(incident.key, "click_risk");
      return {
        cause: row
          ? `${row.hostname} คนเข้าเว็บเสี่ยงสูง ${row.high_risk} จาก ${row.visits} คน (${percent(row.rate)}) ใน ${detail.window_hours} ชม.`
          : `มีโดเมนที่คนเข้าเว็บเสี่ยงสูงเกิน ${percent(detail.alert_at)} ใน ${detail.window_hours} ชม.`,
        path: riskBrand ? `/traffic?${new URLSearchParams({ brand: riskBrand })}` : "/traffic",
        label: "ดูทราฟฟิกของแบรนด์",
      };
    }
    case "ad_spend_unallocated": {
      const detail = report.ad_spend_unallocated?.detail;
      const [id, currency] = (suffix(incident.id, "ad_spend_unallocated") ?? "").split(":");
      const row = detail?.accounts.find((a) => a.account === id && a.currency === currency);
      return {
        cause: row && detail
          ? `บัญชี ${account(row.account)} ค่าโฆษณา ${row.currency} ยังไม่ได้แบ่งให้แบรนด์ ${percent(row.share)} ใน ${detail.window_days} วัน`
          : "มีค่าโฆษณาที่ยังไม่ได้แบ่งให้แบรนด์",
        path: "/ad-allocation",
        label: "แบ่งค่าโฆษณา",
      };
    }
  }
}
