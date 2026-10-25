import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { BrandWizard } from "../src/client/screens/BrandWizard";
import { TemplatePanel } from "../src/client/wizard/StepPanels";
import { PANEL_ROLE_TABLE } from "../src/server/panel-roles";
import type { Me } from "../src/client/api";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const NOW = "2026-10-22T00:00:00.000Z";
const CONTACT = { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" };
/** What a draft saved before FUS-366 holds. The wizard no longer writes or shows it, and keeps it when it saves. */
const OLD_DISCLOSURES = { term_min_months: 3, term_max_months: 36, apr_max: 35.99, representative_example: "A 12 month loan of $1,000 at 29.99% APR costs about $96 a month.", unsupported_states: ["NY", "AR", "VT", "WV"] };
const ADS = { google_ads_account: "1234567890", google_conversion_action: "555", adkit_project: "maple-ads", microsoft_ads_account: "654321" };
const summary = (id: string, name: string, status: string, extra: object = {}) => ({
  template_version_id: id, template_id: `tpl-${id}`, name, version: 1, status, submitted_by_label: "Somchai", created_at: NOW, sealed_at: NOW,
  thumbnail_url: `/api/templates/${id}/screenshots/desktop`, brands_using: 3, ...extra,
});
const TEMPLATES = [summary("tv-1", "Harbor", "approved"), summary("tv-2", "Copperline", "approved", { thumbnail_url: null, brands_using: 0 }), summary("tv-3", "Unapproved", "awaiting_approval")];
const detail = (id: string) => ({
  template: { ...summary(id, "Harbor", "approved"), sha256: "a".repeat(64), sealed_by: "owner", text_defaults: { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Check your funding options." }, theme_vars: null },
  checks: [], screenshots: { desktop: null, mobile: null },
});
const draftBody = (over: { profile?: object; template?: string; status?: string; name?: string } = {}) => ({
  brand: { brand_id: "brand_new", name: over.name ?? "Maple Cash", domain: "maple.test", keyword_default: "Quick Loan", status: over.status ?? "draft" },
  revision: { revision_id: "brand_new_rev_1", revision: 1, template_version_id: over.template ?? "tv-1", form_artifact_id: "fa-1" },
  ...(over.profile ? { profile: over.profile } : {}),
});
/** What the server holds for the draft: PATCH merges into it and every read returns it, as the real routes do. */
let held: { profile?: object; template: string; name: string };
const hold = (profile?: object, template = "tv-1") => { held = { ...(profile ? { profile } : {}), template, name: "Maple Cash" }; };
const heldBody = () => draftBody({ profile: held.profile, template: held.template, name: held.name });
const ACTIVE_ZONE = { zone_active: true, zone_name: "maple.test", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], conflicting_records: [] };

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path);

beforeEach(() => {
  hold();
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates", () => json({ templates: TEMPLATES })],
    ["GET /api/templates/tv-1", () => json(detail("tv-1"))],
    ["GET /api/templates/tv-2", () => json(detail("tv-2"))],
    ["GET /api/wizard/defaults", () => json({ amount_buckets: [100, 200, 300], form_route: "/request" })],
    ["POST /api/wizard/zone-check", () => json(ACTIVE_ZONE)],
    ["POST /api/brands/drafts", (init) => {
      const body = JSON.parse(String(init?.body)) as { profile?: object; template_version_id: string; name: string };
      held = { ...(body.profile ? { profile: body.profile } : {}), template: body.template_version_id, name: body.name };
      return json(heldBody(), 201);
    }],
    ["PATCH /api/brands/brand_new/draft", (init) => {
      const body = JSON.parse(String(init?.body)) as { profile?: object; template_version_id?: string; name?: string };
      held = { ...held, ...(body.profile ? { profile: body.profile } : {}), ...(body.template_version_id ? { template: body.template_version_id } : {}), ...(body.name ? { name: body.name } : {}) };
      return json({ ...heldBody(), changed: [] });
    }],
    ["GET /api/wizard/drafts/brand_new", () => json(heldBody())],
    ["POST /api/brands/brand_new/generate", () => json({ install_id: "ins_1", brand_id: "brand_new", status: "running" }, 201)],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const text = (name: string | RegExp) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const fill = (name: string | RegExp, value: string) => fireEvent.change(text(name), { target: { value } });
const next = () => fireEvent.click(screen.getByRole("button", { name: "ถัดไป (Next)" }));
const back = () => fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ (Back)" }));
const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const patches = () => sent("PATCH", "/api/brands/brand_new/draft");

function setup(me: Me = employee, props: { brandId?: string; initialStep?: number } = {}) {
  const onClose = vi.fn();
  const onGenerated = vi.fn();
  render(<BrandWizard me={me} onClose={onClose} onGenerated={onGenerated} {...props} />);
  return { onClose, onGenerated };
}
async function fillBrand() {
  await screen.findByRole("textbox", { name: "ชื่อแบรนด์ (Brand name)" });
  fill("ชื่อแบรนด์ (Brand name)", "Maple Cash");
  fill("โดเมน (Domain)", "Maple.Test");
  fill("คีย์เวิร์ด (Keyword)", "quick loan");
  fill("โทรศัพท์ (Phone)", CONTACT.phone);
  fill("ที่อยู่ (Address)", CONTACT.address);
  fill("อีเมล (Email)", CONTACT.email);
}

describe("per-step validation", () => {
  it("blocks Next on an empty Brand step with a Thai and English error per field and sends nothing", async () => {
    setup();
    await screen.findByRole("textbox", { name: "ชื่อแบรนด์ (Brand name)" });
    next();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(expect.arrayContaining([
      "ชื่อแบรนด์ (Brand name): จำเป็นต้องกรอก (Required)", "โดเมน (Domain): จำเป็นต้องกรอก (Required)", "อีเมล (Email): จำเป็นต้องกรอก (Required)",
    ]));
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "แบรนด์ (Brand)" })).toBeTruthy();
  });

  it("clears a field's error when it is edited and refuses a www domain with a short message", async () => {
    setup();
    await fillBrand();
    fill("โดเมน (Domain)", "www.maple.test");
    next();
    expect((await screen.findByRole("alert")).textContent).toBe("โดเมน (Domain): ใช้โดเมนหลัก ไม่ใช่ www (Use the apex domain, not www)");
    fill("โดเมน (Domain)", "maple.test");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
  });

  it("goes from the Brand step straight to Template: no Product step and no APR, term or loan-rule field", async () => {
    setup();
    await fillBrand();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1. แบรนด์", "2. เทมเพลต", "3. ข้อความ", "4. ติดตามผล", "5. ตรวจสอบ",
    ]);
    next();
    await heading("เทมเพลต (Template)");
    // Only the two brand color hex fields are text inputs on this step.
    expect(screen.getAllByRole("textbox").map((box) => box.getAttribute("aria-label"))).toEqual(["รหัสสีหลัก (Primary hex)", "รหัสสีรอง (Secondary hex)"]);
    expect(screen.queryByText(/APR|Representative example|Unsupported states|Min term|Max term/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "ผลิตภัณฑ์ (Product)" })).toBeNull();
  });
});

