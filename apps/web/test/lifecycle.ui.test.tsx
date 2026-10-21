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
  form_version: "form@abcdef1", keyword_default: "Quick Loan", brand_name: null, site_title: null, site_description: null, amount_buckets: [100, 500],
  ab_config: { experiment_id: "exp-1", variants: [{ id: "lite_v1", weight: 50 }, { id: "full_v1", weight: 50 }] },
  flow_gate_mode: "param", aid: "123", prepop_base: "https://buyer.example/apply", drain_key: "brand-a",
  google_ads_account: null, google_conversion_action: null, adkit_project: null,
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
const installName = "ติดตั้ง (Install)";
const rollbackName = "ย้อนกลับ (Rollback)";
const retryName = "ลองใหม่ (Retry)";
const recoverName = "กู้คืน (Recover, Owner)";
const configLabel = "การตั้งค่าแบรนด์ (Brand config)";
const pauseName = "หยุดชั่วคราว (Pause)";
const resumeName = "เปิดใช้งานต่อ (Resume)";
const keywordSection = "คีย์เวิร์ดเริ่มต้น (Keyword default)";
const saveName = "บันทึก (Save)";
const bucketsLabel = "ช่วงยอดเงิน (Amount buckets)";
const abWeightLabel = "น้ำหนัก A/B (A/B weight)";
const saveAbName = "บันทึก A/B (Save A/B)";
const flowGateSection = "เกตของโฟลว์ (Flow gate)";
const closeName = "ปิด (Close)";
const rotateName = "หมุนโทเคน (Rotate token)";
const accountLabel = "บัญชี Google Ads (Google Ads account)";
const actionLabel = "รหัส conversion action (Conversion action)";
const projectLabel = "โปรเจกต์ AdKit (AdKit project)";
const moneySection = "เส้นทางเงิน (Money-path, Owner เท่านั้น)";
const openRuntimeConfig = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
};
const section = (panel: HTMLElement, heading: string | RegExp) => within(within(panel).getByRole("heading", { name: heading }).closest("section")!);

