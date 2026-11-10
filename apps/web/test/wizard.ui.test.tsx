import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { stripEnglishSuffix, wizardErrorText } from "../src/client/wizard/messages";
import { ApiError } from "../src/client/api";
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
    ["GET /api/v1/adkit/projects", () => json({ items: [{ id: ADS.adkit_project, name: "Maple ads", currency: null, updated_at: new Date().toISOString() }], synced_at: new Date().toISOString() })],
    [`GET /api/v1/adkit/projects/${ADS.adkit_project}/accounts`, () => json({ items: [{ id: ADS.google_ads_account, name: "Main", currency: "THB", updated_at: new Date().toISOString() }], synced_at: new Date().toISOString() })],
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
const next = () => fireEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
const back = () => fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const patches = () => sent("PATCH", "/api/brands/brand_new/draft");

function setup(me: Me = employee, props: { brandId?: string; initialStep?: number } = {}) {
  const onClose = vi.fn();
  const onGenerated = vi.fn();
  render(<BrandWizard me={me} onClose={onClose} onGenerated={onGenerated} {...props} />);
  return { onClose, onGenerated };
}
async function fillBrand() {
  await screen.findByRole("textbox", { name: "ชื่อแบรนด์" });
  fill("ชื่อแบรนด์", "Maple Cash");
  fill("โดเมน", "Maple.Test");
  fill("คีย์เวิร์ด", "quick loan");
  fill("โทรศัพท์", CONTACT.phone);
  fill("ที่อยู่", CONTACT.address);
  fill("อีเมล", CONTACT.email);
}

describe("per-step validation", () => {
  it("blocks Next on an empty Brand step with a Thai and English error per field and sends nothing", async () => {
    setup();
    await screen.findByRole("textbox", { name: "ชื่อแบรนด์" });
    next();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(expect.arrayContaining([
      "ชื่อแบรนด์: จำเป็นต้องกรอก", "โดเมน: จำเป็นต้องกรอก", "อีเมล: จำเป็นต้องกรอก",
    ]));
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "ข้อมูลแบรนด์" })).toBeTruthy();
  });

  it("clears a field's error when it is edited and refuses a www domain with a short message", async () => {
    setup();
    await fillBrand();
    fill("โดเมน", "www.maple.test");
    next();
    expect((await screen.findByRole("alert")).textContent).toBe("โดเมน: ใช้โดเมนหลัก ไม่ใช่ www");
    fill("โดเมน", "maple.test");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
  });

  it("goes from the Brand step straight to Template: no Product step and no APR, term or loan-rule field", async () => {
    setup();
    await fillBrand();
    expect([...document.querySelectorAll(".wizard-stepper > li")].map((item) => item.textContent)).toEqual([
      "1ข้อมูลแบรนด์", "2เทมเพลต", "3ข้อความ", "4ติดตามผล", "5ตรวจและสร้าง",
    ]);
    next();
    await heading("เทมเพลต");
    // Only the two brand color hex fields are text inputs on this step.
    expect(screen.getAllByRole("textbox").map((box) => box.getAttribute("aria-label"))).toEqual(["รหัสสีหลัก", "รหัสสีรอง"]);
    expect(screen.queryByText(/APR|Representative example|Unsupported states|Min term|Max term/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "ผลิตภัณฑ์" })).toBeNull();
  });
});

