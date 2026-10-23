import type { ConversionReasonCode } from "@anjuna/contracts";

/** Thai label and one fix line per reason code. The strings are the spec "UI text per code" table. */
export const REASON_TEXT: Record<ConversionReasonCode, { label: string; fix: string }> = {
  no_click_id: { label: "ไม่มี click id (No click id)", fix: "Lead มาโดยไม่มี gclid/gbraid/wbraid/msclkid. ส่งขึ้น Ads ไม่ได้. ตรวจว่าแคมเปญเปิด auto-tagging." },
  lease_exhausted: { label: "ลองครบแล้ว (Attempts exhausted)", fix: "Drain ดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของ drain บน VPS." },
  no_route: { label: "ไม่มี route (No route)", fix: "Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS." },
  not_ready: { label: "ยังไม่พร้อม (Not ready)", fix: "Ads ยังไม่รับ click นี้. Drain จะลองใหม่เอง." },
  ms_env_missing: { label: "ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing)", fix: "ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของ drain." },
  upload_failed: { label: "อัปโหลดไม่ผ่าน (Upload failed)", fix: "Ads ตอบ error. Drain จะลองใหม่ตาม backoff." },
  platform_error: { label: "Ads ตอบ error (Platform error)", fix: "ดูข้อความ error เต็มในแถว." },
};
