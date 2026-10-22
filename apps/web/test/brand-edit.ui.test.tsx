import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { BRAND_ASSET_MAX_BYTES, brandInitialSvg } from "@anjuna/contracts";
import type { Me } from "../src/client/api";
import { ConfigPanel } from "../src/client/screens/ConfigPanel";

const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { ...owner, id: "employee", email: "emp1@example.test", role: "employee" };
const SHA = "a".repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TEMPLATES = [
  { template_version_id: "tv-1", name: "Harbor", version: 1, status: "sealed" },
  { template_version_id: "tv-2", name: "Copperline", version: 2, status: "sealed" },
];

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let calls: Array<{ method: string; path: string; body: unknown }>;
let microsoft: string | null;
let assets: Array<{ kind: string; content_type: string; byte_length: number; sha256: string; updated_at: string }>;

beforeEach(() => {
  microsoft = null;
  assets = [];
  calls = [];
  routes = new Map<string, Handler>([
    ["GET /api/brands/brand-a", () => json({ brand: brandFixture.brand })],
    ["GET /api/brands/brand-a/site-text", () => json({ brand_id: "brand-a", defaults: null })],
    ["GET /api/brands/brand-a/edit", () => json({ brand_id: "brand-a", status: "live", template_version_id: "tv-1", microsoft_ads_account: microsoft })],
    ["GET /api/templates/sealed", () => json({ templates: TEMPLATES })],
    ["GET /api/brands/brand-a/assets", () => json({ brand_id: "brand-a", assets })],
    ["POST /api/brands/brand-a/redeploy", () => json({ install_id: "ins_redeploy", brand_id: "brand-a", status: "running" }, 201)],
    ["POST /api/brands/brand-a/rollback", () => json({ install_id: "ins_rollback", brand_id: "brand-a", status: "running" }, 201)],
    ["PATCH /api/brands/brand-a/microsoft-ads", (init) => {
      microsoft = (JSON.parse(String(init!.body)) as { microsoft_ads_account: string | null }).microsoft_ads_account;
      return json({ brand_id: "brand-a", microsoft_ads_account: microsoft, changed: true });
    }],
  ]);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: input, body });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const panel = (me = owner, props: { brandName?: string; onOperationStarted?: (id: string) => void } = {}) =>
  render(<ConfigPanel me={me} brandId="brand-a" onClose={() => {}} onChanged={() => {}} {...props} />);
const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 3, name });
const within3 = async (name: string | RegExp) => within((await heading(name)).closest("section")!);

describe("rollback button", () => {
  it("no longer says it is coming with T10 and starts a rollback after a confirm", async () => {
    const started = vi.fn();
    const { container } = panel(owner, { onOperationStarted: started });
    const button = await screen.findByRole("button", { name: "ย้อนกลับเป็นเวอร์ชันก่อนหน้า (Rollback)" });
    expect(container.textContent).not.toMatch(/T10|coming|เร็ว ๆ นี้|placeholder/i);
    expect(document.body.textContent).not.toMatch(/T10|coming with|เร็ว ๆ นี้/i);
    fireEvent.click(button);
    await waitFor(() => expect(sent("POST", "/api/brands/brand-a/rollback")).toHaveLength(1));
    await waitFor(() => expect(started).toHaveBeenCalledWith("ins_rollback"));
    expect(await screen.findByText(/เริ่มย้อนกลับแล้ว/)).toBeTruthy();
  });

  it("does nothing when the Owner declines the confirm, and is hidden from an Employee", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "ย้อนกลับเป็นเวอร์ชันก่อนหน้า (Rollback)" }));
    expect(sent("POST", "/api/brands/brand-a/rollback")).toHaveLength(0);
    cleanup();
    panel(employee);
    await heading("ข้อความหน้าเว็บ (Site text)");
    expect(screen.queryByRole("button", { name: /Rollback/ })).toBeNull();
  });
});

