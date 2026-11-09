import { LifecycleBrandSummary } from "@anjuna/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { loadUploadFacts } from "../src/client/brand-facts";
import { adsChip, stageStatuses, stageUnknowns, STAGE_LABELS, type StageInput, type StageStatus } from "../src/client/brand-stages";
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
    ["อัปโหลด: uploaded and none dead", "อัปโหลด", { hasUploaded: true, hasDead: false }, "done"],
    ["อัปโหลด: any dead", "อัปโหลด", { hasUploaded: true, hasDead: true }, "fail"],
    ["อัปโหลด: nothing uploaded", "อัปโหลด", { hasUploaded: false, hasDead: false }, "pending"],
    ["อัปโหลด: not known reads pending, never done or fail", "อัปโหลด", { hasUploaded: null, hasDead: null }, "pending"],
    // Done needs "uploaded" and "no dead". With the dead read failed the answer is unknown, never done.
    ["อัปโหลด: uploaded known, dead read failed reads pending, never done", "อัปโหลด", { hasUploaded: true, hasDead: null }, "pending"],
    ["อัปโหลด: dead known as none, uploaded read failed", "อัปโหลด", { hasUploaded: null, hasDead: false }, "pending"],
    ["อัปโหลด: a dead row settles it even when the uploaded read failed", "อัปโหลด", { hasUploaded: null, hasDead: true }, "fail"],
  ];
  it.each(cases)("%s", (_name, label, input, expected) => {
    expect(at(label, input)).toBe(expected);
  });
});

function installOf(status: string) {
  return { install_id: "ins-1", operation: "install", status, started_at: "2026-11-01T00:00:00.000Z", finished_at: null, started_by: "owner" } as never;
}

describe("Google Ads chip", () => {
  const camp = (state: string, brand_id = "b1") => ({ draft_job_id: "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f", campaign_id: null, brand_id, account: "1234567890", name: "demo-search-1", daily_budget: 100, currency: "THB", daily_budget_thb: 100, state, updated_at: "2026-11-10T00:00:00.000Z", geo: { country: "US" }, final_url: "https://x.test/" });
  const ads = (campaigns: ReturnType<typeof camp>[], withAccount = true) => ({ campaigns, brands: withAccount ? [{ brand_id: "b1", currency: "THB", thb_per_unit: 1, committed_thb_day: 0 }] : [], caps: { total_thb_day: 1, brand_thb_day: 1 }, enabled_total_thb_day: 0 }) as never;
  const chip = (over: Partial<Parameters<typeof adsChip>[0]> = {}) => adsChip({ brand: brand({ brand_id: "b1" }), paused: false, ads: ads([camp("enabled")]), spendToday: null, ...over });
  it.each([
    ["spend today on an enabled campaign", { spendToday: 120 }, { label: "ใช้งาน", tone: "success" }],
    ["no Google Ads account for the brand", { ads: ads([], false) }, { label: "ยังไม่เชื่อม", tone: "neutral" }],
    ["an account with no campaign", { ads: ads([]) }, { label: "ยังไม่มีแคมเปญ", tone: "neutral" }],
    ["only a removed campaign counts as none", { ads: ads([camp("removed")]) }, { label: "ยังไม่มีแคมเปญ", tone: "neutral" }],
    ["a campaign being drafted", { ads: ads([camp("draft")]) }, { label: "กำลังสร้าง", tone: "info" }],
    ["a campaign being enabled", { ads: ads([camp("enabling")]) }, { label: "กำลังสร้าง", tone: "info" }],
    ["an enabled campaign with no spend yet or unknown", { spendToday: 0 }, { label: "เปิดแล้ว", tone: "neutral" }],
    ["only paused campaigns", { ads: ads([camp("paused")]) }, { label: "หยุดชั่วคราว", tone: "neutral" }],
    ["only failed campaigns", { ads: ads([camp("failed")]) }, { label: "สร้างไม่สำเร็จ", tone: "danger" }],
    ["paused in core", { paused: true }, { label: "หยุดชั่วคราว", tone: "neutral" }],
    ["demo brand", { brand: brand({ name: "demo1", brand_id: "demo1" }) }, { label: "ทดลอง", tone: "info" }],
  ])("%s", (_name, over, expected) => {
    expect(chip(over as never)).toEqual(expected);
  });
  it("is unknown, not 'not connected', while the campaigns load or when they fail", () => {
    expect(chip({ ads: undefined })).toBeNull();
    expect(chip({ ads: null })).toBeNull();
  });
  it("never reads a zero spend as learning", () => {
    for (const spendToday of [0, null]) for (const campaigns of [[camp("enabled")], [camp("draft")], []]) {
      expect(chip({ spendToday, ads: ads(campaigns) })?.label).not.toBe("กำลังเรียนรู้");
    }
  });
});

