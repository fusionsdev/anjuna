import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { api } from "../src/client/api";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };

const install = (status: "ready" | "failed", started_at: string) => ({
  install_id: `inst-${started_at}`, operation: "install" as const, status, started_at, finished_at: started_at, started_by: "owner",
});
const lifecycle = (id: string, name: string, host: string, extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: id, name, account: "test-account", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
// Health: Credit Genie healthy, FloatMe failed install, Alpha Loans paused in core, Wizard Demo has no live domain.
// Issues first: FloatMe, Wizard Demo, Alpha Loans, Credit Genie. Latest activity: Credit Genie, FloatMe, Alpha Loans, Wizard Demo (no install, last).
// Domain A-Z: Alpha Loans, Credit Genie, FloatMe, Wizard Demo. Worst profit: FloatMe, Credit Genie, Alpha Loans, Wizard Demo.
const lifecycleRows = [
  lifecycle("brand-cg", "Credit Genie", "creditsgene.test", { latest_install: install("ready", "2026-10-07T00:00:00.000Z") }),
  lifecycle("brand-fm", "FloatMe", "floatsme.test", { latest_install: install("failed", "2026-10-06T00:00:00.000Z") }),
  lifecycle("brand-al", "Alpha Loans", "alpha.test", { latest_install: install("ready", "2026-10-05T00:00:00.000Z") }),
  lifecycle("brand-wd", "Wizard Demo", "wizard.test", { status: "draft", current_revision_id: null, latest_install: null }),
];
const runtimeRow = (id: string) => ({
  brand_id: id, hostnames: [`${id}.test`], status: id === "brand-al" ? "paused" : "live", flow_gate_mode: "param", ab_config: null, form_version: null,
  stats_7d: { leads: 9, sold: 3, pending: 2 },
});
const funnelRow = (brand: string, clicks: number, submits: number, revenue: number) => ({
  brand, keyword: null, variant: null, clicks, go_count: 0, form_views: 0, submits, sold: 0, revenue, submit_rate: null, sold_rate: null,
});
const cost = (brand_id: string, value: number) => ({ brand_id, cost: value, clicks: 1, impressions: 1, updated_at: "2026-10-06T00:00:00.000Z" });
// Profit: FloatMe -620, Credit Genie -546, Alpha Loans 300, Wizard Demo unknown (no spend row).
const funnel = [funnelRow("brand-cg", 212, 10, 254), funnelRow("brand-fm", 96, 0, 0), funnelRow("brand-al", 50, 5, 400), funnelRow("brand-wd", 40, 4, 300)];
const spendRows = [cost("brand-cg", 800), cost("brand-fm", 620), cost("brand-al", 100)];

type Handler = (init?: RequestInit) => Response | Promise<Response>;
type SpendFn = (period: string) => Promise<unknown>;
const apiWithSpend = api as unknown as { spend?: SpendFn };
let routes: Map<string, Handler>;
let originalSpend: SpendFn | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/lifecycle/brands", () => json({ brands: lifecycleRows })],
    ["GET /api/brands", () => json({ brands: lifecycleRows.map((row) => runtimeRow(row.brand_id)), generated_at: "2026-10-06T00:00:00Z" })],
  ]);
  for (const row of lifecycleRows) {
    routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
    routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
  }
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (input.startsWith("/api/funnel?")) {
      const params = new URLSearchParams(input.split("?")[1]);
      return json({ from: params.get("from"), to: params.get("to"), rows: funnel });
    }
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
  originalSpend = apiWithSpend.spend;
  apiWithSpend.spend = (async (period: string) => ({
    period, from: "2026-10-01", to: "2026-10-07", totals: { cost: 1520, clicks: 0, impressions: 0 }, brands: spendRows,
  })) as SpendFn;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalSpend) apiWithSpend.spend = originalSpend; else delete apiWithSpend.spend;
});

const names = () => [...document.querySelectorAll(".brand-table button.brand-pick")].map((button) => button.querySelector("b")?.textContent);
const sortSelect = () => screen.getByLabelText(/เรียงลำดับ/) as unknown as HTMLSelectElement;
// Scoped to the chip group: the table rows have their own Pause and Resume buttons.
const chipButton = (label: RegExp) => within(screen.getByRole("group", { name: /ตัวกรองแบรนด์/ })).getByRole("button", { name: label });
/** Waits until the list and the spend report have both landed, so the profit figures are in. */
const loaded = (me: typeof owner | typeof employee) => waitFor(() => {
  expect(names()).toHaveLength(4);
  if (me.role === "owner") expect(document.querySelector(".brand-table")?.textContent).toContain("−$620");
});

