/**
 * Short Thai + English error text for the wizard: one message per validation error and per server error.
 * The contracts keep their own English messages for the API; the employee sees these.
 */
import { COPY_KEYWORD_MARKER, COPY_LIMITS, type CopyField, type CopyIssue } from "@anjuna/contracts";
import { ApiError } from "../api";
import type { FieldKey } from "./steps";

export const FIELD_LABEL: Record<FieldKey, string> = {
  name: "ชื่อแบรนด์",
  domain: "โดเมน",
  keyword: "คีย์เวิร์ด",
  phone: "โทรศัพท์",
  address: "ที่อยู่",
  email: "อีเมล",
  template_version_id: "เทมเพลต",
  brand_name: "ชื่อแบรนด์บนเว็บ",
  site_title: "ชื่อหน้า",
  site_description: "คำอธิบาย",
  h1: "หัวข้อหลัก H1",
  cta: "ปุ่ม CTA",
  sub: "ข้อความรอง",
  google_ads_account: "บัญชี Google Ads",
  google_conversion_action: "รหัส conversion action",
  adkit_project: "โปรเจกต์ AdKit",
  microsoft_ads_account: "บัญชี Microsoft Ads",
};

/** Wizard step 4 (AdKit directory and the conversion action job). Thai only. */
export const TRACKING_TEXT = {
  project: "โปรเจกต์ AdKit",
  account: "บัญชี Google Ads",
  conversion: "conversion action",
  pickProject: "เลือกโปรเจกต์",
  pickAccount: "เลือกบัญชี",
  notListed: "ไม่อยู่ในรายการล่าสุด",
  stale: "ยังไม่มีข้อมูลจาก AdKit หรือข้อมูลเก่ากว่า 2 ชั่วโมง",
  loadFailed: "โหลดข้อมูล AdKit ไม่สำเร็จ",
  create: "สร้าง conversion action",
  retry: "ลองสร้างใหม่",
  needAccount: "เลือกบัญชี Google Ads ก่อนสร้าง conversion action",
  readOnly: "Owner กำหนดค่านี้ · แสดงอย่างเดียว",
  // held and unknown occur only on campaign jobs; the labels keep the map total over every job status.
  job: { queued: "รอคิว", claimed: "กำลังสร้าง", done: "สร้างแล้ว", failed: "สร้างไม่สำเร็จ", held: "รอตรวจวงเงิน", unknown: "ไม่ทราบผล" },
  pollFailed: "ตรวจสถานะงานไม่สำเร็จ จะลองใหม่อัตโนมัติ",
  pollStopped: "หยุดตรวจสถานะแล้ว งานรอนานเกิน 30 นาที",
  checkAgain: "ตรวจสถานะอีกครั้ง",
} as const;

/** Why the Generate button is off for an employee: generate is owner only (spec). */
export const GENERATE_OWNER_ONLY = "เฉพาะ Owner สร้างเว็บไซต์ได้ ฉบับร่างบันทึกแล้ว ให้ Owner กดสร้าง";

export const requiredText = (field: FieldKey): string => `${FIELD_LABEL[field]}: จำเป็นต้องกรอก`;

export interface IssueLike {
  code: string;
  message: string;
  maximum?: unknown;
  minimum?: unknown;
}

const FORMAT: Partial<Record<FieldKey, string>> = {
  name: "ใช้ได้เฉพาะตัวอักษร ตัวเลข ช่องว่าง และ & . ' -",
  domain: "รูปแบบโดเมนไม่ถูกต้อง เช่น example.com",
  keyword: "ไม่มีตัวอักษรเหลือหลังจัดรูปแบบ",
  phone: "ใช้ตัวเลข ช่องว่าง และ + - ( ) เท่านั้น ยาว 7 ถึง 20 ตัว",
  email: "อีเมลไม่ถูกต้อง",
  template_version_id: "เลือกเทมเพลตที่อนุมัติแล้ว",
  google_ads_account: "ต้องเป็นเลข 10 หลักไม่มีขีด",
  google_conversion_action: "ต้องเป็นตัวเลข 1 ถึง 20 หลัก",
  adkit_project: "ใช้ A-Z a-z 0-9 _ - ไม่เกิน 64 ตัว",
  microsoft_ads_account: "ต้องเป็นเลข 6 ถึง 12 หลัก",
};

