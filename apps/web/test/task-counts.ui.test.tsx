import { LifecycleBrandSummary } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

// Every Home to-do card count must equal the rows the page it opens renders. The fixture mixes every case the counts filter out.
const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const lifecycle = (id: string, name: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name, account: "test-account", hostnames: [`${id}.test`], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const draft = { status: "draft", current_revision_id: null, runtime_sync_status: "queued" };
const rows = [
  lifecycle("live-ts", "Needs Test Sold"), // drain route done, test sold open
  lifecycle("live-dr", "Needs Route"), // test sold done, drain route open
  lifecycle("live-dr2", "Needs Route Too"),
  lifecycle("live-both", "Needs Both"),
  lifecycle("live-ok", "All Done"),
  lifecycle("draft-1", "Draft One", draft),
  lifecycle("demo07", "demo07"), // a demo brand: never counted
  lifecycle("demo08", "demo08", draft), // a demo draft: the scope hides it
  lifecycle("paused-1", "Paused Live"), // paused in core: the scope hides it
  lifecycle("hidden-1", "Hidden Live"), // left out of the scope's brand ticks
  lifecycle("hidden-d", "Hidden Draft", draft),
];
const done = (...items: string[]) => ({ checklist: items.map((item) => ({ item, evidence: {} })), template_approved: true, template_waiting_id: null });
const checklists = { brands: {
  "live-ts": done("drain_route"), "live-dr": done("test_sold"), "live-dr2": done("test_sold"), "live-both": done(), "live-ok": done("test_sold", "drain_route"),
  demo07: done(), "paused-1": done(), "hidden-1": done(),
} };
const runtime = (id: string) => ({
  brand_id: id, hostnames: [`${id}.test`], status: id === "paused-1" ? "paused" : "live", flow_gate_mode: "param", ab_config: null, form_version: null,
  stats_7d: { leads: 0, sold: 0, pending: 0 },
});
const template = (id: string, status: string, archived = false) => ({
  template_version_id: id, template_id: id, name: id, version: 1, status, submitted_by_label: null, created_at: "2026-11-01", sealed_at: null,
  thumbnail_url: null, brands_using: 0, archived, category_id: null, was_approved: false,
});
// Home reads the list without archived templates, the Templates screen with them, as the server answers.
const templates = [template("t-await-1", "awaiting_approval"), template("t-await-2", "awaiting_approval"), template("t-ok", "approved"), template("t-check", "checking")];
const archived = [template("t-await-archived", "awaiting_approval", true)];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "me").mockResolvedValue(owner);
  vi.spyOn(api, "navCounts").mockRejectedValue(new Error("not under test"));
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("not under test"));
  vi.spyOn(api, "mePrefs").mockResolvedValue({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: rows.map((r) => r.brand_id).filter((id) => !id.startsWith("hidden")) }, saved_views: {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/lifecycle/brands") return json({ brands: rows });
    if (input === "/api/brands") return json({ brands: rows.filter((r) => r.status !== "draft").map((r) => runtime(r.brand_id)), generated_at: "2026-11-13T00:00:00Z" });
    if (input === "/api/brands/checklists") return json(checklists);
    if (input === "/api/templates") return json({ templates, categories: [] });
    if (input === "/api/templates?include_archived=1") return json({ templates: [...templates, ...archived], categories: [] });
    if (input === "/api/upgrade-all/latest") return json({ upgrade: null });
    if (/^\/api\/brands\/[^/]+\/(checklist|installs|revisions)$/.test(input)) return json({ checklist: [], installs: [], revisions: [], current_revision_id: null, rollback_target_revision_id: null });
    // Reports the counts do not read (funnel, spend, conversions, traffic) answer unavailable; each screen shows a dash for them.
    return json({ error: "unavailable" }, 503);
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const todo = () => within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
const cardCount = (title: string) => Number(/^(\d+)/.exec(todo().getByText(title).querySelector("span")!.textContent ?? "")?.[1]);
const openCard = (title: string) => fireEvent.click(within(todo().getByText(title).parentElement!).getByRole("button", { name: "เปิด" }));
const brandRows = () => [...document.querySelectorAll<HTMLElement>("table.brand-table tbody tr[data-brand-id]")];
const chipCount = (label: string) => Number(within(screen.getByRole("group", { name: "ตัวกรองแบรนด์" })).getByRole("button", { name: new RegExp(`^${label}`) }).querySelector(".brand-chip-count")!.textContent);

describe("Home to-do counts equal the rows of the page each card opens", () => {
  it.each([
    ["ยืนยัน Test sold", "/brands?chip=test-sold", "รอทดสอบการขาย", 2, ["live-both", "live-ts"]],
    ["ตั้ง drain route", "/brands?chip=drain-route", "รอตั้งเส้นทางส่งยอดขาย", 3, ["live-both", "live-dr", "live-dr2"]],
    ["แบรนด์ที่สร้างค้างไว้", "/brands?chip=drafts", "สร้างค้างไว้", 1, ["draft-1"]],
  ] as const)("%s", async (title, url, chipLabel, expected, ids) => {
    render(<App />);
    await waitFor(() => expect(cardCount(title)).toBe(expected));
    openCard(title);
    expect(window.location.pathname + window.location.search).toBe(url);
    await waitFor(() => expect(brandRows().map((row) => row.dataset.brandId).sort()).toEqual([...ids]));
    expect(brandRows()).toHaveLength(expected);
    expect(chipCount(chipLabel)).toBe(expected);
    expect(within(screen.getByRole("group", { name: "ตัวกรองแบรนด์" })).getByRole("button", { name: new RegExp(`^${chipLabel}`) }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the templates card count equals the rows of /templates?status=awaiting_approval, archived versions left out of both", async () => {
    render(<App />);
    await waitFor(() => expect(cardCount("อนุมัติเทมเพลต")).toBe(2));
    openCard("อนุมัติเทมเพลต");
    expect(window.location.pathname + window.location.search).toBe("/templates?status=awaiting_approval");
    const list = await screen.findByRole("region", { name: "รายการเทมเพลต" });
    await waitFor(() => expect(list.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(screen.getByRole("button", { name: /^รออนุมัติ/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the chip across a row selection and Back, and a chip click rewrites the URL in place", async () => {
    window.history.replaceState(null, "", "/brands?chip=test-sold");
    render(<App />);
    await waitFor(() => expect(brandRows()).toHaveLength(2));
    fireEvent.click(within(brandRows().find((row) => row.dataset.brandId === "live-ts")!).getByRole("button", { name: /live-ts\.test/ }));
    expect(window.location.pathname + window.location.search).toBe("/brands/live-ts?chip=test-sold");
    expect(brandRows()).toHaveLength(2);
    window.history.back();
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/brands?chip=test-sold"));
    expect(brandRows()).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("group", { name: "ตัวกรองแบรนด์" })).getByRole("button", { name: /^ทั้งหมด/ }));
    expect(window.location.pathname + window.location.search).toBe("/brands");
    // The default view under the saved scope: 6 rows. The demo brands, the paused brand and the two brands outside the ticks are hidden.
    await waitFor(() => expect(brandRows()).toHaveLength(6));
  });

  it("puts the bulk Test sold above the test-sold chip and names every row in one dialog", async () => {
    window.history.replaceState(null, "", "/brands?chip=test-sold");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "ทดสอบการขายทั้งหมด 2 แบรนด์" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Needs Test Sold");
    expect(dialog.textContent).toContain("Needs Both");
    expect(dialog.textContent).not.toContain("All Done");
  });

  it("gives each draft under the drafts chip the button สร้างต่อ, which resumes that brand's wizard", async () => {
    const wizardDraft = vi.spyOn(api, "wizardDraft").mockReturnValue(new Promise(() => undefined));
    window.history.replaceState(null, "", "/brands?chip=drafts");
    render(<App />);
    await waitFor(() => expect(brandRows()).toHaveLength(1));
    const resume = within(brandRows()[0]!).getByRole("button", { name: "สร้างต่อ" });
    expect(resume.dataset.nextAction).toBe("resume-wizard");
    fireEvent.click(resume);
    await waitFor(() => expect(wizardDraft).toHaveBeenCalledWith("draft-1"));
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
  });
});
