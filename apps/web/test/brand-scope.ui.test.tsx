import { LifecycleBrandSummary } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { ApiError, api } from "../src/client/api";
import { DEFAULT_SCOPE, groupOfBrand, inScope, scopeFromPrefs, scopeFromSearch, scopeSummary, scopeToPrefs } from "../src/client/brand-scope";

const lifecycle = (id: string, name: string, host: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name, account: "test-account", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
// Five brands: two active, one paused in core, one retired, one demo.
const rows = [
  lifecycle("brand-cg", "Credit Genie", "creditsgene.test"),
  lifecycle("brand-nv", "Nova Cash", "novacash.test"),
  lifecycle("brand-al", "Alpha Loans", "alpha.test"),
  lifecycle("brand-rt", "Old Lender", "oldlender.test", { status: "retired" }),
  lifecycle("brand-d1", "demo1", "demo1.test"),
];
const runtime = (id: string) => ({
  brand_id: id, hostnames: [`${id}.test`], status: id === "brand-al" ? "paused" : "live", flow_gate_mode: "param", ab_config: null, form_version: null,
  stats_7d: { leads: 1, sold: 0, pending: 0 },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const employee = { id: "staff", email: "staff@example.test", role: "employee" as const };
const prefs = (over: Partial<{ hide_inactive: boolean; show_demo: boolean; brand_ids: string[] | null }> = {}) =>
  ({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null, ...over }, saved_views: { brands: { chip: "live" } } });

beforeEach(() => {
  window.history.replaceState(null, "", "/brands");
  vi.spyOn(api, "me").mockResolvedValue(employee);
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("not under test"));
  vi.spyOn(api, "navCounts").mockRejectedValue(new Error("not under test"));
  vi.spyOn(api, "mePrefs").mockResolvedValue(prefs());
  vi.spyOn(api, "saveMePrefs").mockImplementation(async (body) => body);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/lifecycle/brands") return json({ brands: rows });
    if (input === "/api/brands") return json({ brands: rows.map((row) => runtime(row.brand_id)), generated_at: "2026-11-10T00:00:00Z" });
    if (input === "/api/upgrade-all/latest") return json({ upgrade: null });
    if (input.startsWith("/api/funnel?")) return json({ from: "2026-11-03", to: "2026-11-10", rows: [] });
    if (/^\/api\/brands\/[^/]+\/(checklist|installs|revisions)$/.test(input)) return json({ checklist: [], installs: [], revisions: [], current_revision_id: null, rollback_target_revision_id: null });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const table = () => document.querySelector<HTMLElement>("table.brand-table")!;
// Each brand has a main row and a stats row.
const rowCount = () => table().querySelectorAll("tbody tr.click:not(.stats)").length;
const loaded = async () => { await waitFor(() => expect(rowCount()).toBeGreaterThan(0)); };
const openPopover = async () => {
  const button = await screen.findByRole("button", { name: /แบรนด์ที่ใช้งาน/ });
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "ขอบเขตแบรนด์" });
};

describe("brand scope helpers", () => {
  it("hides paused, retired and demo brands by default", () => {
    expect(DEFAULT_SCOPE).toEqual({ hideInactive: true, showDemo: false, brandIds: null });
    expect(inScope(DEFAULT_SCOPE, { id: "a", demo: false, inactive: false })).toBe(true);
    expect(inScope(DEFAULT_SCOPE, { id: "a", demo: false, inactive: true })).toBe(false);
    expect(inScope(DEFAULT_SCOPE, { id: "a", demo: true, inactive: false })).toBe(false);
    expect(inScope({ ...DEFAULT_SCOPE, hideInactive: false, showDemo: true }, { id: "a", demo: true, inactive: true })).toBe(true);
    expect(inScope({ ...DEFAULT_SCOPE, brandIds: ["b"] }, { id: "a", demo: false, inactive: false })).toBe(false);
  });

  it("maps to and from the prefs wire shape", () => {
    const wire = { hide_inactive: false, show_demo: true, brand_ids: ["x", "y"] };
    expect(scopeFromPrefs(wire)).toEqual({ hideInactive: false, showDemo: true, brandIds: ["x", "y"] });
    expect(scopeToPrefs(scopeFromPrefs(wire))).toEqual(wire);
  });

  it("reads the ?scope= override", () => {
    expect(scopeFromSearch("")).toBeNull();
    expect(scopeFromSearch("?scope=all")).toEqual({ hideInactive: false, showDemo: true, brandIds: null });
    expect(scopeFromSearch("?scope=active")).toEqual(DEFAULT_SCOPE);
    expect(scopeFromSearch("?scope=a,b")).toEqual({ hideInactive: false, showDemo: true, brandIds: ["a", "b"] });
    expect(scopeFromSearch("?scope=")).toBeNull();
  });

  it("writes the chip text", () => {
    expect(scopeSummary(3, 5)).toBe("แสดง 3 จาก 5 แบรนด์ · ซ่อนที่ไม่ได้ใช้ 2");
  });

  it("groups brands for the popover", () => {
    expect(groupOfBrand(rows[0]!)).toBe("active");
    expect(groupOfBrand(rows[2]!, "paused")).toBe("paused");
    expect(groupOfBrand(rows[3]!)).toBe("retired");
    expect(groupOfBrand(rows[4]!)).toBe("demo");
    expect(groupOfBrand(lifecycle("b", "B", "b.test", { status: "draft", current_revision_id: null }))).toBe("unfinished");
  });
});

describe("brand scope in the app", () => {
  it("shows only active brands on Brands by default and says how many are hidden", async () => {
    render(<App />);
    await loaded();
    expect(rowCount()).toBe(2);
    expect(within(table()).getByText(/creditsgene\.test/)).toBeTruthy();
    expect(within(table()).getByText(/novacash\.test/)).toBeTruthy();
    expect(within(table()).queryByText(/alpha\.test/)).toBeNull();
    expect(await screen.findByText("แสดง 2 จาก 5 แบรนด์ · ซ่อนที่ไม่ได้ใช้ 3")).toBeTruthy();
    expect((await screen.findByRole("button", { name: /แบรนด์ที่ใช้งาน/ })).textContent).toContain("2");
  });

  it("changes the visible brand count on Brands when the popover toggles are applied", async () => {
    render(<App />);
    await loaded();
    expect(rowCount()).toBe(2);
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(rowCount()).toBe(4)); // paused and retired now show; demo stays hidden
    expect(within(table()).getByText(/alpha\.test/)).toBeTruthy();
    expect(await screen.findByText("แสดง 4 จาก 5 แบรนด์ · ซ่อนที่ไม่ได้ใช้ 1")).toBeTruthy();

    const again = await openPopover();
    fireEvent.click(within(again).getByRole("switch", { name: "แสดงแบรนด์ทดลอง" }));
    fireEvent.click(within(again).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(rowCount()).toBe(5));
    expect(await screen.findByText("แสดง 5 จาก 5 แบรนด์ · ซ่อนที่ไม่ได้ใช้ 0")).toBeTruthy();
  });

  it("limits Brands to the brands ticked in the popover", async () => {
    render(<App />);
    await loaded();
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("button", { name: "ล้าง" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Nova Cash/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(rowCount()).toBe(1));
    expect(within(table()).getByText(/novacash\.test/)).toBeTruthy();
  });

  it("opens the popover from the แก้ไข button under the page title", async () => {
    render(<App />);
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "แก้ไข" }));
    expect(await screen.findByRole("dialog", { name: "ขอบเขตแบรนด์" })).toBeTruthy();
  });

  it("closes the popover with Escape and returns focus to its button", async () => {
    render(<App />);
    await loaded();
    await openPopover();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "ขอบเขตแบรนด์" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /แบรนด์ที่ใช้งาน/ }));
  });

  it("applies the saved scope from /api/me/prefs and writes a change back with the saved views untouched", async () => {
    vi.mocked(api.mePrefs).mockResolvedValue(prefs({ hide_inactive: false }));
    render(<App />);
    await waitFor(() => expect(rowCount()).toBe(4));
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "แสดงแบรนด์ทดลอง" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(api.saveMePrefs).toHaveBeenCalledTimes(1));
    expect(api.saveMePrefs).toHaveBeenCalledWith({ brand_scope: { hide_inactive: false, show_demo: true, brand_ids: null }, saved_views: { brands: { chip: "live" } } });
  });

  it("keeps the change on this device when saving fails", async () => {
    vi.mocked(api.saveMePrefs).mockRejectedValue(new ApiError(500, null));
    render(<App />);
    await loaded();
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(rowCount()).toBe(4));
  });

  it("lets ?scope=all override the saved scope for the visit, then drops the parameter on the first change", async () => {
    window.history.replaceState(null, "", "/brands?scope=all");
    render(<App />);
    await waitFor(() => expect(rowCount()).toBe(5));
    expect(api.mePrefs).toHaveBeenCalled();
    expect(rowCount()).toBe(5); // the saved scope (hide paused) arrived and did not win
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await act(async () => undefined);
    expect(window.location.search).toBe("");
  });

  it("lists the brands by state in the popover and filters them by search", async () => {
    render(<App />);
    await loaded();
    const dialog = await openPopover();
    for (const heading of ["ใช้งาน", "หยุด", "เลิกใช้แล้ว", "ทดลอง"]) expect(within(dialog).getByRole("heading", { name: heading })).toBeTruthy();
    fireEvent.change(within(dialog).getByPlaceholderText("ค้นหาชื่อหรือโดเมน"), { target: { value: "alpha" } });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialog).getByRole("checkbox", { name: /Alpha Loans/ })).toBeTruthy();
  });
});
