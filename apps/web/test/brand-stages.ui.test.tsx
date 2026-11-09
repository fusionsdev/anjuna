import { LifecycleBrandSummary } from "@anjuna/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { adsChip, stageStatuses, STAGE_LABELS, type StageInput, type StageStatus } from "../src/client/brand-stages";
import { StageDots } from "../src/client/components/StageDots";

afterEach(cleanup);

const brand = (extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: "b1", name: "Brand One", account: "acct", hostnames: ["one.test"], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const entry = (over: Partial<{ template_approved: boolean; template_waiting_id: string | null; unknown: boolean; items: string[] }> = {}) => ({
  checklist: (over.items ?? []).map((item) => ({ item: item as never, evidence: null })), template_approved: over.template_approved ?? false,
  template_waiting_id: over.template_waiting_id ?? null, ...(over.unknown ? { unknown: true } : {}),
});
const stages = (input: Partial<StageInput> = {}) => stageStatuses({ brand: brand(), ...input });
const at = (label: (typeof STAGE_LABELS)[number], input: Partial<StageInput> = {}) => stages(input)[STAGE_LABELS.indexOf(label)];

describe("stage mapping", () => {
  it("lists the seven stages in order", () => {
    expect(STAGE_LABELS).toEqual(["สร้าง", "เทมเพลต", "ดีพลอย", "โดเมน", "ลีด", "ขายได้", "อัปโหลด"]);
    expect(stages()).toHaveLength(7);
  });

  // One case per stage and status.
  const cases: Array<[string, (typeof STAGE_LABELS)[number], Partial<StageInput>, StageStatus]> = [
    ["สร้าง: a brand always exists", "สร้าง", { brand: brand({ status: "draft" }) }, "done"],
    ["เทมเพลต: approved", "เทมเพลต", { checklist: entry({ template_approved: true }) }, "done"],
    ["เทมเพลต: a version waits for approval", "เทมเพลต", { checklist: entry({ template_waiting_id: "tv-1" }) }, "warn"],
    ["เทมเพลต: nothing approved or waiting", "เทมเพลต", { checklist: entry() }, "pending"],
    ["เทมเพลต: checklist unknown reads pending, never fail", "เทมเพลต", { checklist: entry({ unknown: true, template_approved: true }) }, "pending"],
    ["ดีพลอย: latest install ready", "ดีพลอย", { brand: brand({ latest_install: installOf("ready") }) }, "done"],
    ["ดีพลอย: latest install running", "ดีพลอย", { brand: brand({ latest_install: installOf("running") }) }, "warn"],
    ["ดีพลอย: latest install rolled back", "ดีพลอย", { brand: brand({ latest_install: installOf("rolled_back") }) }, "warn"],
    ["ดีพลอย: latest install failed", "ดีพลอย", { brand: brand({ latest_install: installOf("failed") }) }, "fail"],
    ["ดีพลอย: live brand without an install record", "ดีพลอย", {}, "done"],
    ["ดีพลอย: draft brand without an install", "ดีพลอย", { brand: brand({ status: "draft" }) }, "pending"],
    ["โดเมน: runtime sync ready", "โดเมน", {}, "done"],
    ["โดเมน: runtime sync running", "โดเมน", { brand: brand({ runtime_sync_status: "running" }) }, "warn"],
    ["โดเมน: runtime sync failed", "โดเมน", { brand: brand({ runtime_sync_status: "failed" }) }, "fail"],
    ["โดเมน: runtime sync error", "โดเมน", { brand: brand({ runtime_sync_status: "sync_error" }) }, "fail"],
    ["โดเมน: brand not live", "โดเมน", { brand: brand({ status: "draft" }) }, "pending"],
    ["ลีด: a lead in 30 days", "ลีด", { leads30: 3 }, "done"],
    ["ลีด: none in 30 days", "ลีด", { leads30: 0 }, "pending"],
    ["ลีด: funnel did not load", "ลีด", { leads30: null }, "pending"],
    ["ขายได้: test sold row", "ขายได้", { checklist: entry({ items: ["test_sold"] }) }, "done"],
    ["ขายได้: sold in 30 days", "ขายได้", { sold30: 2 }, "done"],
    ["ขายได้: neither", "ขายได้", { checklist: entry(), sold30: 0 }, "pending"],
    ["อัปโหลด: uploaded and none dead", "อัปโหลด", { uploaded: 4, dead: 0 }, "done"],
    ["อัปโหลด: any dead", "อัปโหลด", { uploaded: 4, dead: 1 }, "fail"],
    ["อัปโหลด: nothing uploaded", "อัปโหลด", { uploaded: 0, dead: 0 }, "pending"],
  ];
  it.each(cases)("%s", (_name, label, input, expected) => {
    expect(at(label, input)).toBe(expected);
  });
});

function installOf(status: string) {
  return { install_id: "ins-1", operation: "install", status, started_at: "2026-11-01T00:00:00.000Z", finished_at: null, started_by: "owner" } as never;
}

describe("Google Ads chip", () => {
  const chip = (over: Partial<Parameters<typeof adsChip>[0]> = {}) => adsChip({ brand: brand(), paused: false, spendToday: 120, clickLoss: false, ...over });
  it.each([
    ["spend today", {}, "ใช้งาน", "success"],
    ["spend today and clicks lost before the site", { clickLoss: true }, "ไม่มี gclid", "warning"],
    ["no spend rows", { spendToday: null }, "ยังไม่เชื่อม", "neutral"],
    ["spend rows with no cost yet", { spendToday: 0 }, "กำลังเรียนรู้", "info"],
    ["paused in core", { paused: true }, "หยุดชั่วคราว", "neutral"],
    ["demo brand", { brand: brand({ name: "demo1", brand_id: "demo1" }) }, "ทดลอง", "info"],
  ])("%s", (_name, over, label, tone) => {
    expect(chip(over as never)).toEqual({ label, tone });
  });
});

describe("StageDots", () => {
  it("names every stage and its state in one label", () => {
    render(<StageDots stages={["done", "warn", "fail", "pending", "pending", "pending", "pending"]} />);
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("สร้าง: เสร็จ");
    expect(label).toContain("เทมเพลต: มีปัญหา");
    expect(label).toContain("ดีพลอย: ล้มเหลว");
    expect(label).toContain("อัปโหลด: ยังไม่เริ่ม");
    expect(document.querySelectorAll(".stage-dot")).toHaveLength(7);
  });
});
