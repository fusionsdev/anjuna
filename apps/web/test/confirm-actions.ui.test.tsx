import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type BrandConfig, type InstallWithReceipts } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";
import { UsersScreen } from "../src/client/screens/Users";
import { flowGateLabel } from "../src/client/labels";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const brand = LifecycleBrandSummary.parse({
  brand_id: "brand-a", account: "test-account", hostnames: ["renderable.test"],
  status: "live", current_revision_id: "rev-1", runtime_sync_status: "ready",
  bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
const initialConfig: BrandConfig = {
  brand_id: "brand-a", account: "test-account", hostnames: ["renderable.test"], status: "live",
  form_version: "form@abcdef1", keyword_default: "Quick Loan", brand_name: null, site_title: null, site_description: null, theme: null, amount_buckets: [100, 500],
  ab_config: null, flow_gate_mode: "param", aid: "123", prepop_base: "https://buyer.example/apply", drain_key: "brand-a",
  google_ads_account: null, google_conversion_action: null, adkit_project: null,
  postback_token: "set", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const failed: InstallWithReceipts = {
  install_id: "failed-1", brand_id: "brand-a", revision_id: "rev-1", status: "failed",
  runtime_sync_status: "failed", receipts: [],
};
const running: InstallWithReceipts = { ...failed, install_id: "op-1", status: "running", runtime_sync_status: "running" };

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let config: BrandConfig;
let lifecycleRows: LifecycleBrandSummary[];
let users: Array<{ id: string; email: string; name: string; role: "owner" | "employee" }>;
let requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (method: string, suffix: string) => requests.filter((r) => r.method === method && r.path.endsWith(suffix));
const history = (installs: unknown[]) => routes.set("GET /api/brands/brand-a/installs", () => json({ brand_id: "brand-a", installs }));
const detail = (install: InstallWithReceipts) => routes.set(`GET /api/installs/${install.install_id}`, () => json(install));

beforeEach(() => {
  config = structuredClone(initialConfig);
  lifecycleRows = [structuredClone(brand)];
  users = [
    { id: "me", email: "owner@example.test", name: "Owner", role: "owner" },
    { id: "u2", email: "staff@example.test", name: "Staff", role: "employee" },
  ];
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/lifecycle/brands", () => json({ brands: lifecycleRows })],
    ["GET /api/brands", () => json({ brands: [{
      brand_id: config.brand_id, hostnames: config.hostnames, status: config.status,
      flow_gate_mode: config.flow_gate_mode, ab_config: config.ab_config, form_version: config.form_version,
      stats_7d: { leads: 0, sold: 0, pending: 0 },
    }], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/brands/brand-a", () => json({ brand: config })],
    ["GET /api/brands/brand-a/site-text", () => json({ brand_id: "brand-a", defaults: null })],
    ["GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: [] })],
    ["GET /api/brands/brand-a/assets", () => json({ brand_id: "brand-a", assets: [] })],
    ["GET /api/brands/brand-a/edit", () => json({ brand_id: "brand-a", status: "live", template_version_id: "tv-1", microsoft_ads_account: null })],
    ["GET /api/templates/sealed", () => json({ templates: [{ template_version_id: "tv-1", name: "Harbor", version: 1, status: "sealed" }] })],
    ["GET /api/funnel", () => json({ from: "2026-09-29T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z", rows: [] })],
    ["PATCH /api/brands/brand-a", (init) => {
      const { expected_updated_at: _, ...patch } = JSON.parse(String(init?.body));
      config = { ...config, ...patch, updated_at: `2026-10-06T00:00:${String(requests.length).padStart(2, "0")}Z` };
      return json({ brand: config });
    }],
    ["POST /api/brands/brand-a/pause", () => { config.status = "paused"; return json({ brand: config }); }],
    ["POST /api/brands/brand-a/resume", () => { config.status = "live"; return json({ brand: config }); }],
    ["POST /api/brands/brand-a/rollback", () => json({ install_id: "op-1", brand_id: "brand-a", status: "running" }, 201)],
    ["POST /api/brands/brand-a/recover", () => json({ install_id: "op-1", brand_id: "brand-a", status: "queued" }, 201)],
    ["POST /api/upgrade-all", () => json({ instance_id: "new-upgrade" }, 201)],
    ["GET /api/users", () => json({ users })],
    ["PATCH /api/users/u2", (init) => {
      users = users.map((u) => (u.id === "u2" ? { ...u, ...JSON.parse(String(init?.body)) } : u));
      return json({ ok: true });
    }],
  ]);
  history([]);
  detail(running);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const handler = routes.get(`${method} ${input.startsWith("/api/funnel?") ? "/api/funnel" : input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("BrandLifecycle actions that had no confirmation", () => {
  const recoverable = () => {
    lifecycleRows = [{ ...brand, status: "installing", current_revision_id: null, runtime_sync_status: "failed" }];
    history([{ install_id: failed.install_id, status: "failed", error: "Compensation failed" }]);
    detail({ ...failed, recovery_required: true });
  };

  it.each([
    ["rollback", "ย้อนกลับ (Rollback)", "/rollback", false],
    ["recover", "กู้คืน (Recover, Owner)", "/recover", true],
  ] as const)("%s asks first and sends nothing on cancel", async (_name, button, suffix, needsRecovery) => {
    if (needsRecovery) recoverable();
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: button }));
    await answerConfirm(false);
    expect(sent("POST", suffix)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: button }));
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", suffix)).toHaveLength(1));
  });

  it("names the action in the rollback and recover dialogs", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "ย้อนกลับ (Rollback)" }));
    const rollbackDialog = await answerConfirm(false);
    expect(rollbackDialog.textContent).toContain("ย้อนกลับแบรนด์นี้เป็นเวอร์ชันก่อนหน้า?");
    cleanup();
    recoverable();
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "กู้คืน (Recover, Owner)" }));
    const recoverDialog = await answerConfirm(false);
    expect(recoverDialog.textContent).toContain("กู้คืนแบรนด์นี้?");
  });

  it("asks before Start upgrade-all, shows the target in the dialog, and sends nothing on cancel", async () => {
    render(<BrandLifecycle me={owner} />);
    await screen.findByText("ยังไม่มีการอัปเกรดทุกแบรนด์ที่รับคำสั่ง (No accepted upgrade-all yet)");
    fireEvent.change(screen.getByLabelText("from_template_version_id"), { target: { value: "tv-1" } });
    fireEvent.change(screen.getByLabelText("to_template_version_id"), { target: { value: "tv-2" } });
    const start = () => fireEvent.click(screen.getByRole("button", { name: "เริ่มอัปเกรดทุกแบรนด์ (Start upgrade-all)" }));
    start();
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("tv-1");
    expect(dialog.textContent).toContain("tv-2");
    expect(sent("POST", "/api/upgrade-all")).toHaveLength(0);
    start();
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", "/api/upgrade-all")).toHaveLength(1));
  });
});

describe("ConfigPanel actions that had no confirmation", () => {
  const renderPanel = () => render(<ConfigPanel me={owner} brandId="brand-a" onClose={() => undefined} onChanged={() => undefined} />);

  it("asks before Pause and sends nothing on cancel", async () => {
    renderPanel();
    const pause = () => screen.getByRole("button", { name: "หยุดชั่วคราว (Pause)" });
    fireEvent.click(await screen.findByRole("button", { name: "หยุดชั่วคราว (Pause)" }));
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("หยุดแบรนด์นี้ชั่วคราว?");
    expect(sent("POST", "/pause")).toHaveLength(0);
    fireEvent.click(pause());
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", "/pause")).toHaveLength(1));
  });

  it("asks before Resume of a paused brand and sends nothing on cancel", async () => {
    config.status = "paused";
    renderPanel();
    const resume = () => screen.getByRole("button", { name: "เปิดใช้งานต่อ (Resume)" });
    fireEvent.click(await screen.findByRole("button", { name: "เปิดใช้งานต่อ (Resume)" }));
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("เปิดแบรนด์นี้ต่อ?");
    expect(sent("POST", "/resume")).toHaveLength(0);
    fireEvent.click(resume());
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", "/resume")).toHaveLength(1));
  });

  it("asks before a flow gate change, keeps the old value on cancel, and labels the options", async () => {
    renderPanel();
    const heading = await screen.findByRole("heading", { name: "เกตของโฟลว์ (Flow gate)" });
    const select = within(heading.closest("section")!).getByRole("combobox");
    const value = () => (select as unknown as HTMLSelectElement).value;
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Keyword Param", "Single Page Cookie"]);
    expect(flowGateLabel).toEqual({ param: "Keyword Param", signed_cookie: "Single Page Cookie" });
    fireEvent.change(select, { target: { value: "signed_cookie" } });
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("Single Page Cookie");
    expect(sent("PATCH", "/api/brands/brand-a")).toHaveLength(0);
    expect(value()).toBe("param");
    fireEvent.change(select, { target: { value: "signed_cookie" } });
    await answerConfirm(true);
    await waitFor(() => expect(sent("PATCH", "/api/brands/brand-a")).toHaveLength(1));
    expect(sent("PATCH", "/api/brands/brand-a")[0]!.body).toMatchObject({ flow_gate_mode: "signed_cookie" });
  });
});

describe("Users role change", () => {
  it("asks first, keeps the old role on cancel, and sends one PATCH on accept", async () => {
    render(<UsersScreen me={owner} />);
    const select = (await screen.findByLabelText("สิทธิ์ของ staff@example.test")) as unknown as HTMLSelectElement;
    expect(select.value).toBe("employee");
    fireEvent.change(select, { target: { value: "owner" } });
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("เปลี่ยนสิทธิ์ของ staff@example.test เป็น Owner?");
    expect(sent("PATCH", "/api/users/u2")).toHaveLength(0);
    expect(select.value).toBe("employee");
    fireEvent.change(select, { target: { value: "owner" } });
    await answerConfirm(true);
    await waitFor(() => expect(sent("PATCH", "/api/users/u2")).toHaveLength(1));
    expect(sent("PATCH", "/api/users/u2")[0]!.body).toEqual({ role: "owner" });
    await waitFor(() => expect((screen.getByLabelText("สิทธิ์ของ staff@example.test") as unknown as HTMLSelectElement).value).toBe("owner"));
  });
});