describe("five-step flow to Generate", () => {
  it("creates the draft on the first Next, PATCHes on every later Next, then installs the saved revision", async () => {
    const { onGenerated } = setup(owner);
    await fillBrand();
    next();

    // Step 1 -> 2: one POST creates the draft with the contact, the first approved template and the typed keyword.
    await heading("เทมเพลต");
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
    expect(screen.getByRole("img", { name: "ตัวอย่าง Harbor" }).getAttribute("src")).toBe("/api/templates/tv-1/screenshots/desktop");
    expect(screen.getByText("แบรนด์ที่ใช้: 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copperline/ }));
    next();

    // Step 2 -> 3: a changed template is its own PATCH, with no profile in it.
    await heading("ข้อความ");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({ template_version_id: "tv-2" });
    // Template text is the placeholder of each field.
    await waitFor(() => expect(text("ชื่อหน้า").placeholder).toBe("Harbor | Funding Options"));
    expect(text("ชื่อแบรนด์บนเว็บ").placeholder).toBe("Maple Cash");
    fill("ชื่อหน้า", "Maple Cash | Quick Funding");
    fill("หัวข้อหลัก H1", "{{keyword}} in minutes");
    fill("ปุ่ม CTA", "Check my rate");
    next();

    // Step 3 -> 4: the profile holds the contact and the copy, and no disclosures.
    await heading("ติดตามผล");
    expect(patches()).toHaveLength(2);
    expect(patches()[1]!.body).toEqual({ profile: { contact: CONTACT, copy: { site_title: "Maple Cash | Quick Funding", h1: "{{keyword}} in minutes", cta: "Check my rate" } } });
    // Step 4 has selects from the AdKit directory and no text input (wizard-step4.ui.test.tsx covers the job).
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "โปรเจกต์ AdKit" }) as unknown as HTMLSelectElement).options).toHaveLength(2));
    fireEvent.change(screen.getByRole("combobox", { name: "โปรเจกต์ AdKit" }), { target: { value: ADS.adkit_project } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "บัญชี Google Ads" }) as unknown as HTMLSelectElement).options).toHaveLength(2));
    fireEvent.change(screen.getByRole("combobox", { name: "บัญชี Google Ads" }), { target: { value: ADS.google_ads_account } });
    next();

    // Step 4 -> Review: summary, zone pre-check and the preview iframe.
    await heading("ตรวจและสร้าง");
    expect(patches()).toHaveLength(3);
    expect((patches()[2]!.body.profile as { ads: object }).ads).toEqual({ google_ads_account: ADS.google_ads_account, adkit_project: ADS.adkit_project });
    expect(patches().every((patch) => !JSON.stringify(patch.body).includes("disclosures"))).toBe(true);
    // The tenant values stay read-only in the summary, which lists no term, APR or state row.
    expect(await screen.findByText("100, 200, 300")).toBeTruthy();
    expect(screen.getByText("/request")).toBeTruthy();
    expect(screen.queryByText(/Max APR|Term, months|Unsupported states/)).toBeNull();
    await waitFor(() => expect(sent("POST", "/api/wizard/zone-check")).toHaveLength(1));
    expect(sent("POST", "/api/wizard/zone-check")[0]!.body).toEqual({ domain: "maple.test", brand_id: "brand_new" });
    expect(await screen.findByText(/โซน maple.test active และไม่มี record ที่ขวาง/)).toBeTruthy();
    const frame = screen.getByTitle("ตัวอย่างหน้าเว็บ") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toMatch(/^\/api\/wizard\/preview\/brand_new\?r=\d+$/);
    expect(frame.getAttribute("sandbox")).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์" }));
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
    await heading("เทมเพลต");
    back();
    await heading("ข้อมูลแบรนด์");
    expect(text("ชื่อแบรนด์").value).toBe("Maple Cash");
    // The domain is fixed once the draft exists.
    expect(text("โดเมน").disabled).toBe(true);
    expect(text("โดเมน").value).toBe("maple.test");
    expect((screen.getByRole("button", { name: "ย้อนกลับ" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(1);
    expect(patches()).toHaveLength(0);
  });

  it("saves a changed name and keyword with PATCH when Next is pressed again on the Brand step", async () => {
    setup();
    await fillBrand();
    next();
    await heading("เทมเพลต");
    back();
    fill("ชื่อแบรนด์", "Maple Cash Co");
    next();
    await heading("เทมเพลต");
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(1);
    // The keyword is the one the server normalized and returned.
    expect(patches()[0]!.body).toEqual({ name: "Maple Cash Co", keyword_default: "Quick Loan", profile: { contact: CONTACT } });
  });

  it("shows a Thai and English message and stays on the step when the domain is already registered", async () => {
    routes.set("POST /api/brands/drafts", () => json({ error: "conflict", message: "Domain is already registered" }, 409));
    setup();
    await fillBrand();
    next();
    expect((await screen.findByRole("alert")).textContent).toBe("โดเมนนี้ถูกใช้แล้ว");
    expect(screen.getByRole("heading", { level: 2, name: "ข้อมูลแบรนด์" })).toBeTruthy();
    // Retry works: the button is not stuck busy.
    routes.set("POST /api/brands/drafts", () => json(heldBody(), 201));
    next();
    await heading("เทมเพลต");
  });

  it("shows the first Generate issue in Thai when the server finds the draft incomplete, whatever the server's own text says", async () => {
    // The real server string is bilingual (apps/web/src/server/generate.ts). The page maps the field to Thai and never shows the English.
    routes.set("POST /api/brands/brand_new/generate", () => json({ error: "draft_incomplete", issues: [{ field: "profile.contact.email", message: "ต้องระบุอีเมล (Email is required)" }] }, 422));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const { onGenerated } = setup(owner, { brandId: "brand_new" });
    await heading("ตรวจและสร้าง");
    await screen.findByText(/โซน maple.test active และไม่มี record ที่ขวาง/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์" }));
    expect(await screen.findByText("ต้องระบุอีเมล")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Email is required");
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("maps every field Generate reports to Thai, and strips the English suffix from a field it does not know", () => {
    const issue = (field: string, message: string) => wizardErrorText(new ApiError(422, { error: "draft_incomplete", issues: [{ field, message } as never] }));
    expect(issue("domain", "โดเมนต้องเป็น apex domain ที่ถูกต้อง (Domain must be a valid apex domain)")).toBe("โดเมนต้องเป็นโดเมนหลักที่ถูกต้อง");
    expect(issue("template_version_id", "เทมเพลตยังไม่ถูก seal (Template version is not sealed)")).toBe("เทมเพลตยังไม่ได้อนุมัติ");
    expect(issue("keyword_default", "ต้องระบุคีย์เวิร์ด (Keyword is required)")).toBe("ต้องระบุคีย์เวิร์ด");
    expect(issue("profile", "ข้อมูลโปรไฟล์แบรนด์ไม่ถูกต้อง (Brand profile is invalid)")).toBe("ข้อมูลโปรไฟล์แบรนด์ไม่ถูกต้อง");
    expect(issue("profile.contact.phone", "ต้องระบุเบอร์โทรศัพท์ (Phone is required)")).toBe("ต้องระบุเบอร์โทรศัพท์");
    expect(issue("profile.contact.address", "ต้องระบุที่อยู่ (Address is required)")).toBe("ต้องระบุที่อยู่");
    expect(issue("profile.contact.email", "ต้องระบุอีเมล (Email is required)")).toBe("ต้องระบุอีเมล");
    // A field the client does not know keeps the server's Thai and loses its English suffix.
    expect(issue("something.new", "ข้อมูลไม่ครบ (Something is missing)")).toBe("ข้อมูลไม่ครบ");
    expect(wizardErrorText(new ApiError(422, { error: "draft_incomplete", issues: [] }))).toBe("ฉบับร่างยังไม่ครบ");
    expect(stripEnglishSuffix("ข้อความ (English text)")).toBe("ข้อความ");
    expect(stripEnglishSuffix("ใช้ (1) ได้")).toBe("ใช้ (1) ได้");
  });

  it("keeps Generate off for an employee with the Thai reason and sends no generate request", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const { onGenerated } = setup(employee, { brandId: "brand_new" });
    await heading("ตรวจและสร้าง");
    await screen.findByText(/โซน maple.test active และไม่มี record ที่ขวาง/);
    const button = screen.getByRole("button", { name: "สร้างเว็บไซต์" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toBe("เฉพาะ Owner สร้างเว็บไซต์ได้ ฉบับร่างบันทึกแล้ว ให้ Owner กดสร้าง");
    fireEvent.click(button);
    expect(sent("POST", "/api/brands/brand_new/generate")).toHaveLength(0);
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("reports a refused install, stays on Review and allows a retry", async () => {
    routes.set("POST /api/brands/brand_new/generate", () => json({ error: "lifecycle_operation_active", active_install_id: "ins_0" }, 409));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const { onGenerated } = setup(owner, { brandId: "brand_new" });
    await heading("ตรวจและสร้าง");
    await screen.findByText(/โซน maple.test active และไม่มี record ที่ขวาง/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์" }));
    expect(await screen.findByText("กำลังติดตั้งแบรนด์นี้อยู่ แก้ไขไม่ได้")).toBeTruthy();
    expect(onGenerated).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "สร้างเว็บไซต์" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("resume", () => {
  const resume = (profile: object | undefined, props: { initialStep?: number } = {}) => {
    hold(profile);
    return setup(employee, { brandId: "brand_new", ...props });
  };

  it("opens a draft with no saved profile at the Brand step, filled from the draft, with no new POST", async () => {
    resume(undefined);
    await heading("ข้อมูลแบรนด์");
    expect(text("ชื่อแบรนด์").value).toBe("Maple Cash");
    expect(text("โดเมน").value).toBe("maple.test");
    expect(text("คีย์เวิร์ด").value).toBe("Quick Loan");
    // The keyword is shown only in the page title, meta description and form header, and only when the ad link has a keyword.
    expect(screen.getByText("คำนี้แสดงในชื่อหน้า คำอธิบายเว็บ และหัวฟอร์ม เมื่อลิงก์โฆษณามีคีย์เวิร์ด")).toBeTruthy();
    next();
    await screen.findAllByRole("alert");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it.each<[string, object | undefined, string]>([
    ["contact saved", { contact: CONTACT }, "เทมเพลต"],
    ["contact and the disclosures of an older draft saved", { contact: CONTACT, disclosures: OLD_DISCLOSURES }, "เทมเพลต"],
    ["copy saved, for an employee who cannot set tracking ids", { contact: CONTACT, copy: {} }, "ตรวจและสร้าง"],
    ["everything saved", { contact: CONTACT, copy: {}, ads: {} }, "ตรวจและสร้าง"],
  ])("opens at the first incomplete step when %s", async (_name, profile, expected) => {
    resume(profile);
    await heading(expected);
    expect(sent("GET", "/api/wizard/drafts/brand_new")).toHaveLength(1);
  });

  it("shows the copy rules inline for a filled field, holds Next on them and leaves empty fields alone", async () => {
    resume({ contact: CONTACT });
    await heading("เทมเพลต");
    next();
    await heading("ข้อความ");
    expect(screen.queryByRole("alert")).toBeNull();
    // The {{keyword}} slot becomes the site name on the page.
    expect(screen.getByText(/ใส่ \{\{keyword\}\} หนึ่งครั้ง \(ตำแหน่งนี้แสดงชื่อเว็บไซต์\)/)).toBeTruthy();
    fill("หัวข้อหลัก H1", "Fast cash for you");
    expect((await screen.findByRole("alert")).textContent).toMatch(/หนึ่งครั้งพอดี/);
    fill("ปุ่ม CTA", 'Say "hi"');
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText(/ใช้ข้อความบรรทัดเดียว/)).toBeTruthy();
    const saved = patches().length;
    next();
    expect(screen.getByRole("heading", { level: 2, name: "ข้อความ" })).toBeTruthy();
    expect(patches()).toHaveLength(saved);
    fill("หัวข้อหลัก H1", "{{keyword}} in minutes");
    fill("ปุ่ม CTA", "Check my rate");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/^21\/140/)).toBeTruthy();
    next();
    await heading("ติดตามผล");
    expect(patches().at(-1)!.body).toEqual({ profile: { contact: CONTACT, copy: { h1: "{{keyword}} in minutes", cta: "Check my rate" } } });
  });

  it("fills the form from the saved profile and the template of the draft, and saves with PATCH keeping the disclosures of an older draft", async () => {
    resume({ contact: CONTACT, disclosures: { ...OLD_DISCLOSURES, term_max_months: 48 } });
    await heading("เทมเพลต");
    expect(screen.getByRole("button", { name: /Harbor/ }).getAttribute("aria-pressed")).toBe("true");
    next();
    await heading("ข้อความ");
    next();
    await heading("ติดตามผล");
    next();
    await heading("ตรวจและสร้าง");
    // The later PATCHes replace the profile with the saved groups kept. The older draft's disclosures are not shown and not dropped.
    // The Tracking step is read-only to an employee (owner only, useAdkit) and saves nothing, so the Copy step's PATCH is the last.
    expect(patches().at(-1)!.body).toEqual({ profile: { contact: CONTACT, disclosures: { ...OLD_DISCLOSURES, term_max_months: 48 }, copy: {} } });
    expect(screen.queryByText(/Max APR|Term, months|Unsupported states/)).toBeNull();
    expect(sent("POST", "/api/brands/drafts")).toHaveLength(0);
  });

  it("opens an owner at the Tracking step when the copy is saved", async () => {
    hold({ contact: CONTACT, copy: {} });
    setup(owner, { brandId: "brand_new" });
    await heading("ติดตามผล");
  });

  it("opens at a given step, as a duplicate does at the Brand step", async () => {
    resume({ contact: CONTACT, copy: {}, ads: {} }, { initialStep: 0 });
    await heading("ข้อมูลแบรนด์");
  });

  it("reports a draft that cannot be loaded and retries", async () => {
    routes.set("GET /api/wizard/drafts/brand_new", () => json({ error: "conflict", message: "Only draft or failed brands can be edited" }, 409));
    setup(employee, { brandId: "brand_new" });
    expect((await screen.findByRole("alert")).textContent).toContain("ฉบับร่างถูกแก้ไขหรือติดตั้งแล้ว");
    routes.set("GET /api/wizard/drafts/brand_new", () => json(heldBody()));
    fireEvent.click(screen.getByRole("button", { name: "ลองใหม่" }));
    await heading("ข้อมูลแบรนด์");
  });
});

describe("tracking step roles", () => {
  const original = PANEL_ROLE_TABLE.setDraftTracking;
  afterEach(() => { (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = original; });
  const atTracking = (me: typeof owner | typeof employee) => {
    hold({ contact: CONTACT, copy: {}, ads: ADS });
    setup(me, { brandId: "brand_new", initialStep: 3 });
  };

  it("shows them read-only to an employee, because the AdKit directory and jobs are owner only, and does not send ads", async () => {
    atTracking(employee);
    await heading("ติดตามผล");
    expect(screen.getByRole("note").textContent).toBe("Owner กำหนดค่านี้ · แสดงอย่างเดียว");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(ADS.google_ads_account)).toBeTruthy();
    next();
    await heading("ตรวจและสร้าง");
    expect(patches()).toHaveLength(0);
  });

  it("keeps the selects for an owner when panel-roles requires the owner for tracking ids", async () => {
    (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = "owner";
    atTracking(owner);
    await heading("ติดตามผล");
    await waitFor(() => expect((screen.getByRole("combobox", { name: "บัญชี Google Ads" }) as unknown as HTMLSelectElement).value).toBe(ADS.google_ads_account));
    expect((screen.getByRole("combobox", { name: "โปรเจกต์ AdKit" }) as unknown as HTMLSelectElement).value).toBe(ADS.adkit_project);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("zone pre-check", () => {
  // Generate is owner only, so the zone gate is read on an owner session.
  const atReview = async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    setup(owner, { brandId: "brand_new" });
    await heading("ตรวจและสร้าง");
  };
  const generate = () => screen.getByRole("button", { name: "สร้างเว็บไซต์" }) as HTMLButtonElement;

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
    expect(await screen.findByText("ตรวจโซน Cloudflare ไม่สำเร็จ ลองใหม่ภายหลัง")).toBeTruthy();
    expect(generate().disabled).toBe(false);
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, zone_active: false }));
    fireEvent.click(screen.getByRole("button", { name: "ตรวจอีกครั้ง" }));
    await waitFor(() => expect(generate().disabled).toBe(true));
  });

  it("checks the domain on the Brand step on demand and does not block Next", async () => {
    routes.set("POST /api/wizard/zone-check", () => json({ ...ACTIVE_ZONE, zone_active: false }));
    setup();
    await fillBrand();
    fireEvent.click(screen.getByRole("button", { name: "ตรวจโซน Cloudflare" }));
    expect(await screen.findByText(/ยังไม่ active/)).toBeTruthy();
    expect(sent("POST", "/api/wizard/zone-check")[0]!.body).toEqual({ domain: "Maple.Test" });
    next();
    await heading("เทมเพลต");
  });
});

describe("template step without approved templates", () => {
  it("explains it and keeps Next off", async () => {
    routes.set("GET /api/templates", () => json({ templates: [TEMPLATES[2]] }));
    hold({ contact: CONTACT });
    setup(employee, { brandId: "brand_new" });
    await heading("เทมเพลต");
    expect(screen.getByRole("status").textContent).toContain("ยังไม่มีเทมเพลตที่อนุมัติ");
    expect((screen.getByRole("button", { name: "ถัดไป" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("template step brand colors", () => {
  const THEME = { primary: "#112233", secondary: "#445566" };
  const PRIMARY_HEX = "รหัสสีหลัก";
  const RESET = "ใช้สีของเทมเพลต";

  const mapDetail = () => {
    const mapped = detail("tv-1");
    routes.set("GET /api/templates/tv-1", () => json({ ...mapped, template: { ...mapped.template, theme_vars: { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: [] } } }));
  };

  it("template step saves profile.theme in the draft", async () => {
    mapDetail();
    hold({ contact: CONTACT, copy: {} });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("สีหลัก"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("สีรอง"), { target: { value: "#445566" } });
    next();
    await heading("ข้อความ");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({ profile: { contact: CONTACT, copy: {}, theme: THEME } });
  });

  it("reset saves the draft without theme", async () => {
    mapDetail();
    hold({ contact: CONTACT, theme: THEME });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    expect(text(PRIMARY_HEX).value).toBe("#112233");
    fireEvent.click(screen.getByRole("button", { name: RESET }));
    next();
    await heading("ข้อความ");
    expect(patches()).toHaveLength(1);
    const profile = patches()[0]!.body.profile as Record<string, unknown>;
    expect(profile).toEqual({ contact: CONTACT });
    expect("theme" in profile).toBe(false);
  });

  it("makes no extra request when the colors are untouched", async () => {
    mapDetail();
    hold({ contact: CONTACT, theme: THEME });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(false));
    next();
    await heading("ข้อความ");
    expect(patches()).toHaveLength(0);
  });

  it("a template without color variables saves the draft without theme", async () => {
    const empty = detail("tv-1");
    routes.set("GET /api/templates/tv-1", () => json({ ...empty, template: { ...empty.template, theme_vars: { primary: [], primary_dark: [], secondary: [] } } }));
    hold({ contact: CONTACT, theme: THEME });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(true));
    next();
    await heading("ข้อความ");
    expect(patches()).toHaveLength(1);
    const profile = patches()[0]!.body.profile as Record<string, unknown>;
    expect(profile).toEqual({ contact: CONTACT });
    expect("theme" in profile).toBe(false);
  });

  it("template step disables colors for a template without color variables", async () => {
    const empty = detail("tv-1");
    routes.set("GET /api/templates/tv-1", () => json({ ...empty, template: { ...empty.template, theme_vars: { primary: [], primary_dark: [], secondary: [] } } }));
    hold({ contact: CONTACT, copy: {} });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("สีรอง") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี");
  });

  it("template step disables colors when the template has no stored color map", async () => {
    // detail() answers theme_vars: null, the shape of a version imported before the color map existed.
    hold({ contact: CONTACT, copy: {} });
    setup(employee, { brandId: "brand_new", initialStep: 1 });
    await heading("เทมเพลต");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("สีรอง") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี");
  });

  it("pickers are disabled with the no-variables note when the template maps none", () => {
    render(<TemplatePanel templates={[]} selected="" theme={null} onTheme={vi.fn()} themeVars={{ primary: [], primary_dark: [], secondary: [] }} onSelect={vi.fn()} />);
    expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("สีรอง") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี");
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
    fireEvent.click(screen.getByRole("button", { name: "แบรนด์ใหม่" }));
    await heading("ข้อมูลแบรนด์");
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
  });

  it("opens the wizard from the app menu request counter", async () => {
    const view = render(<BrandLifecycle me={employee} wizardRequest={0} />);
    await screen.findByRole("heading", { name: "maple.test" });
    view.rerender(<BrandLifecycle me={employee} wizardRequest={1} />);
    await heading("ข้อมูลแบรนด์");
  });

  it("starts the install from Generate and returns to the list with the brand selected", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    render(<BrandLifecycle me={owner} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    await screen.findByText(/โซน maple.test active และไม่มี record ที่ขวาง/);
    fireEvent.click(screen.getByRole("button", { name: "สร้างเว็บไซต์" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "maple.test" })).toBeTruthy();
    expect(sent("POST", "/api/brands/brand_new/generate")).toHaveLength(1);
  });

  it("offers Resume in wizard for a draft only, and Duplicate for every managed brand", async () => {
    render(<BrandLifecycle me={employee} />);
    await screen.findByRole("heading", { name: "maple.test" });
    expect(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ทำสำเนา" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /live.test/ }));
    await screen.findByRole("heading", { name: "live.test" });
    expect(screen.queryByRole("button", { name: "ทำต่อในวิซาร์ด" })).toBeNull();
    expect(screen.getByRole("button", { name: "ทำสำเนา" })).toBeTruthy();
  });

  it("keeps a resumed draft wizard open while the new-brand route stays off", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} wizardRoute={false} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} wizardRoute={false} />);
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "ตรวจและสร้าง" })).toBeTruthy();
  });

  it("replaces a resumed draft wizard with the new-brand wizard when the route enters /brands/new, and closes it on leaving", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} wizardRoute={false} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} wizardRoute />);
    await heading("ข้อมูลแบรนด์");
    expect((text("ชื่อแบรนด์")).value).toBe("");
    view.rerender(<BrandLifecycle me={employee} wizardRoute={false} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeNull());
  });

  it("closes a resumed draft wizard when Back moves the route to another brand", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_live" />);
    await screen.findByRole("heading", { name: "live.test" });
    // The row click moves the URL to the draft; the wizard then resumes that draft.
    fireEvent.click(screen.getByRole("button", { name: /maple.test/ }));
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_live" />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "live.test" })).toBeTruthy();
  });

  it("closes a resumed draft wizard when the route turns to /brands, and the draft stays selected", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} routeBrandId={null} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "maple.test" })).toBeTruthy();
  });

  it("opens the new-brand wizard in place of a resumed draft when the route turns to /brands/new", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} routeBrandId={null} wizardRoute />);
    await heading("ข้อมูลแบรนด์");
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
  });

  it("keeps a resumed draft wizard open while the route stays on its brand", async () => {
    hold({ contact: CONTACT, copy: {}, ads: {} });
    const view = render(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำต่อในวิซาร์ด" }));
    await heading("ตรวจและสร้าง");
    view.rerender(<BrandLifecycle me={employee} routeBrandId="brand_new" />);
    expect(screen.getByRole("region", { name: "วิซาร์ดแบรนด์ใหม่" })).toBeTruthy();
  });

  it("duplicates a brand with a new domain and opens the copy at the Brand step", async () => {
    routes.set("POST /api/brands/brand_live/duplicate", () => json({ ...draftBody({ name: "Copy Cash" }), duplicated_from: "brand_live" }, 201));
    hold({ contact: CONTACT, copy: {}, ads: {} });
    held.name = "Copy Cash";
    const onSelectBrand = vi.fn();
    render(<BrandLifecycle me={employee} onSelectBrand={onSelectBrand} />);
    await screen.findByRole("heading", { name: "maple.test" });
    fireEvent.click(screen.getByRole("button", { name: /live.test/ }));
    await screen.findByRole("heading", { name: "live.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำสำเนา" }));
    const dialog = await screen.findByRole("dialog", { name: "ทำสำเนาแบรนด์" });

    // A new domain is required and checked before anything is sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("โดเมน: จำเป็นต้องกรอก");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่" }), { target: { value: "www.copy.test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("ใช้โดเมนหลัก ไม่ใช่ www");
    expect(sent("POST", "/api/brands/brand_live/duplicate")).toHaveLength(0);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่" }), { target: { value: "copy.test" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "ชื่อแบรนด์ใหม่" }), { target: { value: "Copy Cash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา" }));
    await heading("ข้อมูลแบรนด์");
    expect(sent("POST", "/api/brands/brand_live/duplicate")[0]!.body).toEqual({ domain: "copy.test", name: "Copy Cash" });
    expect(text("ชื่อแบรนด์").value).toBe("Copy Cash");
    // The URL follows the copy, not the brand it was copied from.
    expect(onSelectBrand).toHaveBeenCalledWith("brand_new");
  });

  it("reports a taken domain in the duplicate dialog and keeps it open", async () => {
    routes.set("POST /api/brands/brand_live/duplicate", () => json({ error: "conflict", message: "Domain is already registered" }, 409));
    render(<BrandLifecycle me={employee} />);
    fireEvent.click(await screen.findByRole("button", { name: /live.test/ }));
    await screen.findByRole("heading", { name: "live.test" });
    fireEvent.click(screen.getByRole("button", { name: "ทำสำเนา" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "โดเมนใหม่" }), { target: { value: "live.test" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "ทำสำเนา" })); });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("โดเมนนี้ถูกใช้แล้ว");
  });
});

