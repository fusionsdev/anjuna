import type { FlowGateMode, InstallOperation } from "@anjuna/contracts";
import type { Tone } from "./components/StatusBadge";

export const statusLabel: Record<string, string> = {
  draft: "ฉบับร่าง (draft)", queued: "รอคิว (queued)", running: "กำลังทำงาน (running)", ready: "พร้อมใช้งาน (ready)",
  failed: "ล้มเหลว (failed)", rolled_back: "ย้อนกลับแล้ว (rolled-back)", detached: "ถอดออกแล้ว (detached)", unmanaged: "ไม่ได้จัดการ (unmanaged)", sync_error: "ซิงก์ผิดพลาด (sync_error)",
  paused: "หยุดชั่วคราว (paused)",
};

// A redeploy is stored as an upgrade row; the server tells the two apart in `operation`.
export const operationLabel: Record<InstallOperation, string> = {
  install: "ติดตั้ง (Install)", rollback: "ย้อนกลับ (Rollback)", upgrade: "อัปเกรดทุกแบรนด์ (Upgrade-all)", redeploy: "ติดตั้งใหม่ (Redeploy)",
};

// The pill colour of a brand status: live is money green, a failure is red, work in progress is blue, a pause or rollback is amber.
export const statusBadgeTone: Record<string, Tone> = {
  live: "live", failed: "bad", rolled_back: "warn", installing: "blue", draft: "mute", paused: "warn", unmanaged: "mute", retired: "mute",
};

/** What the Owner reads for a flow gate mode; the stored values stay `param` and `signed_cookie`. */
export const flowGateLabel: Record<FlowGateMode, string> = { param: "Keyword Param", signed_cookie: "Single Page Cookie" };
