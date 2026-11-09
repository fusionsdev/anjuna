import alertsFixture from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
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

const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe("saving the scope", () => {
  const applyDemoToggle = async () => {
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "แสดงแบรนด์ทดลอง" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
  };

  it("waits for the saved prefs before it writes, and writes the saved views it read", async () => {
    const read = deferred<ReturnType<typeof prefs>>();
    vi.mocked(api.mePrefs).mockReturnValue(read.promise);
    render(<App />);
    await loaded();
    await applyDemoToggle();
    // The change shows at once and nothing is written yet: the saved views are not known.
    await waitFor(() => expect(rowCount()).toBe(3));
    expect(api.saveMePrefs).not.toHaveBeenCalled();
    read.resolve(prefs({ hide_inactive: true }));
    await waitFor(() => expect(api.saveMePrefs).toHaveBeenCalledTimes(1));
    expect(api.saveMePrefs).toHaveBeenCalledWith({ brand_scope: { hide_inactive: true, show_demo: true, brand_ids: null }, saved_views: { brands: { chip: "live" } } });
    // The choice made before the answer arrived wins over the saved scope.
    expect(rowCount()).toBe(3);
  });

  it("writes nothing when the saved prefs cannot be read, keeps the scope on this device and says so", async () => {
    vi.mocked(api.mePrefs).mockRejectedValue(new ApiError(500, null));
    render(<App />);
    await loaded();
    await applyDemoToggle();
    await waitFor(() => expect(rowCount()).toBe(3));
    expect(await screen.findByText("บันทึกขอบเขตไม่สำเร็จ ใช้ได้เฉพาะเครื่องนี้")).toBeTruthy();
    expect(api.saveMePrefs).not.toHaveBeenCalled();
  });

  it("says so when the write fails and clears the notice after a later write succeeds", async () => {
    vi.mocked(api.saveMePrefs).mockRejectedValueOnce(new ApiError(500, null));
    render(<App />);
    await loaded();
    await applyDemoToggle();
    expect(await screen.findByText("บันทึกขอบเขตไม่สำเร็จ ใช้ได้เฉพาะเครื่องนี้")).toBeTruthy();
    await applyDemoToggle();
    await waitFor(() => expect(screen.queryByText("บันทึกขอบเขตไม่สำเร็จ ใช้ได้เฉพาะเครื่องนี้")).toBeNull());
  });

  it("sends the writes one after another, so the last choice is the last write", async () => {
    const first = deferred<ReturnType<typeof prefs>>();
    vi.mocked(api.saveMePrefs).mockReturnValueOnce(first.promise as never);
    render(<App />);
    await loaded();
    await applyDemoToggle();
    await waitFor(() => expect(api.saveMePrefs).toHaveBeenCalledTimes(1));
    // A second change while the first write is still in flight must wait for it.
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await act(async () => undefined);
    expect(api.saveMePrefs).toHaveBeenCalledTimes(1);
    first.resolve(prefs());
    await waitFor(() => expect(api.saveMePrefs).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.saveMePrefs).mock.calls[1]![0].brand_scope).toEqual({ hide_inactive: false, show_demo: true, brand_ids: null });
  });
});

describe("scope on the other pages", () => {
  const funnelRows = [
    { brand: "brand-cg", keyword: null, variant: null, clicks: 100, go_count: 80, form_views: 60, submits: 11, sold: 3, revenue: null, submit_rate: null, sold_rate: null },
    { brand: "brand-al", keyword: null, variant: null, clicks: 400, go_count: 300, form_views: 200, submits: 40, sold: 9, revenue: null, submit_rate: null, sold_rate: null },
  ];
  const withFunnel = () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => (input.startsWith("/api/funnel?") ? json({ from: "2026-11-03", to: "2026-11-10", rows: funnelRows }) : base(input))));
  };
  const ledger = () => within(screen.getByRole("group", { name: "สรุปตัวเลข" }));
  const leadsCell = () => ledger().getByText("ลีด", { selector: "p.k" }).nextElementSibling!.textContent;

  it("counts only the brands in scope in the Home numbers and brand rows", async () => {
    window.history.replaceState(null, "", "/");
    withFunnel();
    render(<App />);
    await waitFor(() => expect(leadsCell()).toBe("11")); // brand-al is paused, so its 40 leads stay out
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(leadsCell()).toBe("51"));
  });

  it("shows the scope chip with the แก้ไข button on every page that shows brand data", async () => {
    for (const path of ["/", "/brands", "/campaigns", "/traffic", "/funnel", "/leads", "/conversions", "/alerts"]) {
      window.history.replaceState(null, "", path);
      const view = render(<App />);
      expect(await screen.findByText("แสดง 2 จาก 5 แบรนด์ · ซ่อนที่ไม่ได้ใช้ 3"), path).toBeTruthy();
      expect(screen.getByRole("button", { name: "แก้ไข" }), path).toBeTruthy();
      view.unmount();
      cleanup();
    }
  });

  it("shows no chip on pages without brand data", async () => {
    window.history.replaceState(null, "", "/templates");
    render(<App />);
    await screen.findByRole("button", { name: /แบรนด์ที่ใช้งาน/ });
    expect(screen.queryByRole("button", { name: "แก้ไข" })).toBeNull();
  });
});

