import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandWizard } from "../src/client/screens/BrandWizard";
import { ADKIT_POLL } from "../src/client/wizard/StepPanels";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const NOW = new Date().toISOString();
const CONTACT = { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" };
const TEMPLATE = {
  template_version_id: "tv-1", template_id: "tpl-tv-1", name: "Harbor", version: 1, status: "approved", submitted_by_label: "Somchai",
  created_at: NOW, sealed_at: NOW, thumbnail_url: null, brands_using: 0,
};
const PROJECTS = { items: [{ id: "proj_a", name: "Project A", currency: null, updated_at: NOW }, { id: "proj_b", name: "Project B", currency: null, updated_at: NOW }], synced_at: NOW };
const ACCOUNTS = { items: [{ id: "1234567890", name: "Main account", currency: "THB", updated_at: NOW }, { id: "2222222222", name: "Second account", currency: "USD", updated_at: NOW }], synced_at: NOW };
/** The key the wizard sends for draft brand_new, project proj_a and the given account. */
const KEY_A = "conversion_action.create:brand_new:r:proj_a:1234567890";
const KEY_B = "conversion_action.create:brand_new:r:proj_a:2222222222";
const EMPTY = { items: [], synced_at: null };

let held: { profile: Record<string, unknown> };
const draftBody = () => ({
  brand: { brand_id: "brand_new", name: "Maple Cash", domain: "maple.test", keyword_default: "Quick Loan", status: "draft" },
  revision: { revision_id: "brand_new_rev_1", revision: 1, template_version_id: "tv-1", form_artifact_id: "fa-1" },
  profile: held.profile,
});
const job = (status: "queued" | "claimed" | "done" | "failed", key = KEY_A, result: object | null = null, account = "1234567890") => ({
  created: status === "queued",
  job: {
    id: "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f", kind: "conversion_action.create", status,
    payload: { brand_draft_id: "brand_new", account, project: "proj_a", name: "cv-0123456789abcdef" },
    result, attempts: status === "queued" ? 0 : 1, idempotency_key: key, requested_by: "owner",
    next_attempt_at: null, created_at: NOW, updated_at: NOW,
  },
});

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path);
const patches = () => sent("PATCH", "/api/brands/brand_new/draft");
const jobPosts = () => sent("POST", "/api/v1/adkit/conversion-actions");

beforeEach(() => {
  ADKIT_POLL.ms = 20;
  held = { profile: { contact: CONTACT, copy: {} } };
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates", () => json({ templates: [TEMPLATE] })],
    ["GET /api/templates/tv-1", () => json({ template: { ...TEMPLATE, sha256: "a".repeat(64), sealed_by: "owner", text_defaults: null, theme_vars: null }, checks: [], screenshots: { desktop: null, mobile: null } })],
    ["GET /api/wizard/defaults", () => json({ amount_buckets: [100, 200], form_route: "/request" })],
    ["POST /api/wizard/zone-check", () => json({ zone_active: true, zone_name: "maple.test", nameservers: [], conflicting_records: [] })],
    ["GET /api/wizard/drafts/brand_new", () => json(draftBody())],
    ["PATCH /api/brands/brand_new/draft", (init) => {
      const body = JSON.parse(String(init?.body)) as { profile?: Record<string, unknown> };
      if (body.profile) held = { profile: body.profile };
      return json({ ...draftBody(), changed: [] });
    }],
    ["GET /api/v1/adkit/projects", () => json(PROJECTS)],
    ["GET /api/v1/adkit/projects/proj_a/accounts", () => json(ACCOUNTS)],
    ["GET /api/v1/adkit/projects/proj_b/accounts", () => json(EMPTY)],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.assign(ADKIT_POLL, { ms: 5000, backoffMaxMs: 60_000, maxMs: 30 * 60_000 }); });

const atTracking = async (me: typeof owner | typeof employee = owner) => {
  render(<BrandWizard me={me} brandId="brand_new" initialStep={3} onClose={vi.fn()} onGenerated={vi.fn()} />);
  await screen.findByRole("heading", { level: 2, name: "ติดตามผล (Tracking)" });
};
const select = (name: string) => screen.getByRole("combobox", { name }) as unknown as HTMLSelectElement;
const choose = (name: string, value: string) => fireEvent.change(select(name), { target: { value } });
const options = (name: string) => [...select(name).options].map((o) => [o.value, o.textContent]);
const next = () => fireEvent.click(screen.getByRole("button", { name: "ถัดไป (Next)" }));
const createButton = () => screen.getByRole("button", { name: "สร้าง conversion action" });

