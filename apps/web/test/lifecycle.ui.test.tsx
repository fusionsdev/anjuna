import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type BrandConfig, type InstallWithReceipts } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
// The normalized BFF response (including factory-only rows), not a factory
// database row with `domain`. Keep it checked against the shared API schema.
const brand = LifecycleBrandSummary.parse({
  brand_id: "brand-a", account: "test-account", hostnames: ["renderable.test", "www.renderable.test"],
  status: "live", current_revision_id: "rev-1", runtime_sync_status: "ready",
  bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
const initialConfig: BrandConfig = {
  brand_id: brand.brand_id, account: brand.account, hostnames: brand.hostnames, status: "live",
  form_version: "form@abcdef1", keyword_default: "Quick Loan", amount_buckets: [100, 500],
  ab_config: { experiment_id: "exp-1", variants: [{ id: "lite_v1", weight: 50 }, { id: "full_v1", weight: 50 }] },
  flow_gate_mode: "param", aid: "123", prepop_base: "https://buyer.example/apply", drain_key: "brand-a",
  postback_token: "set", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const failed: InstallWithReceipts = {
  install_id: "failed-1", brand_id: "brand-a", revision_id: "rev-1", status: "failed",
  runtime_sync_status: "failed", receipts: [],
};
type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let config: BrandConfig;
let runtimeAvailable: boolean;
let lifecycleRows: LifecycleBrandSummary[];
let requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lastBody = (path: string) => requests.filter((r) => r.path === path && r.method === "PATCH").at(-1)?.body;
const history = (installs: unknown[]) => routes.set("GET /api/brands/brand-a/installs", () => json({ brand_id: "brand-a", installs }));
const detail = (install: InstallWithReceipts) => routes.set(`GET /api/installs/${install.install_id}`, () => json(install));
const section = (panel: HTMLElement, heading: string | RegExp) => within(within(panel).getByRole("heading", { name: heading }).closest("section")!);

beforeEach(() => {
  config = structuredClone(initialConfig);
  runtimeAvailable = true;
  lifecycleRows = [structuredClone(brand)];
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates/sealed", () => json({ templates: [{ template_version_id: "tv-1", name: "Starter", version: 1, status: "sealed" }] })],
    ["GET /api/lifecycle/brands", () => json({ brands: lifecycleRows })],
    ["GET /api/brands", () => json({ brands: runtimeAvailable ? [{
      brand_id: config.brand_id, hostnames: config.hostnames, status: config.status,
      flow_gate_mode: config.flow_gate_mode, ab_config: config.ab_config, form_version: config.form_version,
      stats_7d: { leads: 9, sold: 3, pending: 2 },
    }] : [], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/brands/brand-a", () => json({ brand: config })],
    ["GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: [] })],
    ["PATCH /api/brands/brand-a", (init) => {
      const { expected_updated_at: _, ...patch } = JSON.parse(String(init?.body));
      config = { ...config, ...patch, updated_at: `2026-10-06T00:00:${String(requests.length).padStart(2, "0")}Z` };
      return json({ brand: config });
    }],
    ["POST /api/brands/brand-a/pause", () => { config.status = "paused"; return json({ brand: config }); }],
    ["POST /api/brands/brand-a/resume", () => { config.status = "live"; return json({ brand: config }); }],
  ]);
  history([]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mounted lifecycle UI with API responses", () => {
  it("lets an Employee choose a sealed template, create a draft and start Install", async () => {
    lifecycleRows = [];
    runtimeAvailable = false;
    routes.set("POST /api/brands/drafts", () => {
      lifecycleRows = [{ ...brand, status: "draft", current_revision_id: "rev-new" }];
      return json({ brand: { brand_id: "brand-a" }, revision: { revision_id: "rev-new" } }, 201);
    });
    routes.set("POST /api/brands/brand-a/install", () => json({ install_id: "new-install" }, 201));
    detail({ ...failed, install_id: "new-install", revision_id: "rev-new", status: "running", runtime_sync_status: "running" });
    render(<BrandLifecycle me={employee} />);
    const select = screen.getByRole("combobox", { name: "Sealed template version" });
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: "Sealed template version" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Domain" }), { target: { value: "new-brand.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Keyword" }), { target: { value: "Quick Loan" } });
    expect((screen.getByRole("button", { name: "สร้าง draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "tv-1" } });
    fireEvent.click(screen.getByRole("button", { name: "สร้าง draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect((await screen.findAllByText("new-install", { selector: "code" })).length).toBeGreaterThan(0);
    expect(requests.find((r) => r.path === "/api/brands/drafts")?.body).toEqual({ domain: "new-brand.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(requests.find((r) => r.path === "/api/brands/brand-a/install")?.body).toEqual({ revision_id: "rev-new" });
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Upgrade-all/ })).toBeNull();
  });

  it("blocks draft creation when no sealed templates exist", async () => {
    routes.set("GET /api/templates/sealed", () => json({ templates: [] }));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/No sealed templates available/);
    expect(screen.getByRole("combobox", { name: "Sealed template version" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "สร้าง draft" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports template load failure and recovers on Refresh", async () => {
    routes.set("GET /api/templates/sealed", () => json({ error: "internal" }, 500));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/โหลด sealed templates ไม่สำเร็จ/);
    expect((screen.getByRole("button", { name: "สร้าง draft" }) as HTMLButtonElement).disabled).toBe(true);
    routes.set("GET /api/templates/sealed", () => json({ templates: [{ template_version_id: "tv-2", name: "Fresh", version: 2, status: "sealed" }] }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await screen.findByRole("option", { name: "Fresh · v2 (tv-2)" });
    expect(screen.queryByText(/โหลด sealed templates ไม่สำเร็จ/)).toBeNull();
  });

  it("hides Rollback from Employees on a live brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "renderable.test" });
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
  });

  it("does not offer unsealed versions even if the API returns them", async () => {
    routes.set("GET /api/templates/sealed", () => json({ templates: [
      { template_version_id: "tv-1", name: "Starter", version: 1, status: "sealed" },
      { template_version_id: "tv-draft", name: "Unapproved", version: 2, status: "draft" },
    ] }));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/โหลด sealed templates ไม่สำเร็จ/);
    const select = screen.getByRole("combobox", { name: "Sealed template version" });
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /Unapproved/ })).toBeNull();
    expect((screen.getByRole("button", { name: "สร้าง draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.some((request) => request.path === "/api/brands/drafts")).toBe(false);
  });

  it("clears a removed template selection on Refresh before allowing another draft", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    const select = screen.getByRole("combobox", { name: "Sealed template version" });
    const create = screen.getByRole("button", { name: "สร้าง draft" }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole("textbox", { name: "Domain" }), { target: { value: "refresh.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Keyword" }), { target: { value: "Quick Loan" } });
    fireEvent.change(select, { target: { value: "tv-1" } });
    expect(create.disabled).toBe(false);

    routes.set("GET /api/templates/sealed", () => json({ templates: [
      { template_version_id: "tv-2", name: "Fresh", version: 2, status: "sealed" },
    ] }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(create.disabled).toBe(true);
    await screen.findByRole("option", { name: "Fresh · v2 (tv-2)" });
    expect(select).toHaveProperty("value", "");
    expect(screen.queryByRole("option", { name: "Starter · v1 (tv-1)" })).toBeNull();
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(requests.some((request) => request.path === "/api/brands/drafts")).toBe(false);
    fireEvent.change(select, { target: { value: "tv-2" } });
    expect(create.disabled).toBe(false);
  });

  it("loads API rows and opens working runtime pause, keyword, buckets, A/B and gate controls", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
    const panel = await screen.findByRole("complementary", { name: "Brand config" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Pause แบรนด์" }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Resume แบรนด์" }));
    await within(panel).findByRole("button", { name: "Pause แบรนด์" });
    expect(requests.some((r) => r.path.endsWith("/pause") && r.method === "POST")).toBe(true);
    expect(requests.some((r) => r.path.endsWith("/resume") && r.method === "POST")).toBe(true);

    fireEvent.change(section(panel, "Keyword default").getByRole("textbox"), { target: { value: "Fast Cash" } });
    fireEvent.click(section(panel, "Keyword default").getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ keyword_default: "Fast Cash", expected_updated_at: expect.any(String) }));
    await waitFor(() => expect((section(panel, "Keyword default").getByRole("textbox") as HTMLInputElement).value).toBe("Fast Cash"));

    fireEvent.change(within(panel).getByRole("textbox", { name: "Amount buckets" }), { target: { value: "200, 600" } });
    fireEvent.click(section(panel, "Amount buckets").getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ amount_buckets: [200, 600] }));

    fireEvent.change(await within(panel).findByRole("slider", { name: "A/B weight" }), { target: { value: "70" } });
    fireEvent.click(within(panel).getByRole("button", { name: "บันทึก A/B" }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ ab_config: { variants: [{ id: "lite_v1", weight: 70 }, { id: "full_v1", weight: 30 }] } }));

    fireEvent.change(section(panel, "Flow gate").getByRole("combobox"), { target: { value: "signed_cookie" } });
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ flow_gate_mode: "signed_cookie" }));
    fireEvent.click(within(panel).getByRole("button", { name: "ปิด" }));
    expect(screen.queryByRole("complementary", { name: "Brand config" })).toBeNull();
    expect(screen.getByText(/7-day stats · Leads: 9 · Sold: 3 · Pending: 2/)).toBeDefined();
  });

  it("keeps employee runtime controls accessible with owner-only controls hidden", async () => {
    render(<BrandLifecycle me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
    const panel = await screen.findByRole("complementary", { name: "Brand config" });
    await within(panel).findByRole("button", { name: "Pause แบรนด์" });
    expect(section(panel, "Keyword default").getByRole("textbox")).toBeDefined();
    expect(within(panel).queryByRole("textbox", { name: "Amount buckets" })).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Rotate token" })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่ม Upgrade-all/ })).toBeNull();
  });

  it("renders a factory-only draft from the API and does not offer runtime config", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, status: "draft", runtime_sync_status: "queued", bundle_form_version: null, payload_version: null }];
    render(<BrandLifecycle me={employee} />);
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Install" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Runtime config/ })).toBeNull();
  });

  it("surfaces the failed dispatch ID and error and retries that exact install", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, status: "draft", runtime_sync_status: "queued" }];
    detail(failed);
    routes.set("POST /api/brands/brand-a/install", () => json({ error: "factory_dispatch_failed", install_id: failed.install_id, message: "Factory Worker binding is missing" }, 502));
    routes.set("POST /api/installs/failed-1/retry", () => {
      detail({ ...failed, status: "running", runtime_sync_status: "running" });
      return json({ install_id: failed.install_id, brand_id: "brand-a", status: "running" }, 201);
    });
    render(<BrandLifecycle me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect(await screen.findByText("failed-1", { selector: "code" })).toBeDefined();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Factory Worker binding is missing");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/installs/failed-1/retry")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("recovers the latest failed attempt and its persisted error on reload and Refresh", async () => {
    history([{ ...failed, error: "Factory transport failed" }, { install_id: "older-ready", status: "ready", error: null }]);
    detail(failed);
    const first = render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByText("Factory transport failed")).toBeDefined();
    first.unmount();
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeDefined();
    expect(screen.getByText("failed-1", { selector: "code" })).toBeDefined();

    const latest = { ...failed, install_id: "failed-2", receipts: [{ step: "sync_runtime", status: "failed" as const, error: "Core sync failed" }] };
    history([{ ...latest, error: "Second failure" }, { ...failed, error: null }]);
    detail(latest);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByText("failed-2", { selector: "code" })).toBeDefined();
    expect(await screen.findByText("Core sync failed")).toBeDefined();
    expect(screen.queryByText("failed-1", { selector: "code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("recovers an active install before failed history, polls receipts, and stops at terminal state", async () => {
    const running = { ...failed, install_id: "active-1", status: "running" as const, runtime_sync_status: "running" as const };
    history([{ ...failed, error: "older failure" }, { ...running, error: null }]);
    detail(running);
    vi.useFakeTimers();
    await act(async () => { render(<BrandLifecycle me={owner} />); });
    expect(screen.getAllByText("active-1", { selector: "code" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
    detail({ ...running, status: "ready", runtime_sync_status: "ready", receipts: [{ step: "sync_runtime", status: "ready" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("sync_runtime")).toBeDefined();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeDefined();
    const reads = requests.filter((r) => r.path === "/api/installs/active-1").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(requests.filter((r) => r.path === "/api/installs/active-1")).toHaveLength(reads);
  });

  it("ignores install history arriving after the operator switches brands", async () => {
    lifecycleRows.push({ ...brand, brand_id: "brand-b", hostnames: ["second.test"], status: "draft" });
    let release!: (response: Response) => void;
    routes.set("GET /api/brands/brand-a/installs", () => new Promise<Response>((resolve) => { release = resolve; }));
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    render(<BrandLifecycle me={employee} />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /second.test/ }));
    await screen.findByRole("button", { name: "Install" });
    await act(async () => { release(json({ brand_id: "brand-a", installs: [{ ...failed, error: "stale failure" }] })); });
    expect(screen.queryByText("failed-1", { selector: "code" })).toBeNull();
    expect(screen.queryByText("stale failure")).toBeNull();
    expect(screen.queryByRole("button", { name: /Runtime config/ })).toBeNull();
  });
});
