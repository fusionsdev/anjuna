import type { LifecycleBrandSummary, PanelCampaignsResponse } from "@anjuna/contracts";
import type { BrandChecklistEntry } from "./api";
import { isDemoBrand } from "./brand-health";
import { checklistFlags } from "./home-metrics";
import type { ChipTone } from "./components/Chip";

export type StageStatus = "done" | "warn" | "fail" | "pending";

/** The seven stages of a brand, in the order StageDots draws them. */
export const STAGE_LABELS = ["สร้าง", "เทมเพลต", "ดีพลอย", "โดเมน", "ลีด", "ขายได้", "อัปโหลด"] as const;
export type StageLabel = (typeof STAGE_LABELS)[number];

/**
 * What the stages read for one brand. Every counter is optional: undefined or null means the source did not answer,
 * and an unknown source reads as pending, never as failed.
 * leads30, sold30: submits and sold of the last 30 days from the funnel report.
 * hasUploaded, hasDead: whether the brand has an uploaded or a dead conversion in the same window, from brand-facts.ts. They are
 * exact per brand, or null when the source could not say. They never come from a page that other brands' rows may have filled.
 */
export interface StageInput {
  brand: Pick<LifecycleBrandSummary, "status" | "runtime_sync_status" | "latest_install">;
  checklist?: BrandChecklistEntry;
  leads30?: number | null;
  sold30?: number | null;
  hasUploaded?: boolean | null;
  hasDead?: boolean | null;
}

const isLive = (status: string) => status === "live" || status === "ready";

/**
 * One status per stage:
 * - สร้าง: the brand exists, so always done.
 * - เทมเพลต: the template is approved (done), a version waits for approval (warn), or nothing is known (pending).
 * - ดีพลอย: the latest install is ready (done), failed (fail), queued, running or rolled back (warn). No install on a live brand reads done.
 * - โดเมน: the hostname is live, meaning the runtime sync is ready (done). A failed sync is fail, a running one warn. A brand that is not live is pending.
 * - ลีด: any lead in 30 days.
 * - ขายได้: the test sold row exists, or sold in 30 days is above 0.
 * - อัปโหลด: any dead conversion (fail), else any uploaded (done), else pending. Pending also covers "not known".
 */
export function stageStatuses(input: StageInput): StageStatus[] {
  const { brand, checklist } = input;
  const known = checklist && !checklist.unknown ? checklist : undefined;
  const flags = checklistFlags(checklist);
  const install = brand.latest_install?.status;

  const template: StageStatus = known ? (known.template_approved ? "done" : known.template_waiting_id ? "warn" : "pending") : "pending";

  const deploy: StageStatus = install === "ready" ? "done"
    : install === "failed" ? "fail"
      : install === "queued" || install === "running" || install === "rolled_back" ? "warn"
        : isLive(brand.status) ? "done" : "pending";

  const domain: StageStatus = !isLive(brand.status) ? "pending"
    : brand.runtime_sync_status === "ready" ? "done"
      : brand.runtime_sync_status === "failed" || brand.runtime_sync_status === "sync_error" ? "fail" : "warn";

  const lead: StageStatus = (input.leads30 ?? 0) > 0 ? "done" : "pending";
  const sold: StageStatus = flags.test_sold === true || (input.sold30 ?? 0) > 0 ? "done" : "pending";
  // An unknown answer reads pending: the dot says "not started", the label says nothing was shown to be wrong.
  const upload: StageStatus = input.hasDead === true ? "fail" : input.hasUploaded === true ? "done" : "pending";

  return ["done", template, deploy, domain, lead, sold, upload];
}

export const STAGE_STATUS_TEXT: Record<StageStatus, string> = { done: "เสร็จ", warn: "มีปัญหา", fail: "ล้มเหลว", pending: "ยังไม่เริ่ม" };

export type AdsChipLabel = "ใช้งาน" | "ไม่มี gclid" | "ยังไม่เชื่อม" | "ยังไม่มีแคมเปญ" | "กำลังสร้าง" | "เปิดแล้ว" | "สร้างไม่สำเร็จ" | "หยุดชั่วคราว" | "ทดลอง";
export interface AdsChip { label: AdsChipLabel; tone: ChipTone }

/**
 * The Google Ads chip of a brand row, from what the panel really knows. First match wins:
 * demo brand (ทดลอง), paused in core (หยุดชั่วคราว); then the campaigns read:
 * not read yet or failed gives null (the cell shows a dash, never "not connected"); a brand absent from `brands` has no Google Ads
 * account (ยังไม่เชื่อม); an account with no campaign (ยังไม่มีแคมเปญ); cost today above 0 (ใช้งาน, or ไม่มี gclid when billed clicks did not reach the site);
 * an enabled campaign (เปิดแล้ว); a campaign being drafted or enabled (กำลังสร้าง); only paused ones (หยุดชั่วคราว); only failed ones (สร้างไม่สำเร็จ).
 * A zero or a missing spend report never reads as a state: nothing here says "learning".
 * spendToday: the cost of today for this brand, 0 when the report answered and has none, null when it is not known (employee, failed, loading).
 */
export function adsChip(input: { brand: LifecycleBrandSummary; paused: boolean; ads: PanelCampaignsResponse | null | undefined; spendToday: number | null; clickLoss: boolean }): AdsChip | null {
  if (isDemoBrand(input.brand)) return { label: "ทดลอง", tone: "info" };
  if (input.paused || input.brand.status === "paused") return { label: "หยุดชั่วคราว", tone: "neutral" };
  const { ads } = input;
  if (!ads) return null;
  const id = input.brand.brand_id;
  if (!ads.brands.some((row) => row.brand_id === id)) return { label: "ยังไม่เชื่อม", tone: "neutral" };
  const campaigns = ads.campaigns.filter((row) => row.brand_id === id && row.state !== "removed");
  if (campaigns.length === 0) return { label: "ยังไม่มีแคมเปญ", tone: "neutral" };
  if (input.spendToday !== null && input.spendToday > 0) return input.clickLoss ? { label: "ไม่มี gclid", tone: "warning" } : { label: "ใช้งาน", tone: "success" };
  if (campaigns.some((row) => row.state === "enabled")) return { label: "เปิดแล้ว", tone: "neutral" };
  if (campaigns.some((row) => row.state === "drafting" || row.state === "draft" || row.state === "enabling")) return { label: "กำลังสร้าง", tone: "info" };
  if (campaigns.every((row) => row.state === "paused")) return { label: "หยุดชั่วคราว", tone: "neutral" };
  if (campaigns.every((row) => row.state === "failed")) return { label: "สร้างไม่สำเร็จ", tone: "danger" };
  return null;
}