describe("wizard step 4 from the AdKit directory", () => {
  it("renders the project and account as selects from the directory, with no text input and no Microsoft Ads field", async () => {
    await atTracking();
    await waitFor(() => expect(options("โปรเจกต์ AdKit")).toEqual([["", "เลือกโปรเจกต์"], ["proj_a", "Project A"], ["proj_b", "Project B"]]));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByText(/Microsoft/)).toBeNull();
    expect(select("บัญชี Google Ads").disabled).toBe(true);

    choose("โปรเจกต์ AdKit", "proj_a");
    await waitFor(() => expect(options("บัญชี Google Ads")).toEqual([["", "เลือกบัญชี"], ["1234567890", "Main account · 1234567890 · THB"], ["2222222222", "Second account · 2222222222 · USD"]]));
    choose("บัญชี Google Ads", "1234567890");
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("—");
    next();
    await screen.findByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" });
    expect(patches().at(-1)!.body).toEqual({ profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } });
    expect(screen.queryByText(/Microsoft/)).toBeNull();
  });

  it("creates the conversion action with a job and shows queued, claimed and done", async () => {
    const answers = [job("queued"), job("claimed"), job("done", undefined, { conversion_action_id: "7300000001", name: "cv-0123456789abcdef", adopted: false })];
    let stage = 0;
    routes.set("POST /api/v1/adkit/conversion-actions", () => json(answers[stage], 201));
    await atTracking();
    await waitFor(() => expect(options("โปรเจกต์ AdKit")).toHaveLength(3));
    expect(createButton().hasAttribute("disabled")).toBe(true);
    choose("โปรเจกต์ AdKit", "proj_a");
    await waitFor(() => expect(options("บัญชี Google Ads")).toHaveLength(3));
    choose("บัญชี Google Ads", "1234567890");
    fireEvent.click(createButton());

    // The account is saved to the draft first: the job reads it from there.
    await waitFor(() => expect(jobPosts()).toHaveLength(1));
    expect(patches()).toHaveLength(1);
    expect((patches()[0]!.body.profile as { ads: object }).ads).toEqual({ google_ads_account: "1234567890", adkit_project: "proj_a" });
    expect(jobPosts()[0]!.body).toEqual({ brand_draft_id: "brand_new", idempotency_key: KEY_A });
    expect(await screen.findByText("รอคิว")).toBeTruthy();
    stage = 1;
    expect(await screen.findByText("กำลังสร้าง")).toBeTruthy();
    stage = 2;
    expect(await screen.findByText("สร้างแล้ว")).toBeTruthy();
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("7300000001");
    // Polling repeats the same idempotent request and stops at done.
    expect(jobPosts().every((p) => JSON.stringify(p.body) === JSON.stringify({ brand_draft_id: "brand_new", idempotency_key: KEY_A }))).toBe(true);
    const polls = jobPosts().length;
    await new Promise((r) => setTimeout(r, 80));
    expect(jobPosts()).toHaveLength(polls);

    next();
    await screen.findByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" });
    expect((patches().at(-1)!.body.profile as { ads: object }).ads).toEqual({ google_ads_account: "1234567890", google_conversion_action: "7300000001", adkit_project: "proj_a" });
  });

  it("shows a failed job with its error and retries with a new idempotency key", async () => {
    routes.set("POST /api/v1/adkit/conversion-actions", (init) => {
      const body = JSON.parse(String(init?.body)) as { idempotency_key?: string };
      return body.idempotency_key?.includes(":retry-") ? json(job("queued", body.idempotency_key), 201) : json(job("failed", undefined, { error: "duplicate name" }));
    });
    held = { profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } };
    await atTracking();
    await waitFor(() => expect(options("บัญชี Google Ads")).toHaveLength(3));
    expect(select("บัญชี Google Ads").value).toBe("1234567890");
    fireEvent.click(createButton());
    expect(await screen.findByText("สร้างไม่สำเร็จ: duplicate name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ลองสร้างใหม่" }));
    expect(await screen.findByText("รอคิว")).toBeTruthy();
    const key = jobPosts().at(-1)!.body.idempotency_key as string;
    expect(key).toMatch(/^conversion_action\.create:brand_new:r:proj_a:1234567890:retry-[0-9a-z]+$/);
  });

  it("gives a new account its own job and never applies the old account's action id", async () => {
    const done = { conversion_action_id: "7300000001", name: "cv-0123456789abcdef", adopted: false };
    let holdB: ((r: Response) => void) | null = null;
    routes.set("POST /api/v1/adkit/conversion-actions", (init) => {
      const body = JSON.parse(String(init?.body)) as { idempotency_key: string };
      if (body.idempotency_key === KEY_A) return json(job("done", KEY_A, done));
      // B's first answer is held, so the test can switch back to A while it is in flight.
      return new Promise<Response>((resolve) => { holdB = resolve; });
    });
    held = { profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } };
    await atTracking();
    await waitFor(() => expect(options("บัญชี Google Ads")).toHaveLength(3));
    fireEvent.click(createButton());
    expect(await screen.findByText("สร้างแล้ว")).toBeTruthy();
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("7300000001");

    choose("บัญชี Google Ads", "2222222222");
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("—");
    expect(createButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(createButton());
    await waitFor(() => expect(jobPosts()).toHaveLength(2));
    expect(jobPosts()[1]!.body).toEqual({ brand_draft_id: "brand_new", idempotency_key: KEY_B });
    expect((patches().at(-1)!.body.profile as { ads: object }).ads).toEqual({ google_ads_account: "2222222222", adkit_project: "proj_a" });

    // An answer for A that lands while B is on screen is dropped.
    // The dropped answer keeps no key and starts no polling, even with a short poll interval.
    ADKIT_POLL.ms = 5;
    holdB!(json(job("queued", KEY_B, null, "1234567890")));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("—");
    expect(screen.queryByText("สร้างแล้ว")).toBeNull();
    expect(screen.queryByText("รอคิว")).toBeNull();
    expect(jobPosts()).toHaveLength(2);
    next();
    await screen.findByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" });
    expect((patches().at(-1)!.body.profile as { ads: object }).ads).toEqual({ google_ads_account: "2222222222", adkit_project: "proj_a" });
  });

  it("keeps polling after a failed read with a backoff, and shows a note meanwhile", async () => {
    let reads = 0;
    routes.set("POST /api/v1/adkit/conversion-actions", () => {
      reads += 1;
      if (reads === 1) return json(job("queued"), 201);
      if (reads === 2) return json({ error: "core_unavailable" }, 502);
      return json(job("done", KEY_A, { conversion_action_id: "7300000009", name: "cv-0123456789abcdef", adopted: false }));
    });
    held = { profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } };
    await atTracking();
    await waitFor(() => expect(options("บัญชี Google Ads")).toHaveLength(3));
    fireEvent.click(createButton());
    expect(await screen.findByText("ตรวจสถานะงานไม่สำเร็จ จะลองใหม่อัตโนมัติ")).toBeTruthy();
    expect(await screen.findByText("สร้างแล้ว")).toBeTruthy();
    expect(screen.queryByText("ตรวจสถานะงานไม่สำเร็จ จะลองใหม่อัตโนมัติ")).toBeNull();
    expect(screen.getByText("conversion action:").parentElement!.textContent).toContain("7300000009");
  });

  it("stops polling after the cap with a Thai message, and Check again resumes", async () => {
    ADKIT_POLL.maxMs = 60;
    let finish = false;
    routes.set("POST /api/v1/adkit/conversion-actions", () => json(finish ? job("done", KEY_A, { conversion_action_id: "7300000002", name: "cv-0123456789abcdef", adopted: false }) : job("queued"), 201));
    held = { profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } };
    await atTracking();
    await waitFor(() => expect(options("บัญชี Google Ads")).toHaveLength(3));
    fireEvent.click(createButton());
    expect(await screen.findByText("หยุดตรวจสถานะแล้ว งานรอนานเกิน 30 นาที")).toBeTruthy();
    const polls = jobPosts().length;
    await new Promise((r) => setTimeout(r, 80));
    expect(jobPosts()).toHaveLength(polls);
    finish = true;
    fireEvent.click(screen.getByRole("button", { name: "ตรวจสถานะอีกครั้ง" }));
    expect(await screen.findByText("สร้างแล้ว")).toBeTruthy();
    expect(screen.queryByText("หยุดตรวจสถานะแล้ว งานรอนานเกิน 30 นาที")).toBeNull();
  });

  it("keeps the key within the 160-character contract for a 64-character project id", async () => {
    const { conversionJobKey } = await import("../src/client/wizard/StepPanels");
    const long = await conversionJobKey("b".repeat(64), "p".repeat(64), "1234567890");
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toMatch(/^conversion_action\.create:b{64}:h:[0-9a-f]{32}:1234567890$/);
    expect(long).toMatch(/^[A-Za-z0-9:._-]{8,160}$/);
    expect(await conversionJobKey("brand_new", "", "1234567890")).toBe("conversion_action.create:brand_new:none:1234567890");
    expect(await conversionJobKey("brand_new", "none", "1234567890")).toBe("conversion_action.create:brand_new:r:none:1234567890");
  });

  it("gives different keys to projects that collided under the old 32-bit hash", async () => {
    const { conversionJobKey } = await import("../src/client/wizard/StepPanels");
    const draft = "b".repeat(64);
    // The old key put a long project as p<fnv1a> next to raw ids: "p".repeat(64) hashed to 5fe86ac5.
    const hashed = await conversionJobKey(draft, "p".repeat(64), "1234567890");
    const literal = await conversionJobKey(draft, "p5fe86ac5", "1234567890");
    expect(literal).toBe(`conversion_action.create:${draft}:r:p5fe86ac5:1234567890`);
    expect(hashed).not.toBe(literal);
    // Both of these hash to c3172bd0 with FNV-1a 32-bit.
    const pad = "proj_" + "x".repeat(60);
    const a = await conversionJobKey(draft, `${pad}_6s7`, "1234567890");
    const b = await conversionJobKey(draft, `${pad}_1o80`, "1234567890");
    expect(a).toMatch(/:h:[0-9a-f]{32}:1234567890$/);
    expect(b).toMatch(/:h:[0-9a-f]{32}:1234567890$/);
    expect(a).not.toBe(b);
    // A project with a colon is hashed, so it cannot pose as another segment.
    expect(await conversionJobKey("brand_new", "x:h:abc", "1234567890")).toMatch(/^conversion_action\.create:brand_new:h:[0-9a-f]{32}:1234567890$/);
  });

  it("shows — and a note when the directory is stale or empty, and keeps the select off", async () => {
    routes.set("GET /api/v1/adkit/projects", () => json(EMPTY));
    await atTracking();
    expect(await screen.findByText("ยังไม่มีข้อมูลจาก AdKit หรือข้อมูลเก่ากว่า 2 ชั่วโมง")).toBeTruthy();
    expect(select("โปรเจกต์ AdKit").disabled).toBe(true);
    expect(options("โปรเจกต์ AdKit")).toEqual([["", "—"]]);
  });

  it("keeps a saved project that is not in the directory as its own option", async () => {
    held = { profile: { contact: CONTACT, copy: {}, ads: { adkit_project: "legacy-proj" } } };
    routes.set("GET /api/v1/adkit/projects/legacy-proj/accounts", () => json(EMPTY));
    await atTracking();
    await waitFor(() => expect(options("โปรเจกต์ AdKit")).toContainEqual(["legacy-proj", "legacy-proj · ไม่อยู่ในรายการล่าสุด"]));
    expect(select("โปรเจกต์ AdKit").value).toBe("legacy-proj");
  });

  it("shows the step read-only to an employee and asks AdKit nothing", async () => {
    held = { profile: { contact: CONTACT, copy: {}, ads: { google_ads_account: "1234567890", adkit_project: "proj_a" } } };
    await atTracking(employee);
    expect(screen.getByRole("note").textContent).toBe("Owner กำหนดค่านี้ · แสดงอย่างเดียว");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByText("1234567890")).toBeTruthy();
    expect(requests.some((r) => r.path.startsWith("/api/v1/adkit"))).toBe(false);
    next();
    await screen.findByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" });
    expect(patches()).toHaveLength(0);
  });
});