describe("brands list filters and sort", () => {
  it("sorts issues-first by default for both roles", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    expect(sortSelect().value).toBe("issues");
    expect(names()).toEqual(["FloatMe", "Wizard Demo", "Alpha Loans", "Credit Genie"]);
    cleanup();

    render(<BrandLifecycle me={employee} />);
    await loaded(employee);
    expect(sortSelect().value).toBe("issues");
    expect(names()).toEqual(["FloatMe", "Wizard Demo", "Alpha Loans", "Credit Genie"]);
  });

  it("offers Worst profit to the owner only", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    expect(screen.queryByRole("option", { name: /กำไรน้อยสุด/ })).not.toBeNull();
    cleanup();

    render(<BrandLifecycle me={employee} />);
    await loaded(employee);
    expect(screen.queryByRole("option", { name: /กำไรน้อยสุด/ })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("claims the worst-profit order in the hint only while the owner sorts by profit", async () => {
    const hint = () => [...document.querySelectorAll("p.hint")].find((p) => p.textContent?.includes("เครื่องหมาย — คือยังไม่มีข้อมูล"))!.textContent!;
    const claim = "เรียงจากกำไรน้อยที่สุดก่อน";
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    for (const mode of ["issues", "activity", "az"]) {
      fireEvent.change(sortSelect(), { target: { value: mode } });
      expect(hint()).not.toContain(claim);
      expect(hint()).toContain("AdKit");
    }
    fireEvent.change(sortSelect(), { target: { value: "profit" } });
    expect(hint()).toContain(claim);
    cleanup();

    render(<BrandLifecycle me={employee} />);
    await loaded(employee);
    for (const mode of ["issues", "activity", "az"]) {
      fireEvent.change(sortSelect(), { target: { value: mode } });
      expect(hint()).not.toContain(claim);
      expect(hint()).not.toContain("AdKit");
    }
  });

  it("keeps the worst-profit order when the owner picks it", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    fireEvent.change(sortSelect(), { target: { value: "profit" } });
    expect(names()).toEqual(["FloatMe", "Credit Genie", "Alpha Loans", "Wizard Demo"]);
  });

  it("sorts by latest activity and puts a brand with no install last", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    fireEvent.change(sortSelect(), { target: { value: "activity" } });
    expect(names()).toEqual(["Credit Genie", "FloatMe", "Alpha Loans", "Wizard Demo"]);
  });

  it("sorts by domain A-Z", async () => {
    render(<BrandLifecycle me={employee} />);
    await loaded(employee);
    fireEvent.change(sortSelect(), { target: { value: "az" } });
    expect(names()).toEqual(["Alpha Loans", "Credit Genie", "FloatMe", "Wizard Demo"]);
  });

  it("filters to one chip and shows each chip's count", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    expect(chipButton(/ทั้งหมด/).textContent).toContain("4");
    expect(chipButton(/ใช้งาน \(Live\)/).textContent).toContain("1");
    expect(chipButton(/หยุดชั่วคราว/).textContent).toContain("1");
    expect(chipButton(/ติดตั้งล้มเหลว/).textContent).toContain("1");
    expect(chipButton(/ยังไม่มีโดเมนใช้งาน/).textContent).toContain("1");

    fireEvent.click(chipButton(/ติดตั้งล้มเหลว/));
    expect(names()).toEqual(["FloatMe"]);
    expect(chipButton(/ติดตั้งล้มเหลว/).getAttribute("aria-pressed")).toBe("true");
    expect(chipButton(/ทั้งหมด/).getAttribute("aria-pressed")).toBe("false");
  });

  it("filters by domain search, case-insensitively", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    fireEvent.change(screen.getByLabelText(/ค้นหาโดเมน/), { target: { value: "FLOAT" } });
    expect(names()).toEqual(["FloatMe"]);
    // A chip count never promises rows the search has hidden.
    expect(chipButton(/ทั้งหมด/).textContent).toContain("1");
    expect(chipButton(/ติดตั้งล้มเหลว/).textContent).toContain("1");
    expect(chipButton(/หยุดชั่วคราว/).textContent).toContain("0");
  });

  it("shows an empty state when a filter hides every brand and clears it", async () => {
    render(<BrandLifecycle me={owner} />);
    await loaded(owner);
    fireEvent.change(screen.getByLabelText(/ค้นหาโดเมน/), { target: { value: "zzz" } });
    expect(names()).toEqual([]);
    expect(screen.queryByText(/ยังไม่มีแบรนด์/)).toBeNull();
    expect(screen.getByText(/ไม่พบแบรนด์ที่ตรงกับตัวกรอง/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /ล้างตัวกรอง/ }));
    expect(names()).toHaveLength(4);
    expect((screen.getByLabelText(/ค้นหาโดเมน/) as HTMLInputElement).value).toBe("");
    expect(chipButton(/ทั้งหมด/).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the routed brand in the side panel while a filter hides its row", async () => {
    // Review Focus 5: the side panel follows the route, not the visible rows.
    render(<BrandLifecycle me={owner} routeBrandId="brand-wd" />);
    await loaded(owner);
    expect(await screen.findByRole("heading", { level: 2, name: /Wizard Demo/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/ค้นหาโดเมน/), { target: { value: "float" } });
    expect(names()).toEqual(["FloatMe"]);
    expect(screen.getByRole("heading", { level: 2, name: /Wizard Demo/ })).toBeTruthy();
  });
});