describe("scope on Home work items and the all-brand labels", () => {
  /** The base stub plus extra routes. A route that returns undefined falls through to the base. */
  const withRoutes = (routes: Record<string, () => unknown>) => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = input.split("?")[0]!;
      return routes[path] ? json(routes[path]!()) : base(input);
    }));
  };
  const fixList = () => within(screen.getByRole("region", { name: "ต้องแก้" }));
  const todo = () => within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
  const showInactive = async () => {
    const dialog = await openPopover();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
  };

  it("leaves a hidden brand out of the Home fix list and brings it back when the scope shows it", async () => {
    window.history.replaceState(null, "", "/");
    const alerts = { ...alertsFixture, brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "brand-cg", leads: 5 }, { brand: "brand-al", leads: 7 }] } } };
    vi.mocked(api.alerts).mockResolvedValue(alerts as never);
    render(<App />);
    await waitFor(() => expect(fixList().getByText("brand-cg")).toBeTruthy());
    // brand-al is paused in core, so the default scope hides it.
    expect(fixList().queryByText("brand-al")).toBeNull();
    await showInactive();
    await waitFor(() => expect(fixList().getByText("brand-al")).toBeTruthy());
  });

  it("counts Test sold only for brands in scope and batches only those", async () => {
    window.history.replaceState(null, "", "/");
    const open = { checklist: [], template_approved: true, template_waiting_id: null };
    withRoutes({ "/api/brands/checklists": () => ({ brands: { "brand-cg": open, "brand-nv": open, "brand-al": open } }) });
    render(<App />);
    // Credit Genie and Nova Cash are in scope. Alpha Loans is paused in core, so it is out.
    await waitFor(() => expect(todo().getByText("ยืนยัน Test sold").querySelector("span")!.textContent).toBe("2 แบรนด์"));
    fireEvent.click(todo().getAllByRole("button", { name: "เปิด" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Credit Genie");
    expect(dialog.textContent).toContain("Nova Cash");
    expect(dialog.textContent).not.toContain("Alpha Loans");
    fireEvent.click(within(dialog).getByRole("button", { name: /ยกเลิก/ }));
    await showInactive();
    await waitFor(() => expect(todo().getByText("ยืนยัน Test sold").querySelector("span")!.textContent).toBe("3 แบรนด์"));
  });

  it("labels the Home conversion queue ทุกแบรนด์ while the scope hides brands, and not when every brand shows", async () => {
    window.history.replaceState(null, "", "/");
    withRoutes({ "/api/conversions": () => conversionsFixture });
    render(<App />);
    const queue = () => screen.getByRole("region", { name: "คอนเวอร์ชัน" });
    await waitFor(() => expect(queue().querySelector(".all-brands-note")!.textContent).toBe("ทุกแบรนด์"));
    cleanup();
    window.history.replaceState(null, "", "/?scope=all");
    render(<App />);
    await screen.findByRole("region", { name: "คอนเวอร์ชัน" });
    await act(async () => undefined);
    expect(queue().querySelector(".all-brands-note")).toBeNull();
  });

  it("labels the Conversions and Traffic totals ทุกแบรนด์ while the scope hides brands", async () => {
    withRoutes({ "/api/conversions": () => conversionsFixture, "/api/traffic/report": () => trafficFixture });
    window.history.replaceState(null, "", "/conversions");
    render(<App />);
    await waitFor(() => expect(document.querySelector(".conv-stack .all-brands-note")!.textContent).toContain("ทุกแบรนด์"));
    cleanup();
    window.history.replaceState(null, "", "/traffic");
    render(<App />);
    await waitFor(() => expect(document.querySelector(".traffic-stack .all-brands-note")!.textContent).toContain("ทุกแบรนด์"));
  });
});