describe("template version", () => {
  it("shows the running version, offers the other sealed versions and redeploys on the chosen one", async () => {
    const started = vi.fn();
    panel(owner, { onOperationStarted: started });
    const section = await within3(/เวอร์ชันเทมเพลต/);
    await waitFor(() => expect(section.getByText("Harbor v1")).toBeTruthy());
    const select = section.getByRole("combobox", { name: "เทมเพลตใหม่ (New template version)" }) as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["เลือกเทมเพลต… (Choose a template)", "Copperline v2"]);
    const change = section.getByRole("button", { name: /Change template and redeploy/ }) as HTMLButtonElement;
    expect(change.disabled).toBe(true);
    fireEvent.change(select, { target: { value: "tv-2" } });
    expect(change.disabled).toBe(false);
    fireEvent.click(change);
    await waitFor(() => expect(sent("POST", "/api/brands/brand-a/redeploy")).toHaveLength(1));
    expect(sent("POST", "/api/brands/brand-a/redeploy")[0]!.body).toEqual({ template_version_id: "tv-2" });
    expect(vi.mocked(window.confirm).mock.calls.at(-1)![0]).toContain("Copperline v2");
    await waitFor(() => expect(started).toHaveBeenCalledWith("ins_redeploy"));
  });

  it("sends nothing when the confirm is declined, keeps the choice, and shows a refused redeploy as a Thai message", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    panel();
    // The section remounts once the running version is known: query it fresh each time.
    const section = () => within(screen.getByRole("heading", { level: 3, name: /เวอร์ชันเทมเพลต/ }).closest("section")!);
    await waitFor(() => expect(section().getByText("Harbor v1")).toBeTruthy());
    fireEvent.change(section().getByRole("combobox"), { target: { value: "tv-2" } });
    fireEvent.click(section().getByRole("button", { name: /Change template and redeploy/ }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(sent("POST", "/api/brands/brand-a/redeploy")).toHaveLength(0);
    expect((section().getByRole("combobox") as unknown as HTMLSelectElement).value).toBe("tv-2");
    vi.stubGlobal("confirm", vi.fn(() => true));
    routes.set("POST /api/brands/brand-a/redeploy", () => json({ error: "lifecycle_operation_active", active_install_id: "ins_9" }, 409));
    // The button is busy until the declined confirm has settled.
    await waitFor(() => expect((section().getByRole("button", { name: /Change template and redeploy/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(section().getByRole("button", { name: /Change template and redeploy/ }));
    expect(await screen.findByText(/An install is already running/)).toBeTruthy();
    expect(sent("POST", "/api/brands/brand-a/redeploy")).toHaveLength(1);
    expect((section().getByRole("combobox") as unknown as HTMLSelectElement).value).toBe("tv-2");
  });

  it("is hidden from an Employee", async () => {
    panel(employee);
    await heading("ข้อความหน้าเว็บ (Site text)");
    expect(screen.queryByRole("heading", { name: /เวอร์ชันเทมเพลต/ })).toBeNull();
    expect(sent("GET", "/api/templates/sealed")).toHaveLength(0);
    expect(sent("GET", "/api/brands/brand-a/edit")).toHaveLength(0);
  });
});

describe("disclosures", () => {
  it("shows no APR, term, example or state field: the template carries its own disclosure text", async () => {
    panel();
    await heading(/เส้นทางเงิน/);
    expect(screen.queryByRole("textbox", { name: /APR|term|Representative example|Unsupported states/i })).toBeNull();
    expect(screen.queryByText(/Max APR|Representative example|Unsupported states/)).toBeNull();
  });
});

describe("Microsoft Ads account", () => {
  const field = async () => {
    const money = await within3(/เส้นทางเงิน/);
    return { money, input: money.getByRole("textbox", { name: "บัญชี Microsoft Ads (Microsoft Ads account)" }) as HTMLInputElement, save: money.getByRole("button", { name: /Save Microsoft Ads account/ }) as HTMLButtonElement };
  };

  it("loads the stored account, validates 6 to 12 digits and saves it to the profile route, not to core", async () => {
    microsoft = "123456";
    panel();
    const { input, save, money } = await field();
    await waitFor(() => expect(input.value).toBe("123456"));
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12ab" } });
    expect(save.disabled).toBe(true);
    expect(money.getByText(/6 to 12 digits/, { selector: ".error" })).toBeTruthy();
    fireEvent.change(input, { target: { value: " 987654321 " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(sent("PATCH", "/api/brands/brand-a/microsoft-ads")).toHaveLength(1));
    expect(sent("PATCH", "/api/brands/brand-a/microsoft-ads")[0]!.body).toEqual({ microsoft_ads_account: "987654321" });
    expect(sent("PATCH", "/api/brands/brand-a")).toHaveLength(0);
    await waitFor(() => expect(sent("GET", "/api/brands/brand-a/edit").length).toBeGreaterThan(1));
    await waitFor(async () => expect((await field()).input.value).toBe("987654321"));
  });

  it("clears the account with an empty field", async () => {
    microsoft = "123456";
    panel();
    const { input, save } = await field();
    await waitFor(() => expect(input.value).toBe("123456"));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(save);
    await waitFor(() => expect(sent("PATCH", "/api/brands/brand-a/microsoft-ads")[0]!.body).toEqual({ microsoft_ads_account: null }));
  });

  it("is read-only when the stored value could not be read, and not shown to an Employee", async () => {
    routes.set("GET /api/brands/brand-a/edit", () => json({ error: "not_found" }, 404));
    panel();
    const { input, save } = await field();
    await waitFor(() => expect(input.disabled).toBe(true));
    expect(save.disabled).toBe(true);
    cleanup();
    panel(employee);
    await heading("ข้อความหน้าเว็บ (Site text)");
    expect(screen.queryByRole("textbox", { name: /Microsoft Ads/ })).toBeNull();
  });
});

describe("logo and favicon", () => {
  const section = () => within3("โลโก้และไอคอน (Logo and favicon)");
  const png = (size = 12, name = "logo.png") => { const bytes = new Uint8Array(size); bytes.set([0x89, 0x50, 0x4e, 0x47]); return new File([bytes], name, { type: "image/png" }); };
  const choose = (input: HTMLElement, file: File) => fireEvent.change(input, { target: { files: [file] } });

  it("shows the generated first-letter icon until a file is uploaded, for an Employee too", async () => {
    panel(employee, { brandName: "Harbor Cash" });
    const s = await section();
    const preview = await s.findByRole("img", { name: "ตัวอย่าง โลโก้ (Logo)" });
    expect(decodeURIComponent(preview.getAttribute("src")!)).toContain(brandInitialSvg("Harbor Cash"));
    expect(s.getAllByText(/Not uploaded/)).toHaveLength(2);
    expect(s.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("uploads the chosen file as multipart to the kind's route and shows it from then on", async () => {
    routes.set("PUT /api/brands/brand-a/assets/logo", () => {
      assets = [{ kind: "logo", content_type: "image/png", byte_length: 2048, sha256: SHA, updated_at: "2026-10-22T01:02:03.000Z" }];
      return json({ asset: assets[0] });
    });
    panel();
    const s = await section();
    choose(await s.findByLabelText("ไฟล์ โลโก้ (Logo) (logo file)"), png());
    await waitFor(() => expect(sent("PUT", "/api/brands/brand-a/assets/logo")).toHaveLength(1));
    const form = sent("PUT", "/api/brands/brand-a/assets/logo")[0]!.body as FormData;
    expect((form.get("file") as File).name).toBe("logo.png");
    expect(await s.findByText("image/png · 2 KB · 2026-10-22")).toBeTruthy();
    expect(s.getByRole("img", { name: "ตัวอย่าง โลโก้ (Logo)" }).getAttribute("src")).toBe(`/api/brands/brand-a/assets/logo?v=${SHA}`);
    expect(s.getByText(/Uploaded, live within about a minute/)).toBeTruthy();
  });

  it("refuses a file above the cap before sending it", async () => {
    panel();
    const s = await section();
    choose(await s.findByLabelText("ไฟล์ ไอคอนแท็บ (Favicon) (favicon file)"), png(BRAND_ASSET_MAX_BYTES.favicon + 1));
    expect(await s.findByText(/ไฟล์ใหญ่เกิน 64 KB/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows why the server refused the bytes, in Thai and English", async () => {
    routes.set("PUT /api/brands/brand-a/assets/logo", () => json({ error: "invalid_asset", code: "brand_clean", message: "The file contains a platform or other-brand identifier." }, 422));
    panel();
    const s = await section();
    choose(await s.findByLabelText("ไฟล์ โลโก้ (Logo) (logo file)"), png());
    expect(await s.findByText(/ชื่อแพลตฟอร์ม หรือชื่อ\/โดเมนของแบรนด์อื่น/)).toBeTruthy();
    expect(sent("GET", "/api/brands/brand-a/assets")).toHaveLength(1);
  });

  it("removes a stored file after a confirm", async () => {
    assets = [{ kind: "favicon", content_type: "image/x-icon", byte_length: 1024, sha256: SHA, updated_at: "2026-10-22T01:02:03.000Z" }];
    routes.set("DELETE /api/brands/brand-a/assets/favicon", () => { assets = []; return json({ brand_id: "brand-a", kind: "favicon", removed: true }); });
    panel(employee);
    const s = await section();
    fireEvent.click(await s.findByRole("button", { name: /Remove\) ไอคอนแท็บ/ }));
    await waitFor(() => expect(sent("DELETE", "/api/brands/brand-a/assets/favicon")).toHaveLength(1));
    await waitFor(() => expect(s.queryByRole("button", { name: /Remove/ })).toBeNull());
  });
});