describe("five-step flow to Generate", () => {
  it("creates the draft on the first Next, PATCHes on every later Next, then installs the saved revision", async () => {
    const { onGenerated } = setup();
    await fillBrand();
    next();

    // Step 1 -> 2: one POST creates the draft with the contact, the first approved template and the typed keyword.
    await heading("เทมเพลต (Template)");
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(1);
    expect(sent("POST", "/api/brands/drafts")[0]!.body).toEqual({
      name: "Maple Cash", domain: "Maple.Test", keyword_default: "quick loan", template_version_id: "tv-1", profile: { contact: CONTACT },
    });
    expect(patches()).toHaveLength(0);

    // Step 2: only approved templates are cards, with a thumbnail and the brands-using count.
    const cards = [...document.querySelectorAll("button[aria-pressed]")];
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(screen.queryByText(/Unapproved/)).toBeNull();
    expect(screen.getByRole("img", { name: "ตัวอย่าง Harbor (Template preview)" }).getAttribute("src")).toBe("/api/templates/tv-1/screenshots/desktop");
    expect(screen.getByText("แบรนด์ที่ใช้ (Brands using): 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copperline/ }));
    next();

    // Step 2 -> 3: a changed template is its own PATCH, with no profile in it.
    await heading("ข้อความ (Copy)");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({ template_version_id: "tv-2" });
    // Template text is the placeholder of each field.
    await waitFor(() => expect(text("ชื่อหน้า (Page title)").placeholder).toBe("Harbor | Funding Options"));
    expect(text("ชื่อแบรนด์บนเว็บ (Site brand name)").placeholder).toBe("Maple Cash");
    fill("ชื่อหน้า (Page title)", "Maple Cash | Quick Funding");
    fill("หัวข้อหลัก H1 (Headline)", "{{keyword}} in minutes");
    fill("ปุ่ม CTA (Button text)", "Check my rate");
    next();

    // Step 3 -> 4: the profile holds the contact and the copy, and no disclosures.
    await heading("ติดตามผล (Tracking)");
    expect(patches()).toHaveLength(2);
    expect(patches()[1]!.body).toEqual({ profile: { contact: CONTACT, copy: { site_title: "Maple Cash | Quick Funding", h1: "{{keyword}} in minutes", cta: "Check my rate" } } });
    fill("บัญชี Google Ads (Google Ads account)", ADS.google_ads_account);
    fill("รหัส conversion action (Conversion action)", ADS.google_conversion_action);
    fill("โปรเจกต์ AdKit (AdKit project)", ADS.adkit_project);
    fill("บัญชี Microsoft Ads (Microsoft Ads account)", ADS.microsoft_ads_account);
    next();

    // Step 4 -> Review: summary, zone pre-check and the preview iframe.
    await heading("ตรวจสอบ (Review)");
    expect(patches()).toHaveLength(3);
    expect((patches()[2]!.body.profile as { ads: object }).ads).toEqual(ADS);
    expect(patches().every((patch) => !JSON.stringify(patch.body).includes("disclosures"))).toBe(true);
    // The tenant values stay read-only in the summary, which lists no term, APR or state row.
    expect(await screen.findByText("100, 200, 300")).toBeTruthy();
    expect(screen.getByText("/request")).toBeTruthy();
    expect(screen.queryByText(/Max APR|Term, months|Unsupported states/)).toBeNull();
    await waitFor(() => expect(sent("POST", "/api/wizard/zone-check")).toHaveLength(1));
    expect(sent("POST", "/api/wizard/zone-check")[0]!.body).toEqual({ domain: "maple.test", brand_id: "brand_new" });
    expect(await screen.findByText(/Zone maple.test is active/)).toBeTruthy();
    const frame = screen.getByTitle("ตัวอย่างหน้าเว็บ (Site preview)") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toMatch(/^\/api\/wizard\/preview\/brand_new\?r=\d+$/);
    expect(frame.getAttribute("sandbox")).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith("brand_new", "ins_1"));
    expect(sent("POST", "/api/brands/brand_new/generate")[0]!.body).toEqual({});
    // One create, three PATCHes, one install: nothing else wrote.
    expect(requests.filter((r) => r.method !== "GET" && r.path !== "/api/wizard/zone-check").map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/brands/drafts", ...Array(3).fill("PATCH /api/brands/brand_new/draft"), "POST /api/brands/brand_new/generate",
    ]);
  });

  it("goes back without saving and keeps what was typed", async () => {
    setup();
    await fillBrand();
    next();
    await heading("เทมเพลต (Template)");
    back();
    await heading("แบรนด์ (Brand)");
    expect(text("ชื่อแบรนด์ (Brand name)").value).toBe("Maple Cash");
    // The domain is fixed once the draft exists.
    expect(text("โดเมน (Domain)").disabled).toBe(true);
    expect(text("โดเมน (Domain)").value).toBe("maple.test");
    expect((screen.getByRole("button", { name: "ย้อนกลับ (Back)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(1);
    expect(patches()).toHaveLength(0);
  });

  it("saves a changed name and keyword with PATCH when Next is pressed again on the Brand step", async () => {
    setup();
    await fillBrand();
    next();
    await heading("เทมเพลต (Template)");
    back();
    fill("ชื่อแบรนด์ (Brand name)", "Maple Cash Co");
    next();
    await heading("เทมเพลต (Template)");
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(1);
    // The keyword is the one the server normalized and returned.
    expect(patches()[0]!.body).toEqual({ name: "Maple Cash Co", keyword_default: "Quick Loan", profile: { contact: CONTACT } });
  });

  it("shows a Thai and English message and stays on the step when the domain is already registered", async () => {
    routes.set("POST /api/brands/drafts", () => json({ error: "conflict", message: "Domain is already registered" }, 409));
    setup();
    await fillBrand();
    next();
    expect((await screen.findByRole("alert")).textContent).toBe("โดเมนนี้ถูกใช้แล้ว (Domain is already registered)");
    expect(screen.getByRole("heading", { level: 2, name: "แบรนด์ (Brand)" })).toBeTruthy();
    // Retry works: the button is not stuck busy.
    routes.set("POST /api/brands/drafts", () => json(heldBody(), 201));
    next();
    await heading("เทมเพลต (Template)");
  });

  it("shows the first Generate issue when the server finds the draft incomplete", async () => {
    routes.set("POST /api/brands/brand_new/generate", () => json({ error: "draft_incomplete", issues: [{ field: "profile.contact.email", message: "ต้องระบุอีเมล (Email is required)" }] }, 422));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const { onGenerated } = setup(employee, { brandId: "brand_new" });
    await heading("ตรวจสอบ (Review)");
    await screen.findByText(/Zone maple.test is active/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }));
    expect(await screen.findByText("ต้องระบุอีเมล (Email is required)")).toBeTruthy();
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("reports a refused install, stays on Review and allows a retry", async () => {
    routes.set("POST /api/brands/brand_new/generate", () => json({ error: "lifecycle_operation_active", active_install_id: "ins_0" }, 409));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const { onGenerated } = setup(employee, { brandId: "brand_new" });
    await heading("ตรวจสอบ (Review)");
    await screen.findByText(/Zone maple.test is active/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }));
    expect(await screen.findByText("กำลังติดตั้งแบรนด์นี้อยู่ แก้ไขไม่ได้ (An install is running for this brand)")).toBeTruthy();
    expect(onGenerated).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("resume", () => {
  const resume = (profile: object | undefined, props: { initialStep?: number } = {}) => {
    hold(profile);
    return setup(employee, { brandId: "brand_new", ...props });
  };

  it("opens a draft with no saved profile at the Brand step, filled from the draft, with no new POST", async () => {
    resume(undefined);
    await heading("แบรนด์ (Brand)");
    expect(text("ชื่อแบรนด์ (Brand name)").value).toBe("Maple Cash");
    expect(text("โดเมน (Domain)").value).toBe("maple.test");
    expect(text("คีย์เวิร์ด (Keyword)").value).toBe("Quick Loan");
    next();
    await screen.findAllByRole("alert");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it.each<[string, object | undefined, string]>([
    ["contact saved", { contact: CONTACT }, "เทมเพลต (Template)"],
    ["contact and the disclosures of an older draft saved", { contact: CONTACT, disclosures: OLD_DISCLOSURES }, "เทมเพลต (Template)"],
    ["copy saved", { contact: CONTACT, copy: {} }, "ติดตามผล (Tracking)"],
    ["everything saved", { contact: CONTACT, copy: {}, ads: {} }, "ตรวจสอบ (Review)"],
  ])("opens at the first incomplete step when %s", async (_name, profile, expected) => {
    resume(profile);
    await heading(expected);
    expect(sent("GET", "/api/wizard/drafts/brand_new")).toHaveLength(1);
  });

  it("shows the copy rules inline for a filled field, holds Next on them and leaves empty fields alone", async () => {
    resume({ contact: CONTACT });
    await heading("เทมเพลต (Template)");
    next();
    await heading("ข้อความ (Copy)");
    expect(screen.queryByRole("alert")).toBeNull();
    fill("หัวข้อหลัก H1 (Headline)", "Fast cash for you");
    expect((await screen.findByRole("alert")).textContent).toMatch(/exactly once/);
    fill("ปุ่ม CTA (Button text)", 'Say "hi"');
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText(/One line of plain text/)).toBeTruthy();
    const saved = patches().length;
    next();
    expect(screen.getByRole("heading", { level: 2, name: "ข้อความ (Copy)" })).toBeTruthy();
    expect(patches()).toHaveLength(saved);
    fill("หัวข้อหลัก H1 (Headline)", "{{keyword}} in minutes");
    fill("ปุ่ม CTA (Button text)", "Check my rate");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/^21\/140/)).toBeTruthy();
    next();
    await heading("ติดตามผล (Tracking)");
    expect(patches().at(-1)!.body).toEqual({ profile: { contact: CONTACT, copy: { h1: "{{keyword}} in minutes", cta: "Check my rate" } } });
  });

  it("fills the form from the saved profile and the template of the draft, and saves with PATCH keeping the disclosures of an older draft", async () => {
    resume({ contact: CONTACT, disclosures: { ...OLD_DISCLOSURES, term_max_months: 48 } });
    await heading("เทมเพลต (Template)");
    expect(screen.getByRole("button", { name: /Harbor/ }).getAttribute("aria-pressed")).toBe("true");
    next();
    await heading("ข้อความ (Copy)");
    next();
    await heading("ติดตามผล (Tracking)");
    next();
    await heading("ตรวจสอบ (Review)");
    // The later PATCHes replace the profile with the saved groups kept. The older draft's disclosures are not shown and not dropped.
    expect(patches().at(-1)!.body).toEqual({ profile: { contact: CONTACT, disclosures: { ...OLD_DISCLOSURES, term_max_months: 48 }, copy: {}, ads: {} } });
    expect(screen.queryByText(/Max APR|Term, months|Unsupported states/)).toBeNull();
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
  });

  it("opens at a given step, as a duplicate does at the Brand step", async () => {
    resume({ contact: CONTACT, copy: {}, ads: {} }, { initialStep: 0 });
    await heading("แบรนด์ (Brand)");
  });

  it("reports a draft that cannot be loaded and retries", async () => {
    routes.set("GET /api/wizard/drafts/brand_new", () => json({ error: "conflict", message: "Only draft or failed brands can be edited" }, 409));
    setup(employee, { brandId: "brand_new" });
    expect((await screen.findByRole("alert")).textContent).toContain("ฉบับร่างถูกแก้ไขหรือติดตั้งแล้ว");
    routes.set("GET /api/wizard/drafts/brand_new", () => json(heldBody()));
    fireEvent.click(screen.getByRole("button", { name: "ลองใหม่ (Retry)" }));
    await heading("แบรนด์ (Brand)");
  });
});

describe("tracking step roles", () => {
  const original = PANEL_ROLE_TABLE.setDraftTracking;
  afterEach(() => { (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = original; });
  const atTracking = (me: typeof owner | typeof employee) => {
    hold({ contact: CONTACT, copy: {}, ads: ADS });
    setup(me, { brandId: "brand_new", initialStep: 3 });
  };

  it("lets an employee type tracking ids today, because panel-roles allows it", async () => {
    atTracking(employee);
    await heading("ติดตามผล (Tracking)");
    expect(text("บัญชี Google Ads (Google Ads account)").value).toBe(ADS.google_ads_account);
    expect(screen.queryByText(/Owner กำหนดค่านี้/)).toBeNull();
  });

  it("shows them read-only with 'Owner sets this' to an employee once panel-roles requires the owner, and does not send ads", async () => {
    (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = "owner";
    atTracking(employee);
    await heading("ติดตามผล (Tracking)");
    expect(screen.getByRole("note").textContent).toBe("Owner กำหนดค่านี้ (The Owner sets this) · แสดงอย่างเดียว (Read-only)");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(ADS.google_ads_account)).toBeTruthy();
    next();
    await heading("ตรวจสอบ (Review)");
    expect(patches()).toHaveLength(0);
  });

  it("keeps the inputs for an owner under the same rule", async () => {
    (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = "owner";
    atTracking(owner);
    await heading("ติดตามผล (Tracking)");
    expect(text("บัญชี Google Ads (Google Ads account)").value).toBe(ADS.google_ads_account);
    fill("บัญชี Google Ads (Google Ads account)", "123-456-7890");
    next();
    expect((await screen.findByRole("alert")).textContent).toBe("บัญชี Google Ads (Google Ads account): ต้องเป็นเลข 10 หลักไม่มีขีด (10 digits, no dashes)");
    expect(patches()).toHaveLength(0);
  });
});

describe("zone pre-check", () => {
  const atReview = async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    setup(employee, { brandId: "brand_new" });
    await heading("ตรวจสอบ (Review)");
  };
  const generate = () => screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }) as HTMLButtonElement;

  it("turns Generate off for an inactive zone and lists the name servers to set", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, zone_active: false }));
    await atReview();
    expect(await screen.findByText(/ยังไม่ active/)).toBeTruthy();
    expect(screen.getByText("ada.ns.cloudflare.com")).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("turns Generate off when the account has no zone for the domain", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ zone_active: false, zone_name: null, nameservers: [], conflicting_records: [] }));
    await atReview();
    expect(await screen.findByText(/ไม่พบโซนของโดเมนนี้/)).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("turns Generate off for conflicting DNS records and lists them", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, conflicting_records: [{ type: "A", name: "maple.test" }, { type: "CNAME", name: "www.maple.test" }] }));
    await atReview();
    expect(await screen.findByText("A maple.test")).toBeTruthy();
    expect(screen.getByText("CNAME www.maple.test")).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("keeps Generate on when the check itself fails, and Check again recovers", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ error: "zone_check_unavailable" }, 502));
    await atReview();
    expect(await screen.findByText("ตรวจโซน Cloudflare ไม่สำเร็จ ลองใหม่ภายหลัง (Zone check failed, try again later)")).toBeTruthy();
    expect(generate().disabled).toBe(false);
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, zone_active: false }));
    fireEvent.click(screen.getByRole("button", { name: "ตรวจอีกครั้ง (Check again)" }));
    await waitFor(() => expect(generate().disabled).toBe(true));
  });

  it("checks the domain on the Brand step on demand and does not block Next", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, zone_active: false }));
    setup();
    await fillBrand();
    fireEvent.click(screen.getByRole("button", { name: "ตรวจโซน Cloudflare (Check Cloudflare zone)" }));
    expect(await screen.findByText(/ยังไม่ active/)).toBeTruthy();
    expect(sent("POST", "/api/wizard/zone-check")[0]!.body).toEqual({ domain: "Maple.Test" });
    next();
    await heading("เทมเพลต (Template)");
  });
});