beforeEach(() => {
  config = structuredClone(initialConfig);
  runtimeAvailable = true;
  lifecycleRows = [structuredClone(brand)];
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/lifecycle/brands", () => json({ brands: lifecycleRows })],
    ["GET /api/brands", () => json({ brands: runtimeAvailable ? [{
      brand_id: config.brand_id, hostnames: config.hostnames, status: config.status,
      flow_gate_mode: config.flow_gate_mode, ab_config: config.ab_config, form_version: config.form_version,
      stats_7d: { leads: 9, sold: 3, pending: 2 },
    }] : [], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/brands/brand-a", () => json({ brand: config })],
    ["GET /api/brands/brand-a/site-text", () => json({ brand_id: "brand-a", defaults: null })],
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
  it("shows core-list failure with factory rows and clears it after a successful refresh", async () => {
    routes.set("GET /api/lifecycle/brands", () => json({ brands: lifecycleRows, core_error: { code: "core_list_fetch_failed", message: "Core brand list fetch failed" } }));
    render(<BrandLifecycle me={employee} />);
    expect(await screen.findByText(/Core brand list is unavailable/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeTruthy();
    routes.set("GET /api/lifecycle/brands", () => json({ brands: lifecycleRows, core_error: null }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.queryByText(/Core brand list is unavailable/)).toBeNull());
  });

  it("reloads latest outcomes immediately after an accepted upgrade-all", async () => {
    routes.set("POST /api/upgrade-all", () => json({ instance_id: "new-upgrade" }, 201));
    render(<BrandLifecycle me={owner} />);
    await screen.findByText("ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง (No accepted upgrade-all yet)");
    const reads = () => requests.filter((r) => r.path === "/api/upgrade-all/latest").length;
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: "เริ่มอัปเกรดทุกแบรนด์ (Start upgrade-all)" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("hides Rollback from Employees on a live brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "renderable.test" });
    expect(screen.queryByRole("button", { name: rollbackName })).toBeNull();
  });

  it("loads API rows and opens working runtime pause, keyword, buckets, A/B and gate controls", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeDefined();
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    fireEvent.click(await within(panel).findByRole("button", { name: pauseName }));
    expect(within(panel).getByRole("button", { name: /Rollback/ })).toBeDefined();
    fireEvent.click(await within(panel).findByRole("button", { name: resumeName }));
    await within(panel).findByRole("button", { name: pauseName });
    expect(requests.some((r) => r.path.endsWith("/pause") && r.method === "POST")).toBe(true);
    expect(requests.some((r) => r.path.endsWith("/resume") && r.method === "POST")).toBe(true);

    fireEvent.change(section(panel, keywordSection).getByRole("textbox"), { target: { value: "Fast Cash" } });
    fireEvent.click(section(panel, keywordSection).getByRole("button", { name: saveName }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ keyword_default: "Fast Cash", expected_updated_at: expect.any(String) }));
    await waitFor(() => expect((section(panel, keywordSection).getByRole("textbox") as HTMLInputElement).value).toBe("Fast Cash"));

    fireEvent.change(within(panel).getByRole("textbox", { name: bucketsLabel }), { target: { value: "200, 600" } });
    fireEvent.click(section(panel, bucketsLabel).getByRole("button", { name: saveName }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ amount_buckets: [200, 600] }));

    fireEvent.change(await within(panel).findByRole("slider", { name: abWeightLabel }), { target: { value: "70" } });
    fireEvent.click(within(panel).getByRole("button", { name: saveAbName }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ ab_config: { variants: [{ id: "lite_v1", weight: 70 }, { id: "full_v1", weight: 30 }] } }));

    fireEvent.change(section(panel, flowGateSection).getByRole("combobox"), { target: { value: "signed_cookie" } });
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ flow_gate_mode: "signed_cookie" }));
    fireEvent.click(within(panel).getByRole("button", { name: closeName }));
    expect(screen.queryByRole("complementary", { name: configLabel })).toBeNull();
    expect(screen.getByText(/สถิติ 7 วัน · ลีด \(Leads\): 9 · ขายได้ \(Sold\): 3 · รอผล \(Pending\): 2/)).toBeDefined();
  });

  it("keeps employee runtime controls accessible with owner-only controls hidden", async () => {
    render(<BrandLifecycle me={employee} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findAllByRole("textbox");
    expect(within(panel).queryByRole("button", { name: pauseName })).toBeNull();
    expect(section(panel, keywordSection).getByRole("textbox")).toBeDefined();
    expect(within(panel).queryByRole("textbox", { name: bucketsLabel })).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: rotateName })).toBeNull();
    for (const label of [accountLabel, actionLabel, projectLabel]) expect(within(panel).queryByRole("textbox", { name: label })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: rollbackName })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Rollback/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่มอัปเกรดทุกแบรนด์/ })).toBeNull();
  });

  it("labels every control in the config panel as Thai (English)", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    routes.set("PATCH /api/brands/brand-a", () => json({ brand: config, issued_postback_token: "tok_0123456789abcdef" }));
    render(<BrandLifecycle me={owner} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findByRole("button", { name: pauseName });
    expect(within(panel).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "สถานะ (Pause / Resume)", keywordSection, "ข้อความหน้าเว็บ (Site text)", rollbackName, "น้ำหนัก A/B (A/B weights, รวมต้องเป็น 100%)", bucketsLabel, flowGateSection, "เส้นทางเงิน (Money-path, Owner เท่านั้น)",
    ]);
    for (const label of ["รหัส LeadsGate (LeadsGate aid)", "URL ฐาน prepop (Prepop base)", "คีย์ drain (Drain key)", accountLabel, actionLabel, projectLabel]) expect(within(panel).getByRole("textbox", { name: label })).toBeDefined();
    expect(within(panel).getByText(/^บัญชี \(Account\) test-account/)).toBeDefined();
    expect(within(panel).getByText(/โทเคน postback \(Postback token\):/)).toBeDefined();
    // Every button reads Thai first with the English term in parentheses.
    const thaiThenEnglish = /^[฀-๿][^()]*\([A-Za-z][^()]*\)/;
    for (const button of within(panel).getAllByRole("button")) expect(button.textContent, button.textContent ?? "").toMatch(thaiThenEnglish);
    fireEvent.click(within(panel).getByRole("button", { name: rotateName }));
    const modal = await screen.findByRole("dialog", { name: "โทเคน postback ใหม่ (New postback token)" });
    expect(within(modal).getByRole("heading", { name: "โทเคน postback ใหม่ (New postback token)" })).toBeDefined();
    expect(within(modal).getByRole("button", { name: "คัดลอก (Copy)" })).toBeDefined();
    expect(within(modal).getByRole("button", { name: closeName })).toBeDefined();
  });

  it("lets the Owner set, validate and clear the Google Ads drain route", async () => {
    render(<BrandLifecycle me={owner} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findByRole("heading", { name: moneySection });
    const money = section(panel, moneySection);
    const save = money.getByRole("button", { name: saveName }) as HTMLButtonElement;
    const account = money.getByRole("textbox", { name: accountLabel });
    fireEvent.change(account, { target: { value: "481-121-9623" } });
    expect(save.disabled).toBe(true);
    expect(account.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(account, { target: { value: "4811219623" } });
    fireEvent.change(money.getByRole("textbox", { name: actionLabel }), { target: { value: " 7754587837 " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toEqual({
      google_ads_account: "4811219623", google_conversion_action: "7754587837", expected_updated_at: initialConfig.updated_at,
    }));
    await waitFor(() => expect(config.google_ads_account).toBe("4811219623"));
    const after = section(screen.getByRole("complementary", { name: configLabel }), moneySection);
    await waitFor(() => expect((after.getByRole("textbox", { name: accountLabel }) as HTMLInputElement).value).toBe("4811219623"));
    fireEvent.change(after.getByRole("textbox", { name: accountLabel }), { target: { value: "" } });
    fireEvent.click(after.getByRole("button", { name: saveName }));
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ google_ads_account: null }));
    expect(lastBody("/api/brands/brand-a")).not.toHaveProperty("google_conversion_action");
  });

  it("shows the brand name in the list and the detail header with the hostname as secondary text", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, name: "Level Lending" }];
    render(<BrandLifecycle me={employee} />);
    const item = await screen.findByRole("button", { name: /Level Lending/ });
    expect(item.textContent).toContain("renderable.test");
    expect(within(item).getByText("Level Lending").tagName).toBe("B");
    expect(within(item).getByText("renderable.test").tagName).not.toBe("B");
    const header = await screen.findByRole("heading", { name: "Level Lending" });
    expect(header.textContent).toBe("Level Lending");
    expect(header.closest("section")!.textContent).toContain("renderable.test");
  });

  it("falls back to the hostname when a brand has no stored name", async () => {
    runtimeAvailable = false;
    render(<BrandLifecycle me={employee} />);
    const item = await screen.findByRole("button", { name: /renderable.test/ });
    expect(within(item).getByText("renderable.test").tagName).toBe("B");
    expect((await screen.findByRole("heading", { name: "renderable.test" })).textContent).toBe("renderable.test");
  });

  it("renders a factory-only draft from the API and does not offer runtime config", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, status: "draft", runtime_sync_status: "queued", bundle_form_version: null, payload_version: null }];
    render(<BrandLifecycle me={employee} />);
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeDefined();
    // No confirmed form artifact: Install is shown but disabled, with the reason.
    expect(await screen.findByRole("button", { name: installName })).toHaveProperty("disabled", true);
    expect((await screen.findByRole("note")).textContent).toBe("ติดตั้งไม่ได้: แบรนด์นี้ยังไม่มี form artifact ที่ยืนยันแล้ว");
    expect(screen.queryByRole("button", { name: /Runtime config/ })).toBeNull();
  });

  it("reloads terminal upgrade outcomes after an install retry is accepted", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, status: "draft", runtime_sync_status: "queued" }];
    detail(failed);
    const outcomeRow = (install_id: string, status: string, retry_of: string | null) => ({
      brand_id: "brand-a", domain: "renderable.test", is_canary: true, install_id, retry_of, status, error: status === "failed" ? "Smoke check failed" : null,
    });
    const upgradeBody = (outcomes: unknown[]) => ({ upgrade: {
      audit_id: 1, accepted_at: "2026-10-09T00:00:00Z",
      command: { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-a", started_by: "owner", started_role: "owner" },
      outcomes,
    } });
    let retried = false;
    routes.set("GET /api/upgrade-all/latest", () => json(upgradeBody([retried ? outcomeRow("retry-install", "ready", "failed-1") : outcomeRow("failed-1", "failed", null)])));
    routes.set("POST /api/brands/brand-a/install", () => json({ error: "factory_dispatch_failed", install_id: failed.install_id, message: "Factory Worker binding is missing" }, 502));
    routes.set("POST /api/installs/failed-1/retry", () => {
      retried = true;
      detail({ ...failed, status: "running", runtime_sync_status: "running" });
      return json({ install_id: failed.install_id, brand_id: "brand-a", status: "running" }, 201);
    });
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByText("Smoke check failed")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: installName }));
    fireEvent.click(await screen.findByRole("button", { name: retryName }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/installs/failed-1/retry")).toBe(true));
    expect(await screen.findByText("retry-install", { selector: "code" })).toBeDefined();
    expect(screen.queryByText("Smoke check failed")).toBeNull();
  });

  describe("runtime sync cell after a redeploy", () => {
    const syncCell = () => screen.getByText("การซิงก์ runtime").nextElementSibling?.textContent;
    const redeployName = "ติดตั้งใหม่ (Redeploy)";
    const readyLabel = "พร้อมใช้งาน (ready)";
    const runningLabel = "กำลังทำงาน (running)";
    const syncErrorLabel = "ซิงก์ผิดพลาด (sync_error)";

    it("clears a sync_error label once the list reports ready, without reselecting the brand", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      lifecycleRows = [{ ...brand, runtime_sync_status: "sync_error" }];
      routes.set("POST /api/brands/brand-a/redeploy", () => {
        lifecycleRows = [{ ...brand, runtime_sync_status: "ready" }];
        return json({ install_id: "redeploy-1", brand_id: "brand-a", status: "running" }, 201);
      });
      detail({ ...failed, install_id: "redeploy-1", status: "ready", runtime_sync_status: "ready", receipts: [{ step: "sync_runtime", status: "ready" }] });
      render(<BrandLifecycle me={owner} />);
      await waitFor(() => expect(syncCell()).toBe(syncErrorLabel));
      fireEvent.click(await screen.findByRole("button", { name: redeployName }));
      await screen.findAllByText("redeploy-1", { selector: "code" });
      await waitFor(() => expect(syncCell()).toBe(readyLabel));
      expect(requests.filter((r) => r.method === "GET" && r.path === "/api/brands/brand-a/installs")).toHaveLength(1);
    });

    it("does not show ready while the install is still running and the list reloads with ready", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      routes.set("POST /api/brands/brand-a/redeploy", () => {
        lifecycleRows = [{ ...brand, runtime_sync_status: "ready", current_revision_id: "rev-2" }];
        return json({ install_id: "redeploy-1", brand_id: "brand-a", status: "running" }, 201);
      });
      detail({ ...failed, install_id: "redeploy-1", revision_id: "rev-2", status: "running", runtime_sync_status: "running" });
      render(<BrandLifecycle me={owner} />);
      fireEvent.click(await screen.findByRole("button", { name: redeployName }));
      await screen.findAllByText("redeploy-1", { selector: "code" });
      await waitFor(() => expect(requests.filter((r) => r.path === "/api/lifecycle/brands").length).toBeGreaterThan(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(syncCell()).toBe(runningLabel);
    });
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
    fireEvent.click(await screen.findByRole("button", { name: installName }));
    expect(await screen.findByText("failed-1", { selector: "code" })).toBeDefined();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Factory Worker binding is missing");
    fireEvent.click(await screen.findByRole("button", { name: retryName }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/installs/failed-1/retry")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: retryName })).toBeNull());
    expect(screen.queryByRole("button", { name: installName })).toBeNull();
  });

  it("recovers the latest failed attempt and its persisted error on reload and Refresh", async () => {
    history([{ ...failed, error: "Factory transport failed" }, { install_id: "older-ready", status: "ready", error: null }]);
    detail(failed);
    const first = render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: retryName })).toBeDefined();
    expect(screen.getByText("Factory transport failed")).toBeDefined();
    first.unmount();
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: retryName })).toBeDefined();
    expect(screen.getByText("failed-1", { selector: "code" })).toBeDefined();

    const latest = { ...failed, install_id: "failed-2", receipts: [{ step: "sync_runtime", status: "failed" as const, error: "Core sync failed" }] };
    history([{ ...latest, error: "Second failure" }, { ...failed, error: null }]);
    detail(latest);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByText("failed-2", { selector: "code" })).toBeDefined();
    expect(await screen.findByText("Core sync failed")).toBeDefined();
    expect(screen.queryByText("failed-1", { selector: "code" })).toBeNull();
    expect(screen.getByRole("button", { name: retryName })).toBeDefined();
  });

  it("recovers an active install before failed history, polls receipts, and stops at terminal state", async () => {
    const running = { ...failed, install_id: "active-1", status: "running" as const, runtime_sync_status: "running" as const };
    history([{ ...failed, error: "older failure" }, { ...running, error: null }]);
    detail(running);
    vi.useFakeTimers();
    await act(async () => { render(<BrandLifecycle me={owner} />); });
    expect(screen.getAllByText("active-1", { selector: "code" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: retryName })).toBeNull();
    expect(screen.queryByRole("button", { name: rollbackName })).toBeNull();
    detail({ ...running, status: "ready", runtime_sync_status: "ready", receipts: [{ step: "sync_runtime", status: "ready" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(/Sync runtime, ads, mailing list/)).toBeDefined();
    expect(screen.getByRole("button", { name: rollbackName })).toBeDefined();
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
    await screen.findByRole("button", { name: installName });
    await act(async () => { release(json({ brand_id: "brand-a", installs: [{ ...failed, error: "stale failure" }] })); });
    expect(screen.queryByText("failed-1", { selector: "code" })).toBeNull();
    expect(screen.queryByText("stale failure")).toBeNull();
    expect(screen.queryByRole("button", { name: /Runtime config/ })).toBeNull();
  });
});

describe("a click right after a brand is selected", () => {
  // No wait for the checklist request: the controls of a newly selected brand must keep what the first click does.
  it("keeps the Runtime config drawer opened by an immediate click", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
    expect(await screen.findByRole("complementary", { name: configLabel })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("complementary", { name: configLabel })).toBeTruthy();
  });

  it("keeps the install started by an immediate Install click", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, status: "draft", runtime_sync_status: "queued" }];
    routes.set("POST /api/brands/brand-a/install", () => json({ install_id: "new-install" }, 201));
    detail({ ...failed, install_id: "new-install", status: "running", runtime_sync_status: "running" });
    render(<BrandLifecycle me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: installName }));
    expect((await screen.findAllByText("new-install", { selector: "code" })).length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getAllByText("new-install", { selector: "code" }).length).toBeGreaterThan(0);
  });
});

it("Owner recovers a retained lock from the panel and sees completion receipts", async () => {
  lifecycleRows = [{ ...brand, status: "installing", current_revision_id: null, runtime_sync_status: "failed" }];
  history([{ install_id: failed.install_id, status: "failed", error: "Compensation failed" }]);
  detail({ ...failed, recovery_required: true });
  routes.set("POST /api/brands/brand-a/recover", () => {
    lifecycleRows = [{ ...brand, status: "failed", current_revision_id: null }];
    return json({ install_id: "recovery-1", brand_id: "brand-a", status: "queued" }, 201);
  });
  detail({ ...failed, install_id: "recovery-1", revision_id: null, status: "rolled_back", runtime_sync_status: "ready", receipts: [{ step: "receipt", status: "ready" }] });
  render(<BrandLifecycle me={owner} />);
  fireEvent.click(await screen.findByRole("button", { name: recoverName }));
  await waitFor(() => expect(requests.filter((r) => r.path === "/api/brands/brand-a/recover")).toHaveLength(1));
  await screen.findByText("recovery-1");
  await screen.findByRole("button", { name: installName });
  expect(screen.queryByRole("button", { name: recoverName })).toBeNull();
});