/** One short message for a contract issue on a form field. */
export function describeIssue(field: FieldKey, issue: IssueLike): string {
  const label = FIELD_LABEL[field];
  const { message } = issue;
  const text = (() => {
    if (/forbidden platform string/i.test(message)) return "มีคำที่ไม่อนุญาต";
    if (/personal loan/i.test(message)) return 'ห้ามใช้คำว่า "personal loan"';
    if (/plain text/i.test(message)) return 'ใช้ข้อความธรรมดา ห้ามมี < > "';
    if (/www hostname/i.test(message)) return "ใช้โดเมนหลัก ไม่ใช่ www";
    if (issue.code === "too_big" && issue.maximum !== undefined) {
      return `ยาวเกินไป สูงสุด ${String(issue.maximum)} ตัวอักษร`;
    }
    return FORMAT[field] ?? `ข้อมูลไม่ถูกต้อง: ${message}`;
  })();
  return `${label}: ${text}`;
}

/** One finding of validateCopy for the h1, cta or sub field, in Thai and English. The contract's own message stays in the API. */
export function describeCopyIssue(field: CopyField, issue: CopyIssue): string {
  const label = FIELD_LABEL[field];
  const text = (() => {
    switch (issue.code) {
      case "plain_text": return 'ใช้ข้อความบรรทัดเดียว ห้ามมี < > "';
      case "length": return `ยาวเกิน ${COPY_LIMITS[field]} ตัวอักษรที่มองเห็น`;
      case "forbidden_wording": return 'ห้ามใช้คำว่า "personal loan"';
      case "brand_clean": return "มีคำหรือรหัสที่ไม่อนุญาต";
      case "keyword_slot": return field === "h1"
        ? `ใส่ ${COPY_KEYWORD_MARKER} หนึ่งครั้งพอดี และห้ามมี { } อย่างอื่น`
        : "ห้ามมี { }";
      default: return `ข้อมูลไม่ถูกต้อง: ${issue.message}`;
    }
  })();
  return `${label}: ${text}`;
}

/** A server error as one short Thai + English line. */
export function wizardErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return "ดำเนินการไม่สำเร็จ";
  const code = error.body?.error;
  const message = error.body?.message ?? "";
  if (error.status === 409 && /domain is already registered/i.test(message)) return "โดเมนนี้ถูกใช้แล้ว";
  if (code === "draft_incomplete") {
    // Generate answers 422 draft_incomplete with Thai + English issues (apps/web/src/server/generate.ts).
    return error.body?.issues?.[0]?.message ?? "ฉบับร่างยังไม่ครบ";
  }
  if (code === "lifecycle_operation_active") return "กำลังติดตั้งแบรนด์นี้อยู่ แก้ไขไม่ได้";
  if (error.status === 409) return "ฉบับร่างถูกแก้ไขหรือติดตั้งแล้ว กรุณาโหลดใหม่";
  if (code === "template_not_sealed") return "เทมเพลตนี้ยังไม่ได้อนุมัติ";
  if (code === "compatible_form_artifact_missing") return "ยังไม่มีฟอร์มที่ใช้ได้";
  if (code === "tenant_configuration_missing") return "ยังไม่ได้ตั้งค่า tenant";
  if (code === "zone_check_unavailable" || code === "zone_check_failed") return "ตรวจโซน Cloudflare ไม่สำเร็จ ลองใหม่ภายหลัง";
  if (code === "preview_unavailable") return "แสดงตัวอย่างไม่ได้";
  if (code === "forbidden_role") return "สิทธิ์ไม่เพียงพอ ต้องเป็น Owner";
  return error.thai;
}
