import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary, type BrandConfig, type InstallWithReceipts } from "@anjuna/contracts";
import { BrandLifecycle, LifecycleDetail } from "../src/client/screens/BrandLifecycle";
import { answerConfirm } from "./confirm";

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
  form_version: "form@abcdef1", keyword_default: "Quick Loan", brand_name: null, site_title: null, site_description: null, theme: null, amount_buckets: [100, 500],
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
/** The Test sold fix button, once the install history read is done: it is disabled while that read runs, and a click then does nothing. */
const enabledSoldButton = async () => {
  const button = await screen.findByRole("button", { name: "ยืนยันการทดสอบการขาย" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
};
const history = (installs: unknown[]) => routes.set("GET /api/brands/brand-a/installs", () => json({ brand_id: "brand-a", installs }));
const detail = (install: InstallWithReceipts) => routes.set(`GET /api/installs/${install.install_id}`, () => json(install));
/** The row also has an Install and a Recover button (its primary one): the detail aside is the scope of these names. */
const inAside = () => within(document.querySelector<HTMLElement>(".brands-aside")!);
const installName = "ติดตั้ง";
const rollbackName = "ย้อนกลับ";
/** The Runtime config drawer (ConfigPanel, not changed here) still titles its rollback section with the English term. */
const rollbackHeading = "ย้อนกลับ (Rollback)";
const retryName = "ลองใหม่ (Retry)";
const recoverName = "กู้คืน";
const configLabel = "การตั้งค่าแบรนด์ (Brand config)";
const pauseName = "หยุดชั่วคราว (Pause)";
const resumeName = "เปิดใช้งานต่อ (Resume)";
const keywordSection = "คีย์เวิร์ดเริ่มต้น (Keyword default)";
const saveName = "บันทึก (Save)";
const bucketsLabel = "ช่วงยอดเงิน (Amount buckets)";
const abSummarySection = "น้ำหนัก A/B (A/B weights)";
const editInSettingsName = "แก้ไขใน Settings (Edit in Settings)";
const flowGateSection = "เกตของโฟลว์ (Flow gate)";
const closeName = "ปิด (Close)";
const rotateName = "หมุนโทเคน (Rotate token)";
const accountLabel = "บัญชี Google Ads (Google Ads account)";
const actionLabel = "รหัส conversion action (Conversion action)";
const projectLabel = "โปรเจกต์ AdKit (AdKit project)";
const moneySection = "เส้นทางเงิน (Money-path, Owner เท่านั้น)";
const openRuntimeConfig = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "ตั้งค่าแบรนด์" }));
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
    // Served, so a failed revisions load does not add a second alert to the screens that look for one.
    ["GET /api/brands/brand-a/revisions", () => json({ brand_id: "brand-a", current_revision_id: null, rollback_target_revision_id: null, revisions: [] })],
    ["GET /api/brands/brand-a/assets", () => json({ brand_id: "brand-a", assets: [] })],
    ["GET /api/brands/brand-a/edit", () => json({ brand_id: "brand-a", status: "live", template_version_id: "tv-1", microsoft_ads_account: null })],
    ["GET /api/templates/sealed", () => json({ templates: [{ template_version_id: "tv-1", name: "Harbor", version: 1, status: "sealed" }] })],
    ["GET /api/funnel", () => json({ from: "2026-09-29T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z", rows: [
      { brand: "brand-a", keyword: "Quick Cash", variant: "a", clicks: 20, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: null, sold_rate: null },
      { brand: "brand-a", keyword: null, variant: null, clicks: 5, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: null, sold_rate: null },
      { brand: "brand-z", keyword: null, variant: null, clicks: 99, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: null, sold_rate: null },
    ] })],
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
    // The funnel query carries timestamps: route it by path.
    const handler = routes.get(`${method} ${input.startsWith("/api/funnel?") ? "/api/funnel" : input}`);
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
    fireEvent.click(screen.getByRole("button", { name: "รีเฟรช" }));
    await waitFor(() => expect(screen.queryByText(/Core brand list is unavailable/)).toBeNull());
  });

  it("says a route brand id that does not exist is not found", async () => {
    render(<BrandLifecycle me={owner} routeBrandId="brand_missing" />);
    expect(await screen.findByText(/ไม่พบแบรนด์/)).toBeTruthy();
    expect(screen.getByText("brand_missing")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "renderable.test" })).toBeNull();
  });

  it("does not say a route brand is missing while the Core list is unavailable", async () => {
    lifecycleRows = [];
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [], core_error: { code: "core_list_fetch_failed", message: "Core brand list fetch failed" } }));
    render(<BrandLifecycle me={owner} routeBrandId="core_only_brand" />);
    expect(await screen.findByText(/Core brand list is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/ไม่พบแบรนด์/)).toBeNull();
  });

  it("says a route brand id is not found when the brand list is empty", async () => {
    lifecycleRows = [];
    render(<BrandLifecycle me={owner} routeBrandId="brand_missing" />);
    expect(await screen.findByText(/ไม่พบแบรนด์/)).toBeTruthy();
    expect(screen.getByText("brand_missing")).toBeTruthy();
  });

  it("picks the first brand when Back leaves an unknown brand id for /brands", async () => {
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand_missing" />);
    expect(await screen.findByText(/ไม่พบแบรนด์/)).toBeTruthy();
    view.rerender(<BrandLifecycle me={owner} routeBrandId={null} />);
    expect(await screen.findByRole("heading", { name: "renderable.test" })).toBeTruthy();
    expect(screen.queryByText(/ไม่พบแบรนด์/)).toBeNull();
  });

  it("drops an unknown selection when Back leaves it before the brand list arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    routes.set("GET /api/lifecycle/brands", async () => { await gate; return json({ brands: lifecycleRows }); });
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand_missing" />);
    view.rerender(<BrandLifecycle me={owner} routeBrandId={null} />);
    await act(async () => { release(); });
    expect(await screen.findByRole("heading", { name: "renderable.test" })).toBeTruthy();
    expect(screen.queryByText(/ไม่พบแบรนด์/)).toBeNull();
  });

  it("keeps a valid selection when the route leaves its brand id for /brands", async () => {
    lifecycleRows = [structuredClone(brand), LifecycleBrandSummary.parse({ ...brand, brand_id: "brand-b", hostnames: ["second.test"] })];
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand-b" />);
    expect(await screen.findByRole("heading", { name: "second.test" })).toBeTruthy();
    view.rerender(<BrandLifecycle me={owner} routeBrandId={null} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { name: "second.test" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "renderable.test" })).toBeNull();
  });

  it("shows the wizard while wizardRoute is true and closes it when it turns false", async () => {
    routes.set("GET /api/templates", () => json({ templates: [] }));
    routes.set("GET /api/wizard/defaults", () => json({ amount_buckets: [100, 200, 300], form_route: "/request" }));
    const wizard = () => screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" });
    const view = render(<BrandLifecycle me={owner} wizardRoute />);
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
    view.rerender(<BrandLifecycle me={owner} wizardRoute={false} />);
    await waitFor(() => expect(wizard()).toBeNull());
    expect(await screen.findByRole("heading", { name: "แบรนด์" })).toBeTruthy();
  });

  it("no longer shows the upgrade-all card on Brands", async () => {
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: "renderable.test" });
    expect(screen.queryByRole("button", { name: "เริ่มอัปเกรดทุกแบรนด์" })).toBeNull();
    expect(screen.queryByLabelText("from_template_version_id")).toBeNull();
  });

  it("shows Rollback to Employees on a live brand disabled with the reason, and sends nothing", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "renderable.test" });
    const button = await inAside().findByRole("button", { name: rollbackName }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("เฉพาะเจ้าของย้อนกลับแบรนด์ได้");
    fireEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("loads API rows and opens working runtime pause, keyword, buckets and gate controls", async () => {
    render(<BrandLifecycle me={owner} />);
    expect(await screen.findByRole("button", { name: /renderable.test/ })).toBeDefined();
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    fireEvent.click(await within(panel).findByRole("button", { name: pauseName }));
    await answerConfirm(true);
    expect(within(panel).getByRole("button", { name: /Rollback/ })).toBeDefined();
    fireEvent.click(await within(panel).findByRole("button", { name: resumeName }));
    await answerConfirm(true);
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

    // spec polish D8.2: A/B is read-only here and points to Settings.
    expect(section(panel, abSummarySection).getByText("exp-1: Lite (lite_v1) 50% / 14 ขั้น (aurum-14-step) 50%")).toBeDefined();
    expect(section(panel, abSummarySection).getByRole("link", { name: editInSettingsName }).getAttribute("href")).toBe("/settings?brand=brand-a");
    expect(within(panel).queryByRole("slider")).toBeNull();

    fireEvent.change(section(panel, flowGateSection).getByRole("combobox"), { target: { value: "signed_cookie" } });
    await answerConfirm(true);
    await waitFor(() => expect(lastBody("/api/brands/brand-a")).toMatchObject({ flow_gate_mode: "signed_cookie" }));
    fireEvent.click(within(panel).getByRole("button", { name: closeName }));
    expect(screen.queryByRole("complementary", { name: configLabel })).toBeNull();
    expect(screen.getByText(/สถิติ 7 วัน · ลีด: 9 · ขายได้: 3 · รอผล: 2/)).toBeDefined();
  });

  it("sends no pause request when the Owner cancels Pause in the Runtime config drawer", async () => {
    render(<BrandLifecycle me={owner} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    fireEvent.click(await within(panel).findByRole("button", { name: pauseName }));
    await answerConfirm(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(requests.some((r) => r.method === "POST" && r.path.endsWith("/pause"))).toBe(false);
    expect(within(panel).getByRole("button", { name: pauseName })).toBeDefined();
  });

  it("keeps employee runtime controls accessible with owner-only controls hidden", async () => {
    render(<BrandLifecycle me={employee} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findAllByRole("textbox");
    // Pause shows disabled with its reason instead of being hidden.
    const pause = within(panel).getByRole("button", { name: pauseName }) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(pause.title).toBe("เฉพาะเจ้าของหยุดแบรนด์ได้");
    expect(section(panel, keywordSection).getByRole("textbox")).toBeDefined();
    expect(within(panel).queryByRole("heading", { name: abSummarySection })).toBeNull();
    expect(within(panel).queryByRole("textbox", { name: bucketsLabel })).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: rotateName })).toBeNull();
    for (const label of [accountLabel, actionLabel, projectLabel]) expect(within(panel).queryByRole("textbox", { name: label })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: rollbackHeading })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Rollback/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่มอัปเกรดทุกแบรนด์/ })).toBeNull();
  });

  it("labels every control in the config panel as Thai (English)", async () => {
    routes.set("PATCH /api/brands/brand-a", () => json({ brand: config, issued_postback_token: "tok_0123456789abcdef" }));
    render(<BrandLifecycle me={owner} />);
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findByRole("button", { name: pauseName });
    expect(within(panel).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "สถานะ (Pause / Resume)", keywordSection, "ข้อความหน้าเว็บ (Site text)", "โลโก้และไอคอน (Logo and favicon)", rollbackHeading, "เวอร์ชันเทมเพลต (Template version, Owner เท่านั้น)", abSummarySection, bucketsLabel, flowGateSection, "เส้นทางเงิน (Money-path, Owner เท่านั้น)",
    ]);
    for (const label of ["รหัส LeadsGate (LeadsGate aid)", "URL ฐาน prepop (Prepop base)", "ชื่อเส้นทางส่งยอดขาย", accountLabel, actionLabel, projectLabel]) expect(within(panel).getByRole("textbox", { name: label })).toBeDefined();
    expect(within(panel).getByText(/^บัญชี \(Account\) test-account/)).toBeDefined();
    expect(within(panel).getByText(/รหัสผลจากผู้ซื้อ \(postback token\):/)).toBeDefined();
    // Every button reads Thai first with the English term in parentheses.
    const thaiThenEnglish = /^[฀-๿][^()]*\([A-Za-z][^()]*\)/;
    for (const button of within(panel).getAllByRole("button")) expect(button.textContent, button.textContent ?? "").toMatch(thaiThenEnglish);
    fireEvent.click(within(panel).getByRole("button", { name: rotateName }));
    await answerConfirm(true);
    const modal = await screen.findByRole("dialog", { name: "รหัสผลจากผู้ซื้อ (postback token) ใหม่" });
    expect(within(modal).getByRole("heading", { name: "รหัสผลจากผู้ซื้อ (postback token) ใหม่" })).toBeDefined();
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

  // spec polish D6.1: the domain leads; the name follows in small muted text.
  it("a brand row shows the domain first and the name after it", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, name: "Level Lending" }];
    render(<BrandLifecycle me={employee} />);
    const item = await screen.findByRole("button", { name: /renderable\.test/ });
    expect(within(item).getByText("renderable.test").tagName).toBe("B");
    // The name sits under the domain in the same cell, in small type.
    const row = item.closest("tr")!;
    expect(within(row).getByText("Level Lending").tagName).toBe("SMALL");
  });

  it("the detail header shows the domain and no raw brand id", async () => {
    runtimeAvailable = false;
    lifecycleRows = [{ ...brand, name: "Level Lending" }];
    render(<BrandLifecycle me={employee} />);
    const header = await screen.findByRole("heading", { name: "renderable.test" });
    expect(header.textContent).toBe("renderable.test");
    const subtitle = header.nextElementSibling!;
    expect(subtitle.textContent).toContain("Level Lending");
    expect(subtitle.textContent).not.toContain("brand-a");
    expect(screen.queryByRole("heading", { name: "Level Lending" })).toBeNull();
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
    expect(await inAside().findByRole("button", { name: installName })).toHaveProperty("disabled", true);
    expect((await screen.findByRole("note")).textContent).toBe("ติดตั้งไม่ได้: แบรนด์นี้ยังไม่มี form artifact ที่ยืนยันแล้ว");
    expect(screen.queryByRole("button", { name: "ตั้งค่าแบรนด์" })).toBeNull();
  });

  describe("runtime sync cell after a redeploy", () => {
    const syncCell = () => screen.getByText("การซิงก์ runtime").nextElementSibling?.textContent;
    const redeployName = "ติดตั้งใหม่";
    const readyLabel = "พร้อมใช้งาน (ready)";
    const runningLabel = "กำลังทำงาน (running)";
    const syncErrorLabel = "ซิงก์ผิดพลาด (sync_error)";

    it("clears a sync_error label once the list reports ready, without reselecting the brand", async () => {
      lifecycleRows = [{ ...brand, runtime_sync_status: "sync_error" }];
      routes.set("POST /api/brands/brand-a/redeploy", () => {
        lifecycleRows = [{ ...brand, runtime_sync_status: "ready" }];
        return json({ install_id: "redeploy-1", brand_id: "brand-a", status: "running" }, 201);
      });
      detail({ ...failed, install_id: "redeploy-1", status: "ready", runtime_sync_status: "ready", receipts: [{ step: "sync_runtime", status: "ready" }] });
      render(<BrandLifecycle me={owner} />);
      await waitFor(() => expect(syncCell()).toBe(syncErrorLabel));
      fireEvent.click(await screen.findByRole("button", { name: redeployName }));
      await answerConfirm(true);
      await screen.findAllByText("redeploy-1", { selector: "code" });
      await waitFor(() => expect(syncCell()).toBe(readyLabel));
      expect(requests.filter((r) => r.method === "GET" && r.path === "/api/brands/brand-a/installs")).toHaveLength(1);
    });

    it("does not show ready while the install is still running and the list reloads with ready", async () => {
      routes.set("POST /api/brands/brand-a/redeploy", () => {
        lifecycleRows = [{ ...brand, runtime_sync_status: "ready", current_revision_id: "rev-2" }];
        return json({ install_id: "redeploy-1", brand_id: "brand-a", status: "running" }, 201);
      });
      detail({ ...failed, install_id: "redeploy-1", revision_id: "rev-2", status: "running", runtime_sync_status: "running" });
      render(<BrandLifecycle me={owner} />);
      fireEvent.click(await screen.findByRole("button", { name: redeployName }));
      await answerConfirm(true);
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
    fireEvent.click(await inAside().findByRole("button", { name: installName }));
    expect(await screen.findByText("failed-1", { selector: "code" })).toBeDefined();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Factory Worker binding is missing");
    fireEvent.click(await screen.findByRole("button", { name: retryName }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/installs/failed-1/retry")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: retryName })).toBeNull());
    expect(inAside().queryByRole("button", { name: installName })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "รีเฟรช" }));
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

  describe("install progress polling stops", () => {
    const reads = (installId: string) => requests.filter((r) => r.method === "GET" && r.path === `/api/installs/${installId}`).length;
    const running = { ...failed, install_id: "redeploy-9", status: "running" as const, runtime_sync_status: "running" as const };

    it.each(["ready", "failed", "rolled_back"] as const)("after a redeploy reaches %s", async (status) => {
      routes.set("POST /api/brands/brand-a/redeploy", () => json({ install_id: "redeploy-9", brand_id: "brand-a", status: "running" }, 201));
      detail(running);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await act(async () => { render(<BrandLifecycle me={owner} />); });
      fireEvent.click(await screen.findByRole("button", { name: "ติดตั้งใหม่" }));
      await answerConfirm(true);
      await screen.findAllByText("redeploy-9", { selector: "code" });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(reads("redeploy-9")).toBeGreaterThan(1);
      detail({ ...running, status, runtime_sync_status: status === "ready" ? "ready" : "failed" });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      const atTerminal = reads("redeploy-9");
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(reads("redeploy-9")).toBe(atTerminal);
    });

    it("never polls a terminal install recovered from history", async () => {
      history([{ ...failed, install_id: "done-1", status: "ready", error: null }]);
      detail({ ...failed, install_id: "done-1", status: "ready", runtime_sync_status: "ready" });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await act(async () => { render(<BrandLifecycle me={owner} />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(reads("done-1")).toBe(1);
    });

    it("never polls a terminal install from history whose detail read fails", async () => {
      history([{ ...failed, install_id: "done-2", status: "ready", error: null }]);
      routes.set("GET /api/installs/done-2", () => json({ error: "internal" }, 500));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await act(async () => { render(<BrandLifecycle me={owner} />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(400_000); });
      expect(reads("done-2")).toBe(1);
    });

    it("on unmount", async () => {
      history([{ ...running, error: null }]);
      detail(running);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const view = await act(async () => render(<BrandLifecycle me={owner} />));
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(reads("redeploy-9")).toBeGreaterThan(1);
      view.unmount();
      const atUnmount = reads("redeploy-9");
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(reads("redeploy-9")).toBe(atUnmount);
    });
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
    await inAside().findByRole("button", { name: installName });
    await act(async () => { release(json({ brand_id: "brand-a", installs: [{ ...failed, error: "stale failure" }] })); });
    expect(screen.queryByText("failed-1", { selector: "code" })).toBeNull();
    expect(screen.queryByText("stale failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "ตั้งค่าแบรนด์" })).toBeNull();
  });
});

describe("a confirm left open when the operator leaves the brand", () => {
  const newerForm = { form_artifact_id: "fa-2", bundle_form_version: "form@abcdef2" };
  const posts = () => requests.filter((r) => r.method === "POST");
  const otherBrand = () => LifecycleBrandSummary.parse({ ...brand, brand_id: "brand-b", hostnames: ["second.test"] });
  const accepted = () => json({ install_id: "op-a", brand_id: "brand-a", status: "running" }, 201);
  const recoverable = () => {
    lifecycleRows = [{ ...brand, status: "installing", current_revision_id: null, runtime_sync_status: "failed" }, otherBrand()];
    history([{ install_id: failed.install_id, status: "failed", error: "Compensation failed" }]);
    detail({ ...failed, recovery_required: true });
  };

  beforeEach(() => {
    lifecycleRows = [{ ...brand, newer_form: newerForm }, otherBrand()];
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    routes.set("POST /api/brands/brand-a/redeploy", accepted);
    routes.set("POST /api/brands/brand-a/rollback", accepted);
    routes.set("POST /api/brands/brand-a/recover", accepted);
    detail({ ...failed, install_id: "op-a", status: "running", runtime_sync_status: "running" });
  });

  it.each([
    ["redeploy", "ติดตั้งใหม่", false],
    ["redeploy with the latest form", "ติดตั้งใหม่พร้อมฟอร์มล่าสุด", false],
    ["rollback", rollbackName, false],
    ["recover", recoverName, true],
  ] as const)("closes the %s dialog on a route change and sends nothing for the old brand", async (_name, button, needsRecovery) => {
    if (needsRecovery) recoverable();
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand-a" />);
    fireEvent.click(await screen.findByRole("button", { name: button }));
    await screen.findByRole("alertdialog");
    view.rerender(<BrandLifecycle me={owner} routeBrandId="brand-b" />);
    expect(await screen.findByRole("heading", { name: "second.test" })).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts()).toHaveLength(0);
    expect(screen.queryByText("op-a", { selector: "code" })).toBeNull();
  });

  it("closes an open confirm when the wizard opens, and it does not come back when the wizard closes", async () => {
    routes.set("GET /api/templates", () => json({ templates: [] }));
    routes.set("GET /api/wizard/defaults", () => json({ amount_buckets: [100, 200, 300], form_route: "/request" }));
    const view = render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "ติดตั้งใหม่" }));
    await screen.findByRole("alertdialog");
    view.rerender(<BrandLifecycle me={owner} wizardRoute />);
    expect(await screen.findByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeDefined();
    view.rerender(<BrandLifecycle me={owner} wizardRoute={false} />);
    expect(await screen.findByRole("heading", { name: "แบรนด์" })).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});

describe("a click right after a brand is selected", () => {
  // No wait for the checklist request: the controls of a newly selected brand must keep what the first click does.
  it("keeps the Runtime config drawer opened by an immediate click", async () => {
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "ตั้งค่าแบรนด์" }));
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
    fireEvent.click(await inAside().findByRole("button", { name: installName }));
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
  fireEvent.click(await inAside().findByRole("button", { name: recoverName }));
  await answerConfirm(true);
  await waitFor(() => expect(requests.filter((r) => r.path === "/api/brands/brand-a/recover")).toHaveLength(1));
  await screen.findByText("recovery-1");
  await inAside().findByRole("button", { name: installName });
  expect(inAside().queryByRole("button", { name: recoverName })).toBeNull();
});

describe("funnel requests behind the brand table", () => {
  it("asks the funnel for 7 days and for 30 days, each for every brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("button", { name: /renderable\.test/ });
    await waitFor(() => expect(requests.filter((r) => r.path.startsWith("/api/funnel?"))).toHaveLength(2));
    const days = requests.filter((r) => r.path.startsWith("/api/funnel?")).map((r) => {
      const params = new URLSearchParams(r.path.split("?")[1]);
      expect(params.has("brand")).toBe(false);
      return Math.round((Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / 86_400_000);
    }).sort((a, b) => a - b);
    // The 7-day window may end a day after today, so it is at least 7 days. The stage dots read 30.
    expect(days[0]).toBeGreaterThanOrEqual(7);
    expect(days[1]).toBeGreaterThanOrEqual(30);
  });

  it("keeps the table and its stage dots when the funnel fails", async () => {
    routes.set("GET /api/funnel", () => json({ error: "bad_gateway" }, 502));
    render(<BrandLifecycle me={employee} />);
    const row = (await screen.findByRole("button", { name: /renderable\.test/ })).closest("tr")!;
    await waitFor(() => expect(row.querySelector('[data-col="leads"]')!.textContent).toBe("—"));
    expect(row.querySelectorAll(".stage-dot")).toHaveLength(7);
  });
});

describe("lifecycle detail header", () => {
  it("a brand without a hostname shows its name once in the detail header", () => {
    // The contract needs one hostname, so a hostname-less row is a cast: a factory-only draft can still arrive that way.
    const bare = { ...brand, hostnames: [], name: "Solo Draft" } as unknown as LifecycleBrandSummary;
    render(<LifecycleDetail me={owner} brand={bare} onInstall={() => {}} onRollback={() => {}} onRedeploy={() => {}} onRetry={() => {}} onRecover={() => {}} />);
    expect(screen.getByRole("heading", { name: "Solo Draft" })).toBeTruthy();
    expect(screen.getAllByText(/Solo Draft/)).toHaveLength(1);
  });
});

describe("checklist actions and the brand selection", { timeout: 15_000 }, () => {
  const gateOf = () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release }; };
  const second = () => LifecycleBrandSummary.parse({ ...brand, brand_id: "brand-b", hostnames: ["second.test"] });

  it("drops a checklist Retry read that finishes after another brand was selected", async () => {
    lifecycleRows = [structuredClone(brand), second()];
    history([{ ...failed, error: null }]);
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    const hold = gateOf();
    let reads = 0;
    routes.set("GET /api/installs/failed-1", async () => { reads += 1; if (reads > 1) await hold.gate; return json(failed); });
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "ลองติดตั้งใหม่" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "ลองติดตั้งใหม่" }));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /second\.test/ }));
    await screen.findByRole("heading", { name: "second.test" });
    await act(async () => { hold.release(); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps the open config and its typed input of another brand when a Test sold of the first brand finishes", { timeout: 15_000 }, async () => {
    lifecycleRows = [structuredClone(brand), second()];
    const configB = { ...structuredClone(config), brand_id: "brand-b", hostnames: ["second.test"] };
    routes.set("GET /api/brands", () => json({ brands: [config, configB].map((c) => ({ brand_id: c.brand_id, hostnames: c.hostnames, status: c.status, flow_gate_mode: c.flow_gate_mode, ab_config: c.ab_config, form_version: c.form_version, stats_7d: { leads: 0, sold: 0, pending: 0 } })), generated_at: "2026-10-06T00:00:00Z" }));
    routes.set("GET /api/brands/brand-b", () => json({ brand: configB }));
    routes.set("GET /api/brands/brand-b/site-text", () => json({ brand_id: "brand-b", defaults: null }));
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    routes.set("GET /api/brands/brand-b/revisions", () => json({ brand_id: "brand-b", current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
    routes.set("GET /api/brands/brand-b/assets", () => json({ brand_id: "brand-b", assets: [] }));
    routes.set("GET /api/brands/brand-b/edit", () => json({ brand_id: "brand-b", status: "live", template_version_id: "tv-1", microsoft_ads_account: null }));
    const hold = gateOf();
    routes.set("POST /api/brands/brand-a/checklist", async () => { await hold.gate; return json({ evidence: { brand_id: "brand-a", item: "test_sold", actor_id: "owner", verified_at: "2026-11-07T00:00:00Z" } }); });
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await enabledSoldButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("lead_id renderable.test"), { target: { value: "lead-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/brands/brand-a/checklist")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /second\.test/ }));
    await screen.findByRole("heading", { name: "second.test" });
    await openRuntimeConfig();
    const panel = await screen.findByRole("complementary", { name: configLabel });
    const keyword = (await within(panel).findByRole("heading", { name: keywordSection })).closest("section")!.querySelector("input")!;
    fireEvent.change(keyword, { target: { value: "typed not saved" } });
    const listReads = () => requests.filter((r) => r.path === "/api/lifecycle/brands").length;
    const before = listReads();
    await act(async () => { hold.release(); });
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    expect(screen.getByRole("complementary", { name: configLabel })).toBe(panel);
    expect((keyword as HTMLInputElement).value).toBe("typed not saved");
  });

  it("reads the first brand's checklist again after its Test sold, and the step turns done", async () => {
    let attested = false;
    routes.set("GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: attested ? [{ item: "test_sold", evidence: { brand_id: "brand-a", item: "test_sold", actor_id: "owner", verified_at: "2026-11-07T00:00:00Z" } }] : [] }));
    routes.set("POST /api/brands/brand-a/checklist", () => { attested = true; return json({}); });
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await enabledSoldButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("lead_id renderable.test"), { target: { value: "lead-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /test_sold/ }) as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByRole("button", { name: "ยืนยันการทดสอบการขาย" })).toBeNull();
  });

  it("turns the fix buttons off while an install runs", async () => {
    history([{ install_id: "running-1", status: "running", error: null }]);
    routes.set("GET /api/installs/running-1", () => json({ install_id: "running-1", brand_id: "brand-a", revision_id: "rev-1", status: "running", runtime_sync_status: "queued", receipts: [] }));
    render(<BrandLifecycle me={owner} />);
    const fix = await screen.findByRole("button", { name: "ยืนยันการทดสอบการขาย" });
    await waitFor(() => expect((fix as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("AdKit numbers on the brand detail", () => {
  const spendBody = (updatedAt: string) => ({
    period: "7d", from: "2026-10-01", to: "2026-10-07",
    totals: { cost_by_currency: { THB: 3500, USD: 0 }, clicks: 25, impressions: 100 },
    brands: [{ brand_id: "brand-a", currency: "THB", cost: 3500, clicks: 25, impressions: 100, updated_at: updatedAt, cost_usd: 100 }],
    total_cost_usd: 100, fx: { thbPerUsd: 35 },
  });
  const block = async () => screen.findByRole("region", { name: "ตัวเลขโฆษณา" });

  it("shows baht spend and USD profit for the owner when the sync is fresh", async () => {
    routes.set("GET /api/spend?period=7d", () => json(spendBody(new Date().toISOString())));
    render(<BrandLifecycle me={owner} />);
    const adkit = await block();
    await waitFor(() => expect(adkit.textContent).toContain("฿3,500"));
    // Revenue 0 in the funnel fixture minus 100 USD cost.
    expect(adkit.textContent).toContain("−$100");
  });

  it("marks the spend and the profit with ~ when the brand's spend row is an estimated share", async () => {
    const body = spendBody(new Date().toISOString());
    routes.set("GET /api/spend?period=7d", () => json({ ...body, brands: body.brands.map((row) => ({ ...row, allocation: "estimated" })) }));
    render(<BrandLifecycle me={owner} />);
    const adkit = await block();
    await waitFor(() => expect(adkit.textContent).toContain("~฿3,500"));
    expect(adkit.textContent).toContain("~−$100");
  });

  it("shows — for spend and profit when the sync is older than 2 hours", async () => {
    routes.set("GET /api/spend?period=7d", () => json(spendBody(new Date(Date.now() - 3 * 3_600_000).toISOString())));
    render(<BrandLifecycle me={owner} />);
    const adkit = await block();
    await waitFor(() => expect(requests.some((r) => r.path === "/api/spend?period=7d")).toBe(true));
    // The spend answer is committed before the assertion: a stale number would be on screen by now.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(adkit.textContent).not.toContain("฿");
    expect(adkit.textContent).not.toContain("$");
    // Spend, profit and the failed uploads (no conversions route in this harness, so that read fails) are all "—".
    expect(adkit.textContent?.match(/—/g)).toHaveLength(3);
  });

  it("turns a shown number into — once the clock passes 2 hours, with no other change on the screen", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
      routes.set("GET /api/spend?period=7d", () => json(spendBody("2026-11-07T11:30:00.000Z")));
      // Every checklist step is done and nothing is pending: this brand never re-renders on its own.
      const done = ["final_url", "leadsgate_postbacks", "test_sold", "drain_route"].map((item) => ({ item, evidence: { brand_id: "brand-a", item, actor_id: "system", verified_at: "2026-11-07T00:00:00Z" } }));
      routes.set("GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: done }));
      render(<BrandLifecycle me={owner} />);
      const adkit = await block();
      await waitFor(() => expect(adkit.textContent).toContain("฿3,500"));
      await act(async () => { await vi.advanceTimersByTimeAsync(3 * 3_600_000); });
      expect(adkit.textContent).not.toContain("฿");
      expect(adkit.textContent).not.toContain("$");
      expect(adkit.textContent?.match(/—/g)).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it("adds the leads, the failed uploads and when the numbers were updated", async () => {
    routes.set("GET /api/spend?period=7d", () => json({ ...spendBody("2026-11-07T04:30:00.000Z") }));
    routes.set("GET /api/conversions?period=7d&status=dead&brand=brand-a&limit=1000", () => json({ period: "7d", from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z", totals: { pending: 0, processing: 0, uploaded: 0, dead: 2 }, value_totals: null, stalled: 0, truncated: false, rows: [1, 2].map((n) => ({ lead_id: `lead-${n}`, brand: "brand-a", status: "dead", reason_code: null, last_error: null, click_type: null, attempts: 3, value: null, currency: "THB", occurred_at: "2026-10-02T00:00:00.000Z", created_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z", next_attempt_at: null })) }));
    render(<BrandLifecycle me={owner} />);
    const adkit = await block();
    const cell = (label: string) => within(adkit).getByText(label).nextElementSibling!.textContent;
    await waitFor(() => expect(cell("อัปโหลดไม่สำเร็จ")).toBe("2"));
    expect(cell("ลีด")).toMatch(/^\d+$/);
    expect(adkit.textContent).toContain("อัปเดตล่าสุด");
    // 04:30 UTC is 11:30 in Bangkok.
    expect(adkit.textContent).toContain("11:30");
  });

  it("shows … while a number loads and — when its source fails, never a 0", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    routes.set("GET /api/spend?period=7d", async () => { await gate; return json(spendBody(new Date().toISOString())); });
    render(<BrandLifecycle me={owner} />);
    const adkit = await block();
    const cell = (label: string) => within(adkit).getByText(label).nextElementSibling!.textContent;
    expect(cell("ค่าโฆษณา")).toBe("…");
    expect(cell("อัปโหลดไม่สำเร็จ")).not.toBe("0");
    release();
    await waitFor(() => expect(cell("ค่าโฆษณา")).toBe("฿3,500"));
    // The harness has no conversions route: that read failed, so the cell says "—".
    await waitFor(() => expect(cell("อัปโหลดไม่สำเร็จ")).toBe("—"));
  });

  it("shows the สถิติ section with the flow gate, clicks, cost per lead and the 7-day stats, and keeps cost per lead for the owner", async () => {
    routes.set("GET /api/spend?period=7d", () => json(spendBody(new Date().toISOString())));
    render(<BrandLifecycle me={owner} />);
    const stats = await screen.findByRole("region", { name: "สถิติ" });
    const cell = (label: string) => within(stats).getByText(label, { selector: "span.muted" }).nextElementSibling!.textContent;
    await waitFor(() => expect(cell("ต้นทุนต่อลีด")).not.toBe("…"));
    await waitFor(() => expect(cell("โฟลว์")).not.toBe("—"));
    expect(cell("คลิก")).toMatch(/^\d+$/);
    expect(within(stats).getByRole("group", { name: /สถิติ 7 วัน/ }).textContent).toMatch(/คลิก.*ลีด.*ขายได้.*รอผล/);
    cleanup();
    render(<BrandLifecycle me={employee} />);
    const mine = await screen.findByRole("region", { name: "สถิติ" });
    expect(within(mine).queryByText("ต้นทุนต่อลีด")).toBeNull();
    expect(within(mine).getByText("คลิก", { selector: "span.muted" })).toBeTruthy();
  });

  it("keeps the install, rollback, redeploy, recover, timeline, Final URL and runtime config actions inside the collapsed installation section", async () => {
    render(<BrandLifecycle me={owner} />);
    const details = await waitFor(() => { const el = document.querySelector<HTMLDetailsElement>(".brands-aside details.install-details"); if (!el) throw new Error("no section"); return el; });
    expect(details.open).toBe(false);
    const inside = within(details);
    for (const name of ["ติดตั้งใหม่", "ไทม์ไลน์", "เปิดเว็บไซต์", "คัดลอก Final URL", "ตั้งค่าแบรนด์"]) await waitFor(() => expect(inside.getAllByText(name, { selector: "button, a" }).length, name).toBeGreaterThan(0));
    // None of them is outside the section.
    const aside = document.querySelector(".brands-aside")!;
    for (const name of ["ย้อนกลับ", "ติดตั้งใหม่", "ไทม์ไลน์", "คัดลอก Final URL", "ตั้งค่าแบรนด์", "กู้คืน"]) {
      const outside = [...aside.querySelectorAll("button, a")].filter((el) => el.textContent === name && !details.contains(el));
      expect(outside, name).toHaveLength(0);
    }
  });

  it("has no block and no spend request for an employee", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("button", { name: "ยืนยันการทดสอบการขาย" });
    expect(screen.queryByRole("region", { name: "ตัวเลขโฆษณา" })).toBeNull();
    expect(requests.some((r) => r.path.startsWith("/api/spend"))).toBe(false);
  });
});

describe("checklist auto-refresh (FUS-385)", () => {
  const evidence = (item: string) => ({ brand_id: "brand-a", item, actor_id: "system", verified_at: "2026-10-26T00:00:00Z" });
  const allComputed = () => ["drain_route", "leadsgate_postbacks", "final_url"].map((item) => ({ item, evidence: evidence(item) }));
  const checklistReads = (brandId = "brand-a") => requests.filter((r) => r.path === `/api/brands/${brandId}/checklist`).length;
  const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
  afterEach(() => { Reflect.deleteProperty(document, "visibilityState"); vi.useRealTimers(); });

  it("refetches after 60 s while drain_route is open and checks the box from the second response", async () => {
    const responses = [[], [{ item: "drain_route", evidence: evidence("drain_route") }]];
    routes.set("GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: responses[Math.min(checklistReads() - 1, 1)] }));
    render(<BrandLifecycle me={owner} />);
    const box = await screen.findByRole("checkbox", { name: /drain_route/ });
    await waitFor(() => expect(checklistReads()).toBe(1));
    expect((box as HTMLInputElement).checked).toBe(false);
    await tick(59_000);
    expect(checklistReads()).toBe(1);
    await tick(1_000);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /drain_route/ }) as HTMLInputElement).checked).toBe(true));
    expect(checklistReads()).toBe(2);
  });

  it("does not poll once every computed item is present", async () => {
    routes.set("GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: allComputed() }));
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /final_url/ }) as HTMLInputElement).checked).toBe(true));
    const before = checklistReads();
    await tick(180_000);
    expect(checklistReads()).toBe(before);
  });

  it("stops polling the old brand after switching brand and after unmount", async () => {
    lifecycleRows = [structuredClone(brand), LifecycleBrandSummary.parse({ ...brand, brand_id: "brand-b", hostnames: ["second.test"] })];
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: allComputed() }));
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand-a" />);
    await screen.findByRole("heading", { name: "renderable.test" });
    await waitFor(() => expect(checklistReads()).toBe(1));
    view.rerender(<BrandLifecycle me={owner} routeBrandId="brand-b" />);
    await screen.findByRole("heading", { name: "second.test" });
    await waitFor(() => expect(checklistReads("brand-b")).toBe(1));
    await tick(180_000);
    expect(checklistReads("brand-a")).toBe(1);
    expect(checklistReads("brand-b")).toBe(1);
    view.rerender(<BrandLifecycle me={owner} routeBrandId="brand-a" />);
    await screen.findByRole("heading", { name: "renderable.test" });
    await waitFor(() => expect(checklistReads("brand-a")).toBe(2));
    view.unmount();
    await tick(180_000);
    expect(checklistReads("brand-a")).toBe(2);
  });

  it("does not refetch while the tab is hidden and resumes when it is visible", async () => {
    setVisibility("hidden");
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("checkbox", { name: /drain_route/ });
    await waitFor(() => expect(checklistReads()).toBe(1));
    await tick(180_000);
    expect(checklistReads()).toBe(1);
    setVisibility("visible");
    await tick(60_000);
    await waitFor(() => expect(checklistReads()).toBe(2));
  });

  const deferred = () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release }; };
  const boxChecked = (name: RegExp) => (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;

  it("stops requesting once a poll completes every computed item", async () => {
    let reads = 0;
    routes.set("GET /api/brands/brand-a/checklist", () => json({ brand_id: "brand-a", checklist: ++reads === 1 ? [] : allComputed() }));
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("button", { name: "ยืนยันการทดสอบการขาย" });
    await waitFor(() => expect(checklistReads()).toBe(1));
    await tick(60_000);
    await waitFor(() => expect(boxChecked(/final_url/)).toBe(true));
    const before = checklistReads();
    await tick(240_000);
    expect(checklistReads()).toBe(before);
  });

  it("ignores a stale poll for brand A that resolves after brand B loaded", async () => {
    lifecycleRows = [structuredClone(brand), LifecycleBrandSummary.parse({ ...brand, brand_id: "brand-b", hostnames: ["second.test"] })];
    routes.set("GET /api/brands/brand-b/installs", () => json({ brand_id: "brand-b", installs: [] }));
    routes.set("GET /api/brands/brand-b/checklist", () => json({ brand_id: "brand-b", checklist: [] }));
    const hold = deferred();
    routes.set("GET /api/brands/brand-a/checklist", async () => {
      if (checklistReads() < 2) return json({ brand_id: "brand-a", checklist: [] });
      await hold.gate;
      return json({ brand_id: "brand-a", checklist: allComputed() });
    });
    const view = render(<BrandLifecycle me={owner} routeBrandId="brand-a" />);
    await screen.findByRole("heading", { name: "renderable.test" });
    await waitFor(() => expect(checklistReads()).toBe(1));
    await tick(60_000);
    await waitFor(() => expect(checklistReads()).toBe(2));
    view.rerender(<BrandLifecycle me={owner} routeBrandId="brand-b" />);
    await screen.findByRole("heading", { name: "second.test" });
    await waitFor(() => expect(checklistReads("brand-b")).toBe(1));
    await act(async () => { hold.release(); });
    expect(boxChecked(/drain_route/)).toBe(false);
    expect(boxChecked(/final_url/)).toBe(false);
  });

  it("releases a poll response after unmount without error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hold = deferred();
    routes.set("GET /api/brands/brand-a/checklist", async () => {
      if (checklistReads() >= 2) await hold.gate;
      return json({ brand_id: "brand-a", checklist: [] });
    });
    const view = render(<BrandLifecycle me={owner} />);
    await screen.findByRole("checkbox", { name: /drain_route/ });
    await waitFor(() => expect(checklistReads()).toBe(1));
    await tick(60_000);
    await waitFor(() => expect(checklistReads()).toBe(2));
    view.unmount();
    await act(async () => { hold.release(); });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it.each([["refresh first", [0, 1]], ["poll first", [1, 0]]])("shows test_sold done when the action refresh and the 60 s poll are both in flight (%s)", { timeout: 15_000 }, async (_name, order) => {
    let attested = false;
    const holds: Array<ReturnType<typeof deferred>> = [];
    const sold = { item: "test_sold", evidence: { ...evidence("test_sold"), event_id: "ev-1" } };
    routes.set("GET /api/brands/brand-a/checklist", async () => {
      if (!attested || checklistReads() < 2) return json({ brand_id: "brand-a", checklist: [] });
      const hold = deferred();
      holds.push(hold);
      await hold.gate;
      return json({ brand_id: "brand-a", checklist: [sold] });
    });
    routes.set("POST /api/brands/brand-a/checklist", () => { attested = true; return json({}); });
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await enabledSoldButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("lead_id renderable.test"), { target: { value: "lead-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ยืนยัน" }));
    // waitFor polls with setInterval, which is faked here: step the clock by hand until the reads are in flight.
    const until = async (count: number) => { for (let i = 0; i < 100 && holds.length < count; i += 1) await tick(10); expect(holds).toHaveLength(count); };
    await until(1);
    await tick(60_000);
    await until(2);
    for (const index of order) await act(async () => { holds[index]!.release(); });
    await waitFor(() => expect(boxChecked(/test_sold/)).toBe(true));
  });

  it("keeps test_sold checked when a poll that began before the attest resolves after it", async () => {
    const hold = deferred();
    let attested = false;
    routes.set("GET /api/brands/brand-a/checklist", async () => {
      if (attested) return json({ brand_id: "brand-a", checklist: [...allComputed(), { item: "test_sold", evidence: { ...evidence("test_sold"), event_id: "ev-1" } }] });
      if (checklistReads() === 2) { await hold.gate; return json({ brand_id: "brand-a", checklist: allComputed() }); }
      return json({ brand_id: "brand-a", checklist: [] });
    });
    routes.set("POST /api/brands/brand-a/checklist", () => { attested = true; return json({ evidence: { ...evidence("test_sold"), event_id: "ev-1" } }); });
    render(<BrandLifecycle me={owner} />);
    const fix = await screen.findByRole("button", { name: "ยืนยันการทดสอบการขาย" });
    await waitFor(() => expect(checklistReads()).toBe(1));
    await tick(60_000);
    await waitFor(() => expect(checklistReads()).toBe(2));
    fireEvent.click(fix);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("renderable.test");
    fireEvent.change(within(dialog).getByLabelText("lead_id renderable.test"), { target: { value: "lead-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/api/brands/brand-a/checklist")).toBe(true));
    await waitFor(() => expect(boxChecked(/test_sold/)).toBe(true));
    await act(async () => { hold.release(); });
    expect(boxChecked(/test_sold/)).toBe(true);
  });
});
