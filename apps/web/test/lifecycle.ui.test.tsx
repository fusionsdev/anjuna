import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_NAME_PATTERN, LifecycleBrandSummary, type BrandConfig, type InstallWithReceipts } from "@anjuna/contracts";
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
const nameLabel = "ชื่อแบรนด์ (Brand name)";
const domainLabel = "โดเมน (Domain)";
const keywordLabel = "คีย์เวิร์ด (Keyword)";
const templateLabel = "เวอร์ชันเทมเพลต (Sealed template version)";
const createDraftName = "สร้างแบรนด์ (Create draft)";
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
    const select = screen.getByRole("combobox", { name: templateLabel });
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("textbox", { name: templateLabel })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: nameLabel }), { target: { value: "New Brand" } });
    fireEvent.change(screen.getByRole("textbox", { name: domainLabel }), { target: { value: "new-brand.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: keywordLabel }), { target: { value: "Quick Loan" } });
    expect((screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "tv-1" } });
    fireEvent.click(screen.getByRole("button", { name: createDraftName }));
    fireEvent.click(await screen.findByRole("button", { name: installName }));
    expect((await screen.findAllByText("new-install", { selector: "code" })).length).toBeGreaterThan(0);
    expect(requests.find((r) => r.path === "/api/brands/drafts")?.body).toEqual({ name: "New Brand", domain: "new-brand.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(requests.find((r) => r.path === "/api/brands/brand-a/install")?.body).toEqual({ revision_id: "rev-new" });
    expect(screen.queryByRole("button", { name: rollbackName })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Upgrade-all/ })).toBeNull();
  });

  it("offers exactly one create button and requires a brand name before submitting", async () => {
    routes.set("POST /api/brands/drafts", () => json({ brand: { brand_id: "brand-a" }, revision: { revision_id: "rev-new" } }, 201));
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    expect(screen.getAllByRole("button", { name: /Create draft/ })).toHaveLength(1);
    const create = screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement;
    const name = screen.getByRole("textbox", { name: nameLabel }) as HTMLInputElement;
    expect(name.required).toBe(true);
    expect(name.maxLength).toBe(60);
    expect(name.placeholder).toBe("Level Lending");
    fireEvent.change(screen.getByRole("textbox", { name: domainLabel }), { target: { value: "maple.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: keywordLabel }), { target: { value: "Quick Loan" } });
    fireEvent.change(screen.getByRole("combobox", { name: templateLabel }), { target: { value: "tv-1" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "   " } });
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "  Maple Cash  " } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(requests.find((r) => r.path === "/api/brands/drafts")?.body).toEqual({ name: "Maple Cash", domain: "maple.test", keyword_default: "Quick Loan", template_version_id: "tv-1" }));
    await waitFor(() => expect(name.value).toBe(""));
    expect(create.disabled).toBe(true);
  });

  it("blocks duplicate draft submissions and permits retry after failure", async () => {
    let finishDraft!: (response: Response) => void;
    routes.set("POST /api/brands/drafts", () => new Promise<Response>((resolve) => { finishDraft = resolve; }));
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    const brandName = screen.getByRole("textbox", { name: nameLabel });
    const domain = screen.getByRole("textbox", { name: domainLabel });
    const keyword = screen.getByRole("textbox", { name: keywordLabel });
    const select = screen.getByRole("combobox", { name: templateLabel });
    fireEvent.change(brandName, { target: { value: "Pending Brand" } });
    fireEvent.change(domain, { target: { value: "pending.test" } });
    fireEvent.change(keyword, { target: { value: "Quick Loan" } });
    fireEvent.change(select, { target: { value: "tv-1" } });
    const createButton = screen.getByRole("button", { name: createDraftName });
    fireEvent.click(createButton);

    expect(createButton).toHaveProperty("disabled", true);
    fireEvent.click(createButton);
    // Enter can submit a form without clicking the disabled button.
    fireEvent.submit(domain.closest("form")!);
    expect(requests.filter((request) => request.path === "/api/brands/drafts")).toHaveLength(1);

    await act(async () => { finishDraft(json({ error: "internal" }, 500)); });
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
    expect(brandName).toHaveProperty("value", "Pending Brand");
    expect(domain).toHaveProperty("value", "pending.test");
    expect(keyword).toHaveProperty("value", "Quick Loan");
    expect(select).toHaveProperty("value", "tv-1");
    routes.set("POST /api/brands/drafts", () => json({ error: "internal" }, 500));
    fireEvent.click(createButton);
    await waitFor(() => expect(requests.filter((request) => request.path === "/api/brands/drafts")).toHaveLength(2));
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
  });

  it("blocks draft creation when no sealed templates exist", async () => {
    routes.set("GET /api/templates/sealed", () => json({ templates: [] }));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/ยังไม่มี sealed template/);
    expect(screen.getByRole("combobox", { name: templateLabel }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports template load failure and recovers on Refresh", async () => {
    routes.set("GET /api/templates/sealed", () => json({ error: "internal" }, 500));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/โหลด sealed templates ไม่สำเร็จ/);
    expect((screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement).disabled).toBe(true);
    routes.set("GET /api/templates/sealed", () => json({ templates: [{ template_version_id: "tv-2", name: "Fresh", version: 2, status: "sealed" }] }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await screen.findByRole("option", { name: "Fresh · v2 (tv-2)" });
    expect(screen.queryByText(/โหลด sealed templates ไม่สำเร็จ/)).toBeNull();
  });

  it("hides Rollback from Employees on a live brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "renderable.test" });
    expect(screen.queryByRole("button", { name: rollbackName })).toBeNull();
  });

  it("rejects the entire template response if it includes an unsealed version", async () => {
    // SealedTemplatesResponse rejects the whole payload, rather than filtering
    // individual rows. Even the sealed row must not appear after this load error.
    routes.set("GET /api/templates/sealed", () => json({ templates: [
      { template_version_id: "tv-1", name: "Starter", version: 1, status: "sealed" },
      { template_version_id: "tv-draft", name: "Unapproved", version: 2, status: "draft" },
    ] }));
    render(<BrandLifecycle me={employee} />);
    await screen.findByText(/โหลด sealed templates ไม่สำเร็จ/);
    const select = screen.getByRole("combobox", { name: templateLabel });
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /Unapproved/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Starter/ })).toBeNull();
    expect((screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.some((request) => request.path === "/api/brands/drafts")).toBe(false);
  });

  it("clears a removed template selection on Refresh before allowing another draft", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    const select = screen.getByRole("combobox", { name: templateLabel });
    const create = screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole("textbox", { name: nameLabel }), { target: { value: "Refresh Brand" } });
    fireEvent.change(screen.getByRole("textbox", { name: domainLabel }), { target: { value: "refresh.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: keywordLabel }), { target: { value: "Quick Loan" } });
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
    fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findByRole("textbox");
    expect(within(panel).queryByRole("button", { name: pauseName })).toBeNull();
    expect(section(panel, keywordSection).getByRole("textbox")).toBeDefined();
    expect(within(panel).queryByRole("textbox", { name: bucketsLabel })).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: rotateName })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: rollbackName })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Rollback/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่ม Upgrade-all/ })).toBeNull();
  });

  it("labels every control in the config panel as Thai (English)", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    routes.set("PATCH /api/brands/brand-a", () => json({ brand: config, issued_postback_token: "tok_0123456789abcdef" }));
    render(<BrandLifecycle me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: /Runtime config/ }));
    const panel = await screen.findByRole("complementary", { name: configLabel });
    await within(panel).findByRole("button", { name: pauseName });
    expect(within(panel).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "สถานะ (Pause / Resume)", keywordSection, rollbackName, "น้ำหนัก A/B (A/B weights, รวมต้องเป็น 100%)", bucketsLabel, flowGateSection, "เส้นทางเงิน (Money-path, Owner เท่านั้น)",
    ]);
    for (const label of ["รหัส LeadsGate (LeadsGate aid)", "URL ฐาน prepop (Prepop base)", "คีย์ drain (Drain key)"]) expect(within(panel).getByRole("textbox", { name: label })).toBeDefined();
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

  it("validates the brand name on the client with the shared rule and keeps a short hint", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("option", { name: "Starter · v1 (tv-1)" });
    const name = screen.getByRole("textbox", { name: nameLabel }) as HTMLInputElement;
    const create = screen.getByRole("button", { name: createDraftName }) as HTMLButtonElement;
    fireEvent.change(screen.getByRole("textbox", { name: domainLabel }), { target: { value: "maple.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: keywordLabel }), { target: { value: "Quick Loan" } });
    fireEvent.change(screen.getByRole("combobox", { name: templateLabel }), { target: { value: "tv-1" } });
    expect(name.pattern).toBe(BRAND_NAME_PATTERN);
    expect(name.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(name.getAttribute("aria-describedby")!)!.textContent).toBe("ตัวอักษร ตัวเลข ช่องว่าง และ & . ' - ไม่เกิน 60 ตัว (Letters, digits, space, & . ' -, up to 60)");
    for (const bad of ["Lead_Cash", "x".repeat(61), "Anjuna Loans", "-Lead"]) {
      fireEvent.change(name, { target: { value: bad } });
      expect(create.disabled, bad).toBe(true);
      expect(name.getAttribute("aria-invalid"), bad).toBe("true");
    }
    expect(screen.getByRole("alert").textContent).toBe("ชื่อแบรนด์ไม่ถูกต้อง (Invalid brand name)");
    fireEvent.change(name, { target: { value: "Smith & Sons" } });
    expect(name.validity.patternMismatch).toBe(false);
    expect(name.getAttribute("aria-invalid")).toBe("false");
    expect(create.disabled).toBe(false);
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
    expect(screen.getByText("sync_runtime")).toBeDefined();
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