describe("upload facts per brand", () => {
  const row = (brand: string) => ({ lead_id: `${brand}-1`, brand, status: "uploaded", reason_code: null, last_error: null, click_type: null, attempts: 1, value: null, currency: "THB", occurred_at: "2026-11-01T00:00:00.000Z", created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", next_attempt_at: null });
  const report = (rows: ReturnType<typeof row>[], truncated: boolean) => ({ period: "30d", from: "2026-10-12T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z", totals: { pending: 0, processing: 0, uploaded: 0, dead: 0 }, value_totals: null, stalled: 0, rows, truncated }) as never;
  afterEach(() => vi.restoreAllMocks());

  it("takes a brand absent from a complete page as having none", async () => {
    vi.spyOn(api, "conversions").mockImplementation(async (query) => report(query.status === "uploaded" ? [row("b1")] : [], false));
    const facts = await loadUploadFacts(["b1", "b2"]);
    expect(facts.get("b1")).toEqual({ uploaded: true, dead: false });
    expect(facts.get("b2")).toEqual({ uploaded: false, dead: false });
  });

  it("asks for a brand on its own when the page is cut and other brands filled it", async () => {
    const calls: Array<{ status?: string; brand?: string; limit?: number }> = [];
    vi.spyOn(api, "conversions").mockImplementation(async (query) => {
      calls.push({ status: query.status, brand: query.brand, limit: query.limit });
      // The big page holds only brand b9; b2 has one uploaded row that the cut left out.
      if (query.brand === "b2" && query.status === "uploaded") return report([row("b2")], false);
      if (query.brand) return report([], false);
      return report(query.status === "uploaded" ? [row("b9")] : [], true);
    });
    const facts = await loadUploadFacts(["b2", "b3"]);
    expect(facts.get("b2")).toEqual({ uploaded: true, dead: false });
    expect(facts.get("b3")).toEqual({ uploaded: false, dead: false });
    expect(calls.filter((c) => c.brand).every((c) => c.limit === 1)).toBe(true);
    expect(calls.filter((c) => c.brand && c.brand === "b2" && c.status === "uploaded")).toHaveLength(1);
  });

  it("leaves the answers unknown when the request fails", async () => {
    vi.spyOn(api, "conversions").mockRejectedValue(new Error("down"));
    const facts = await loadUploadFacts(["b1"]);
    expect(facts.get("b1")).toEqual({ uploaded: null, dead: null });
  });
});

describe("stage unknowns", () => {
  const unknownAt = (label: (typeof STAGE_LABELS)[number], input: Partial<StageInput> = {}) => stageUnknowns({ brand: brand(), ...input })[STAGE_LABELS.indexOf(label)];
  it("marks the upload stage unknown when either upload read failed, and known when both answered or a dead row settles it", () => {
    expect(unknownAt("อัปโหลด", { hasUploaded: true, hasDead: null })).toBe(true);
    expect(unknownAt("อัปโหลด", { hasUploaded: null, hasDead: false })).toBe(true);
    expect(unknownAt("อัปโหลด", { hasUploaded: null, hasDead: null })).toBe(true);
    expect(unknownAt("อัปโหลด")).toBe(true);
    expect(unknownAt("อัปโหลด", { hasUploaded: true, hasDead: false })).toBe(false);
    expect(unknownAt("อัปโหลด", { hasUploaded: false, hasDead: false })).toBe(false);
    expect(unknownAt("อัปโหลด", { hasUploaded: null, hasDead: true })).toBe(false);
  });
  it("marks the template, lead and sold stages unknown while their source is missing", () => {
    expect(unknownAt("เทมเพลต")).toBe(true);
    expect(unknownAt("เทมเพลต", { checklist: entry({ template_approved: true }) })).toBe(false);
    expect(unknownAt("ลีด")).toBe(true);
    expect(unknownAt("ลีด", { leads30: 0 })).toBe(false);
    expect(unknownAt("ขายได้", { sold30: 0 })).toBe(false);
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

  it("titles an unknown pending dot ไม่ทราบ and keeps ยังไม่เริ่ม for a known one", () => {
    render(<StageDots stages={["done", "done", "done", "done", "pending", "pending", "pending"]} unknown={[false, false, false, false, false, false, true]} />);
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("อัปโหลด: ไม่ทราบ");
    expect(label).toContain("ลีด: ยังไม่เริ่ม");
    expect(document.querySelector('[data-stage="อัปโหลด"]')!.getAttribute("title")).toBe("อัปโหลด · ไม่ทราบ");
  });
});
