import type { LifecycleBrandSummary } from "@anjuna/contracts";
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
 * leads30, sold30: submits and sold of the last 30 days from the funnel report. uploaded, dead: conversion rows of the same window.
 */
export interface StageInput {
  brand: Pick<LifecycleBrandSummary, "status" | "runtime_sync_status" | "latest_install">;
  checklist?: BrandChecklistEntry;
  leads30?: number | null;
  sold30?: number | null;
  uploaded?: number | null;
  dead?: number | null;
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
 * - อัปโหลด: conversions uploaded above 0 and none dead (done), any dead (fail).
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
  const upload: StageStatus = (input.dead ?? 0) > 0 ? "fail" : (input.uploaded ?? 0) > 0 ? "done" : "pending";

  return ["done", template, deploy, domain, lead, sold, upload];
}

export const STAGE_STATUS_TEXT: Record<StageStatus, string> = { done: "เสร็จ", warn: "มีปัญหา", fail: "ล้มเหลว", pending: "ยังไม่เริ่ม" };

export type AdsChipLabel = "ใช้งาน" | "ไม่มี gclid" | "ยังไม่เชื่อม" | "กำลังเรียนรู้" | "หยุดชั่วคราว" | "ทดลอง";
export interface AdsChip { label: AdsChipLabel; tone: ChipTone }

/**
 * The Google Ads chip of a brand row. First match wins:
 * demo brand (ทดลอง), paused (หยุดชั่วคราว), no spend rows at all (ยังไม่เชื่อม),
 * spend today with fewer clicks reaching the site than Google billed (ไม่มี gclid), spend today (ใช้งาน), spend rows with no cost yet (กำลังเรียนรู้).
 * spendToday: null when the brand has no spend rows, else the cost of today across its rows.
 */
export function adsChip(input: { brand: LifecycleBrandSummary; paused: boolean; spendToday: number | null; clickLoss: boolean }): AdsChip {
  if (isDemoBrand(input.brand)) return { label: "ทดลอง", tone: "info" };
  if (input.paused || input.brand.status === "paused") return { label: "หยุดชั่วคราว", tone: "neutral" };
  if (input.spendToday === null) return { label: "ยังไม่เชื่อม", tone: "neutral" };
  if (input.spendToday > 0) return input.clickLoss ? { label: "ไม่มี gclid", tone: "warning" } : { label: "ใช้งาน", tone: "success" };
  return { label: "กำลังเรียนรู้", tone: "info" };
}