describe("wizard page layout", () => {
  const summary = () => within(screen.getByRole("complementary", { name: "สรุปแบรนด์" }));
  const row = (label: string) => summary().getByText(label).closest("li")!;

  it("heads the page with a back link, สร้างแบรนด์ใหม่ and ขั้นที่ n จาก 5, and the back link closes it", async () => {
    const { onClose } = setup();
    await screen.findByRole("textbox", { name: "ชื่อแบรนด์" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("สร้างแบรนด์ใหม่");
    expect(document.querySelector(".wizard-sub")!.textContent).toBe("ขั้นที่ 1 จาก 5");
    fireEvent.click(screen.getByRole("button", { name: "← กลับไปแบรนด์" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("numbers the pills, marks the current step, and turns a finished step into a button that goes back to it", async () => {
    setup();
    await fillBrand();
    const pills = () => [...document.querySelectorAll(".wizard-stepper > li")];
    expect(pills()[0]!.getAttribute("aria-current")).toBe("step");
    expect(pills()[1]!.querySelector("button")).toBeNull();
    next();
    await heading("เทมเพลต");
    expect(document.querySelector(".wizard-sub")!.textContent).toBe("ขั้นที่ 2 จาก 5");
    fireEvent.click(within(pills()[0] as HTMLElement).getByRole("button", { name: /ข้อมูลแบรนด์/ }));
    await heading("ข้อมูลแบรนด์");
    expect(text("ชื่อแบรนด์").value).toBe("Maple Cash");
  });

  it("fills the summary from the form as it is typed, with no list of API calls", async () => {
    setup();
    await screen.findByRole("textbox", { name: "ชื่อแบรนด์" });
    expect(row("ชื่อแบรนด์").getAttribute("data-filled")).toBe("false");
    fill("ชื่อแบรนด์", "Maple Cash");
    fill("โดเมน", "Maple.Test");
    expect(row("ชื่อแบรนด์").textContent).toContain("Maple Cash");
    expect(row("ชื่อแบรนด์").getAttribute("data-filled")).toBe("true");
    expect(row("โดเมน").textContent).toContain("Maple.Test");
    expect(summary().queryByText(/\/api\//)).toBeNull();
    expect(row("เทมเพลต").getAttribute("data-filled")).toBe("true");
  });

  it("says บันทึกร่างแล้ว after a Next saves the draft and clears it when the form changes", async () => {
    setup();
    await fillBrand();
    expect(screen.queryByText("บันทึกร่างแล้ว")).toBeNull();
    next();
    await heading("เทมเพลต");
    expect(screen.getByRole("status").textContent).toContain("บันทึกร่างแล้ว");
    fireEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
    await heading("ข้อมูลแบรนด์");
    fill("ชื่อแบรนด์", "Maple Cash Co");
    expect(screen.queryByText("บันทึกร่างแล้ว")).toBeNull();
  });
});

describe("wizard saved status and stepper while saving", () => {
  it("clears บันทึกร่างแล้ว when a brand colour is chosen or reset, because that change is not saved yet", async () => {
    const mapped = detail("tv-1");
    routes.set("GET /api/templates/tv-1", () => json({ ...mapped, template: { ...mapped.template, theme_vars: { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: [] } } }));
    setup();
    await fillBrand();
    next();
    await heading("เทมเพลต");
    expect(screen.getByRole("status").textContent).toContain("บันทึกร่างแล้ว");
    await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("สีหลัก"), { target: { value: "#112233" } });
    expect(screen.queryByText("บันทึกร่างแล้ว")).toBeNull();
    // Saving again shows it once more; going back to the template colours is an edit too.
    next();
    await heading("ข้อความ");
    expect(screen.getByRole("status").textContent).toContain("บันทึกร่างแล้ว");
    back();
    await heading("เทมเพลต");
    fireEvent.click(screen.getByRole("button", { name: "ใช้สีของเทมเพลต" }));
    expect(screen.queryByText("บันทึกร่างแล้ว")).toBeNull();
  });

  it("turns the finished-step buttons off while a save runs, and a late answer moves on from the step it started on", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setup();
    await fillBrand();
    next();
    await heading("เทมเพลต");
    // A changed template is its own PATCH. Hold it.
    routes.set("PATCH /api/brands/brand_new/draft", async (init) => {
      await gate;
      const body = JSON.parse(String(init?.body)) as { template_version_id?: string };
      held = { ...held, ...(body.template_version_id ? { template: body.template_version_id } : {}) };
      return json({ ...heldBody(), changed: [] });
    });
    fireEvent.click(screen.getByRole("button", { name: /Copperline/ }));
    next();
    const earlier = within(document.querySelector(".wizard-stepper")!).getByRole("button", { name: /ข้อมูลแบรนด์/ }) as HTMLButtonElement;
    await waitFor(() => expect(earlier.disabled).toBe(true));
    release();
    await heading("ข้อความ");
    expect(document.querySelector(".wizard-sub")!.textContent).toBe("ขั้นที่ 3 จาก 5");
    expect((within(document.querySelector(".wizard-stepper")!).getByRole("button", { name: /ข้อมูลแบรนด์/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