describe("template step without approved templates", () => {
  it("explains it and keeps Next off", async () => {
    routes.set("GET /api/templates", () => json({ templates: [TEMPLATES[2]] }));
    hold({ contact: CONTACT });
    setup(employee, { brandId: "brand_new" });
    await heading("เทมเพลต (Template)");
    expect(screen.getByRole("status").textContent).toContain("ยังไม่มีเทมเพลตที่อนุมัติ");
    expect((screen.getByRole("button", { name: "ถัดไป (Next)" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("template step brand colors", () => {
  const THEME = { primary: "#112233", secondary: "#445566" };
  const PRIMARY_HEX = "รหัสสีหลัก (Primary hex)";
  const RESET = "ใช้สีของเทมเพลต (Use template colors)";

  it("template step saves profile.theme in the draft", async () => {
    hold({ contact: CONTACT, copy: {} });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต (Template)");
    fireEvent.change(screen.getByLabelText("สีหลัก (Primary)"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("สีรอง (Secondary)"), { target: { value: "#445566" } });
    next();
    await heading("ข้อความ (Copy)");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({ profile: { contact: CONTACT, copy: {}, theme: THEME } });
  });

  it("reset saves the draft without theme", async () => {
    hold({ contact: CONTACT, theme: THEME });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต (Template)");
    expect(text(PRIMARY_HEX).value).toBe("#112233");
    fireEvent.click(screen.getByRole("button", { name: RESET }));
    next();
    await heading("ข้อความ (Copy)");
    expect(patches()).toHaveLength(1);
    const profile = patches()[0]!.body.profile as Record<string, unknown>;
    expect(profile).toEqual({ contact: CONTACT });
    expect("theme" in profile).toBe(false);
  });

  it("makes no extra request when the colors are untouched", async () => {
    hold({ contact: CONTACT, theme: THEME });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต (Template)");
    next();
    await heading("ข้อความ (Copy)");
    expect(patches()).toHaveLength(0);
  });

  it("template step disables colors for a template without color variables", async () => {
    const empty = detail("tv-1");
    routes.set("GET /api/templates/tv-1", () => json({ ...empty, template: { ...empty.template, theme_vars: { primary: [], primary_dark: [], secondary: [] } } }));
    hold({ contact: CONTACT, copy: {} });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต (Template)");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก (Primary)") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("สีรอง (Secondary)") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี (This template has no color variables)");
  });

  it("pickers are disabled with the no-variables note when the template maps none", () => {
    render(<TemplatePanel templates={[]} selected="" theme={null} onTheme={vi.fn()} themeVars={{ primary: [], primary_dark: [], secondary: [] }} onSelect={vi.fn()} />);
    expect((screen.getByLabelText("สีหลัก (Primary)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("สีรอง (Secondary)") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี (This template has no color variables)");
  });
});

describe("entry points on the Lifecycle screen", () => {
  const draftRow = LifecycleBrandSummary.parse({
    brand_id: "brand_new", name: "Maple Cash", account: "test-account", hostnames: ["maple.test", "www.maple.test"],
    status: "draft", current_revision_id: null, runtime_sync_status: "queued", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
  });
  const liveRow = LifecycleBrandSummary.parse({ ...draftRow, brand_id: "brand_live", name: "Live Cash", hostnames: ["live.test"], status: "live", current_revision_id: "rev-1", runtime_sync_status: "ready" });
  let rows: LifecycleBrandSummary[];
  beforeEach(() => {
    rows = [draftRow, liveRow];
    routes.set("GET /api/lifecycle/brands", () => json({ brands: rows }));
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: NOW }));
    routes.set("GET /api/upgrade-all/latest", () => json({ upgrade: null }));
    for (const id of ["brand_new", "brand_live"]) {
      routes.set(`GET /api/brands/${id}/checklist`, () => json({ brand_id: id, checklist: [] }));
      routes.set(`GET /api/brands/${id}/installs`, () => json({ brand_id: id, installs: [] }));
    }
  });

  it("replaces the create form with one New brand button that opens the wizard", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "maple.test" });
    expect(screen.queryByRole("button", { name: /Create draft/ })).toBeNull();
    // The only select left on the screen is the list's sort.
    expect(screen.getAllByRole("combobox")).toEqual([screen.getByLabelText(/เรียงลำดับ/)]);
    fireEvent.click(screen.getByRole("button", { name: "แบรนด์ใหม่ (New brand)" }));
    await heading("แบรนด์ (Brand)");
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
  });

  it("opens the wizard from the app menu request counter", async () => {
    const view = render(<BrandLifecycle me={employee} wizardRequest={0} />);
    await screen.findByRole("heading", { name: "maple.test" });
    view.rerender(<BrandLifecycle me={employee} wizardRequest={1} />);
    await heading("แบรนด์ (Brand)");
  });

  it("starts the install from Generate and returns to the list with the brand selected", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    await screen.findByText(/Zone maple.test is active/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์ (Generate)" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "maple.test" })).toBeTruthy();
    expect(sent("POST", "/api/brands/brand_new/generate")).toHaveLength(1);
  });

  it("offers Resume in wizard for a draft only, and Duplicate for every managed brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "maple.test" });
    expect(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ทำสำเนา (Duplicate)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Live Cash/ }));
    await screen.findByRole("heading", { name: "live.test" });
    expect(screen.queryByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" })).toBeNull();
    expect(screen.getByRole("button", { name: "ทำสำเนา (Duplicate)" })).toBeTruthy();
  });

  it("keeps a resumed draft wizard open while the new-brand route stays off", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} wizardRoute={false} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} wizardRoute={false} />);
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "ตรวจสอบ (Review)" })).toBeTruthy();
  });

  it("replaces a resumed draft wizard with the new-brand wizard when the route enters /brands/new, and closes it on leaving", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} wizardRoute={false} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} wizardRoute />);
    await heading("แบรนด์ (Brand)");
    expect((text("ชื่อแบรนด์ (Brand name)")).value).toBe("");
    view.rerender(<BrandLifecycle me={employee} wizardRoute={false} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeNull());
  });

  it("closes a resumed draft wizard when Back moves the route to another brand", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_live" />);
    await screen.findByRole("heading", { name: "live.test" });
    // The row click moves the URL to the draft; the wizard then resumes that draft.
    fireEvent.click(screen.getByRole("button", { name: /Maple Cash/ }));
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_live" />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "live.test" })).toBeTruthy();
  });

  it("closes a resumed draft wizard when the route turns to /brands, and the draft stays selected", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} routeBrandId={null} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "maple.test" })).toBeTruthy();
  });

  it("opens the new-brand wizard in place of a resumed draft when the route turns to /brands/new", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} routeBrandId={null} wizardRoute />);
    await heading("แบรนด์ (Brand)");
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
  });

  it("keeps a resumed draft wizard open while the route stays on its brand", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด (Resume in wizard)" }));
    await heading("ตรวจสอบ (Review)");
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่ (New brand wizard)" })).toBeTruthy();
  });

  it("duplicates a brand with a new domain and opens the copy at the Brand step", async () => {
    routes.set("POST /api/brands/brand_live/duplicate", () => json({ ...draftBody({ name: "Copy Cash" }), duplicated_from: "brand_live" }, 201));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    held.name = "Copy Cash";
    const onSelectBrand = vi.fn();
    render(<BrandLifecycle me={employee} onSelectBrand={onSelectBrand} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: /Live Cash/ }));
    await screen.findByRole("heading", { name: "live.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำสำเนา (Duplicate)" }));
    const dialog = await screen.findByRole("dialog", { name: "ทำสำเนาแบรนด์ (Duplicate brand)" });

    // A new domain is required and checked before anything is sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา (Duplicate)" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("โดเมน (Domain): จำเป็นต้องกรอก (Required)");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่ (New domain)" }), { target: { value: "www.copy.test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา (Duplicate)" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("ใช้โดเมนหลัก ไม่ใช่ www");
    expect(sent("POST", "/api/brands/brand_live/duplicate")).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่ (New domain)" }), { target: { value: "copy.test" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ชื่อแบรนด์ใหม่ (New brand name, optional)" }), { target: { value: "Copy Cash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา (Duplicate)" }));
    await heading("แบรนด์ (Brand)");
    expect(sent("POST", "/api/brands/brand_live/duplicate")[0]!.body).toEqual({ domain: "copy.test", name: "Copy Cash" });
    expect(text("ชื่อแบรนด์ (Brand name)").value).toBe("Copy Cash");
    // The URL follows the copy, not the brand it was copied from.
    expect(onSelectBrand).toHaveBeenCalledWith("brand_new");
  });

  it("reports a taken domain in the duplicate dialog and keeps it open", async () => {
    routes.set("POST /api/brands/brand_live/duplicate", () => json({ error: "conflict", message: "Domain is already registered" }, 409));
    render(<BrandLifecycle me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: /Live Cash/ }));
    await screen.findByRole("heading", { name: "live.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำสำเนา (Duplicate)" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่ (New domain)" }), { target: { value: "live.test" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา (Duplicate)" })); });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("โดเมนนี้ถูกใช้แล้ว (Domain is already registered)");
  });
});
