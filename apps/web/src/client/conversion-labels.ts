import type { ConversionReasonCode } from "@anjuna/contracts";

/** Thai label and one fix line per reason code. The strings are the spec "UI text per code" table. */
export const REASON_TEXT: Record<ConversionReasonCode, { label: string; fix: string }> = {
  no_click_id: { label: "ไม่มี click id (No click id)", fix: "Lead มาโดยไม่มี gclid/gbraid/wbraid/msclkid. ส่งขึ้น Ads ไม่ได้. ตรวจว่าแคมเปญเปิด auto-tagging." },
  lease_exhausted: { label: "ลองครบแล้ว (Attempts exhausted)", fix: "เส้นทางส่งยอดขายดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของเส้นทางส่งยอดขายบน VPS." },
  no_route: { label: "ไม่มีเส้นทางส่งยอดขาย", fix: "เส้นทางส่งยอดขายไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. ตั้งเส้นทางส่งยอดขายของแบรนด์นี้บน VPS." },
  not_ready: { label: "ยังไม่พร้อม (Not ready)", fix: "Ads ยังไม่รับ click นี้. เส้นทางส่งยอดขายจะลองใหม่เอง." },
  ms_env_missing: { label: "ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing)", fix: "ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของเส้นทางส่งยอดขาย." },
  upload_failed: { label: "อัปโหลดไม่ผ่าน (Upload failed)", fix: "Ads ตอบ error. เส้นทางส่งยอดขายจะลองใหม่ตาม backoff." },
  platform_error: { label: "Ads ตอบ error (Platform error)", fix: "ดูข้อความ error เต็มในแถว." },
};

/** The error classes of a dead row the Conversions page names in plain Thai. */
export type DeadClass = "one_per_click" | "adkit_failed" | "no_click_id" | "unknown";

/**
 * What a dead row means and what to do. Core never moves a dead row back to pending (conversions.ts parks it
 * after CONV_MAX_ATTEMPTS). The panel has no resend route yet, so the AdKit text names the failure only and the
 * raw error sits behind ดูรายละเอียด.
 */
export const DEAD_TEXT: Record<DeadClass, string> = {
  one_per_click: "ส่งซ้ำ Google Ads รับครั้งเดียวต่อคลิก ไม่ต้องทำอะไร",
  adkit_failed: "AdKit ขัดข้อง ส่งไม่สำเร็จ",
  no_click_id: "ไม่มีรหัสคลิก คนเข้าเว็บไม่ได้มาจากโฆษณา ส่งไม่ได้",
  unknown: "ส่งไม่สำเร็จ",
};

/** The short name of each class, for a count line such as "ส่งซ้ำ 7 · AdKit ขัดข้อง 9". */
export const DEAD_SHORT: Record<DeadClass, string> = {
  one_per_click: "ส่งซ้ำ",
  adkit_failed: "AdKit ขัดข้อง",
  no_click_id: "ไม่มีรหัสคลิก",
  unknown: "อื่นๆ",
};

// Google Ads refuses a second conversion for the same click and action; the drain stores its text as last_error.
const ONE_PER_CLICK = /one[-_ ]?(conversion[-_ ]?)?per[-_ ]?click|CLICK_CONVERSION_ALREADY_EXISTS/i;
// The drain stores the Node child_process message when the AdKit CLI exits non-zero.
const ADKIT_FAILED = /^\s*command failed:/i;
// Reason codes whose existing label and fix already say what to do; a dead row with one keeps that text.
const OWN_TEXT: ReadonlySet<ConversionReasonCode> = new Set(["lease_exhausted", "no_route", "not_ready", "ms_env_missing"]);

/**
 * The class of a dead row, read from its reason code and error text. One-per-click is checked before the AdKit
 * failure because the CLI message carries the Google Ads error. Null when the reason code has its own text.
 * An employee gets no free text from core, so an unrecognised code reads as unknown.
 */
export function deadClass(row: { reason_code: ConversionReasonCode | null; last_error: string | null }): DeadClass | null {
  const text = row.last_error ?? "";
  if (ONE_PER_CLICK.test(text)) return "one_per_click";
  if (ADKIT_FAILED.test(text)) return "adkit_failed";
  if (row.reason_code === "no_click_id") return "no_click_id";
  if (row.reason_code && OWN_TEXT.has(row.reason_code)) return null;
  return "unknown";
}
