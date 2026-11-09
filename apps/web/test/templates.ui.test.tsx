import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { TemplatesScreen } from "../src/client/screens/Templates";
import { strToU8, zipSync } from "fflate";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const STAMP = "2026-10-17T00:00:00.000Z";
const SPA = "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.";
const summary = {
  template_version_id: "tv-bolt-1", template_id: "tpl-bolt", name: "Bolt Harbor", version: 1, status: "awaiting_approval",
  submitted_by_label: "Somchai (bolt.new)", created_at: STAMP, sealed_at: null,
  thumbnail_url: "/api/templates/tv-bolt-1/screenshots/desktop", brands_using: 3,
};
const detail = {
  template: { ...summary, sha256: "a".repeat(64), sealed_by: null, text_defaults: { brand_name: "Harbor", title: "Harbor | Funding", description: "Check options." }, theme_vars: null },
  checks: [
    { check_name: "identity_scan", result: "pass", details: { similarity: { summary: "PASS: no sealed templates to compare against yet." } }, created_at: STAMP },
    { check_name: "lint", result: "pass", details: {}, created_at: STAMP },
  ],
  screenshots: { desktop: "/api/templates/tv-bolt-1/screenshots/desktop", mobile: null },
};

const detail2 = { ...detail, template: { ...detail.template, template_version_id: "tv-bolt-2", version: 2, text_defaults: { ...detail.template.text_defaults, title: "Marina | Funding" } } };
// jsdom also fires its own async hashchange; the manual dispatch makes the event deterministic.
const goTo = (hash: string) => act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

type Handler = (init?: RequestInit) => Response;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: unknown }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates?include_archived=1", () => json({ templates: [summary] })],
    ["GET /api/templates/tv-bolt-1", () => json(detail)],
    ["POST /api/templates/tv-bolt-1/approve", () => json({ ok: true, template_version_id: "tv-bolt-1", sealed_by: "owner", sealed_at: STAMP, already_sealed: false })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Templates screen", () => {
  const zipFile = (entries: Record<string, string>) => {
    const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])));
    const file = new File([new Uint8Array(bytes)], "site.zip", { type: "application/zip" });
    // jsdom's File has no arrayBuffer; keep detection real and supply the browser method.
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array(bytes).buffer });
    return file;
  };

  it("shows screenshot cards, status and brands-using count", async () => {
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByRole("img", { name: "ตัวอย่าง Bolt Harbor (Template preview)" })).toBeTruthy();
    expect(screen.getByText("แบรนด์ที่ใช้ (Brands using): 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bolt Harbor/, pressed: false }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it.each([
    ["astro", { "dist/index.html": "<h1>Hello</h1>", "dist/_astro/site.css": "h1{}" }],
    ["bolt_static", { "index.html": "<h1>Hello</h1>" }],
    ["vite_react", { "index.html": '<script type="module" src="/assets/index.js"></script>', "assets/index.js": "built" }],
  ] as const)("renders detected type %s before upload", async (type, entries) => {
    render(<TemplatesScreen me={employee} />);
    fireEvent.change(screen.getByLabelText("ไฟล์ ZIP (ZIP file)"), { target: { files: [zipFile(entries)] } });
    expect(await screen.findByText(`ชนิดที่ตรวจพบ (Detected type): ${type}`)).toBeTruthy();
    expect(requests.some((r) => r.path === "/api/templates/import-zip")).toBe(false);
  });

  it("generates an editable slug and sends the ZIP as multipart", async () => {
    routes.set("POST /api/templates/import-zip", () => json({
      status: "duplicate", template_version_id: "tv-bolt-1", version: 1, sha256: "a".repeat(64), dashboard_url: null,
      issues: [], warnings: [], text_defaults: null, similarity: null, next_step: "Already submitted.",
    }));
    render(<TemplatesScreen me={employee} />);
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต ZIP (ZIP template name)"), { target: { value: "Harbor Funding" } });
    const id = screen.getByLabelText("รหัสเทมเพลต (Template ID)") as HTMLInputElement;
    expect(id.value).toBe("harbor-funding");
    fireEvent.change(id, { target: { value: "my-custom-id" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต ZIP (ZIP template name)"), { target: { value: "Harbor New" } });
    expect(id.value).toBe("my-custom-id");
    fireEvent.change(screen.getByLabelText("ไฟล์ ZIP (ZIP file)"), { target: { files: [zipFile({ "index.html": "<h1>Hello</h1>" })] } });
    await screen.findByText("ชนิดที่ตรวจพบ (Detected type): bolt_static");
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า ZIP (Import ZIP)" }));
    expect(await screen.findByText("ซ้ำกับเวอร์ชันเดิม (Duplicate)")).toBeTruthy();
    const body = requests.find((r) => r.path === "/api/templates/import-zip")!.body as FormData;
    expect(body.get("template_id")).toBe("my-custom-id");
    expect(body.get("template_name")).toBe("Harbor New");
    expect((body.get("file") as File).name).toBe("site.zip");
  });

  it("rejects a source project locally and disables upload", async () => {
    render(<TemplatesScreen me={employee} />);
    fireEvent.change(screen.getByLabelText("ไฟล์ ZIP (ZIP file)"), { target: { files: [zipFile({ "package.json": "{}", "src/main.tsx": "source" })] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "อัปโหลดโฟลเดอร์ dist ที่ build แล้ว (Upload the built dist folder)");
    expect(screen.getByRole("button", { name: "นำเข้า ZIP (Import ZIP)" })).toHaveProperty("disabled", true);
    expect(requests.some((r) => r.path === "/api/templates/import-zip")).toBe(false);
  });

  it("ignores a previous file's detection after selection changes", async () => {
    let finish!: (buffer: ArrayBuffer) => void;
    const oldBytes = zipSync({ "index.html": strToU8("<h1>Old</h1>") });
    const delayed = new File(["pending"], "old.zip");
    Object.defineProperty(delayed, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }) });
    render(<TemplatesScreen me={employee} />);
    fireEvent.change(screen.getByLabelText("ไฟล์ ZIP (ZIP file)"), { target: { files: [delayed] } });
    fireEvent.change(screen.getByLabelText("ไฟล์ ZIP (ZIP file)"), { target: { files: [zipFile({ "index.html": "<h1>New</h1>", "_astro/new.css": "h1{}" })] } });
    await screen.findByText("ชนิดที่ตรวจพบ (Detected type): astro");
    await act(async () => { finish(new Uint8Array(oldBytes).buffer); });
    expect(screen.getByText("ชนิดที่ตรวจพบ (Detected type): astro")).toBeTruthy();
  });

  it("lists versions with their review status and shows the detail", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    expect(await screen.findByRole("img", { name: "ภาพหน้าจอ desktop (desktop screenshot)" })).toBeTruthy();
    expect(screen.getByText("ไม่มีภาพ mobile (No mobile screenshot)")).toBeTruthy();
    expect(screen.getByText(/PASS: no sealed templates/)).toBeTruthy();
    expect(screen.getByText("Harbor | Funding")).toBeTruthy();
    expect(screen.getAllByText("รออนุมัติ").length).toBeGreaterThan(0);
  });

  it("shows stored lint, similarity and screenshot warnings in yellow", async () => {
    const warning = (rule: string, message: string) => ({ rule, message, fix: "Review with the owner." });
    routes.set("GET /api/templates/tv-bolt-1", () => json({ ...detail, checks: [
      { check_name: "lint", result: "pass", details: { warning_issues: [warning("pii", "Email input advisory.")], import_warnings: [warning("host-badge", "Host badge removed.")] }, created_at: STAMP },
      { check_name: "identity_scan", result: "fail", details: { warning_issues: [warning("similarity", "Similar layout.")] }, created_at: STAMP },
      { check_name: "screenshot_mobile", result: "fail", details: { warning_issues: [warning("screenshot_mobile", "Mobile screenshot unavailable.")] }, created_at: STAMP },
    ] }));
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    const warnings = await screen.findByRole("note", { name: "คำเตือน (Warnings)" });
    expect(warnings.classList.contains("note")).toBe(true);
    for (const message of ["Email input advisory.", "Host badge removed.", "Similar layout.", "Mobile screenshot unavailable."]) expect(warnings.textContent).toContain(message);
    expect(screen.getAllByText("คำเตือน (Warning)")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "อนุมัติ (Approve)" })).toBeTruthy();
  });

  it("keeps failed blocking checks red", async () => {
    routes.set("GET /api/templates/tv-bolt-1", () => json({ ...detail, template: { ...detail.template, status: "rejected" }, checks: [
      { check_name: "lint", result: "fail", details: { warning_issues: [{ rule: "pii", message: "Email advisory.", fix: "Review." }] }, created_at: STAMP },
    ] }));
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    expect((await screen.findByText("fail")).classList.contains("p-bad")).toBe(true);
    expect(screen.queryByRole("button", { name: "อนุมัติ (Approve)" })).toBeNull();
  });

  it("lets an owner approve and hides Approve from an employee", async () => {
    const first = render(<TemplatesScreen me={employee} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    await screen.findByText("Harbor | Funding");
    expect(screen.queryByRole("button", { name: "อนุมัติ (Approve)" })).toBeNull();
    first.unmount();
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    fireEvent.click(await screen.findByRole("button", { name: "อนุมัติ (Approve)" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "อนุมัติ (Approve)" }));
    expect(await screen.findByText("อนุมัติแล้ว (Approved)")).toBeTruthy();
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/templates/tv-bolt-1/approve")).toBe(true);
  });

  const approveRequests = () => requests.filter((r) => r.method === "POST" && r.path === "/api/templates/tv-bolt-1/approve");

  it("Approve asks for confirmation before calling the API", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "อนุมัติ Bolt Harbor v1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("อนุมัติเทมเพลต (Approve template)?")).toBeTruthy();
    expect(dialog.textContent).toContain("Bolt Harbor");
    expect(dialog.textContent).toContain("v1");
    expect(approveRequests()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "อนุมัติ (Approve)" }));
    await waitFor(() => expect(approveRequests()).toHaveLength(1));
    expect(await screen.findByText("อนุมัติแล้ว (Approved)")).toBeTruthy();
  });

  it("cancelling the Approve confirm sends no request", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByRole("button", { name: "อนุมัติ Bolt Harbor v1" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /ยกเลิก|Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(approveRequests()).toHaveLength(0);
    expect(screen.queryByText("อนุมัติแล้ว (Approved)")).toBeNull();
  });

  it("the detail Approve button also confirms", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    fireEvent.click(await screen.findByRole("button", { name: "อนุมัติ (Approve)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(approveRequests()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "อนุมัติ (Approve)" }));
    await waitFor(() => expect(approveRequests()).toHaveLength(1));
  });

  it("hides the card Approve while that version's detail is open", async () => {
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByRole("button", { name: "อนุมัติ Bolt Harbor v1" })).toBeTruthy();
    fireEvent.click(screen.getByText("Bolt Harbor"));
    await screen.findByText("Harbor | Funding");
    expect(screen.queryByRole("button", { name: "อนุมัติ Bolt Harbor v1" })).toBeNull();
    expect(screen.getByRole("button", { name: "อนุมัติ (Approve)" })).toBeTruthy();
  });

  it("screen shows the detected map", async () => {
    const themeVars = { primary: ["--brand", "--accent"], primary_dark: ["--brand-dark"], secondary: [] };
    routes.set("GET /api/templates/tv-bolt-1", () => json({ ...detail, template: { ...detail.template, theme_vars: themeVars } }));
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    const primary = await screen.findByLabelText("สีหลัก") as HTMLInputElement;
    expect(primary.value).toBe("--brand, --accent");
    expect((screen.getByLabelText("สีหลักเข้ม") as HTMLInputElement).value).toBe("--brand-dark");
    expect((screen.getByLabelText("สีรอง") as HTMLInputElement).value).toBe("");
    fireEvent.change(primary, { target: { value: "--brand, --hero" } });
    fireEvent.click(screen.getByRole("button", { name: "อนุมัติ (Approve)" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "อนุมัติ (Approve)" }));
    expect(await screen.findByText("อนุมัติแล้ว (Approved)")).toBeTruthy();
    const post = requests.find((r) => r.method === "POST" && r.path === "/api/templates/tv-bolt-1/approve");
    expect(post?.body).toEqual({ theme_vars: { primary: ["--brand", "--hero"], primary_dark: ["--brand-dark"], secondary: [] } });
  });

  it("blocks Approve on an invalid variable name", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    fireEvent.change(await screen.findByLabelText("สีรอง"), { target: { value: "color: red" } });
    fireEvent.click(screen.getByRole("button", { name: "อนุมัติ (Approve)" }));
    expect(await screen.findByText(/ชื่อตัวแปรไม่ถูกต้อง/)).toBeTruthy();
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("opens the version named by the selected id", async () => {
    render(<TemplatesScreen me={owner} selectedId="tv-bolt-1" onSelect={() => undefined} />);
    expect(await screen.findByText("Harbor | Funding")).toBeTruthy();
  });

  it("opens the version when the selected id changes after mount", async () => {
    const view = render(<TemplatesScreen me={owner} selectedId={null} onSelect={() => undefined} />);
    await screen.findByText("Bolt Harbor");
    expect(screen.queryByText("Harbor | Funding")).toBeNull();
    view.rerender(<TemplatesScreen me={owner} selectedId="tv-bolt-1" onSelect={() => undefined} />);
    expect(await screen.findByText("Harbor | Funding")).toBeTruthy();
  });

  it("switches to another version when the selected id changes between versions", async () => {
    routes.set("GET /api/templates/tv-bolt-2", () => json(detail2));
    const view = render(<TemplatesScreen me={owner} selectedId="tv-bolt-1" onSelect={() => undefined} />);
    await screen.findByText("Harbor | Funding");
    view.rerender(<TemplatesScreen me={owner} selectedId="tv-bolt-2" onSelect={() => undefined} />);
    expect(await screen.findByText("Marina | Funding")).toBeTruthy();
    expect(screen.queryByText("Harbor | Funding")).toBeNull();
  });

  it("shows the list when no id is selected", async () => {
    render(<TemplatesScreen me={owner} selectedId={null} onSelect={() => undefined} />);
    expect(await screen.findByText("Bolt Harbor")).toBeTruthy();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/templates?include_archived=1"]);
  });

  it("reports a card click through onSelect and keeps the URL in charge of the selection", async () => {
    const onSelect = vi.fn();
    render(<TemplatesScreen me={owner} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    expect(onSelect).toHaveBeenCalledWith("tv-bolt-1");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/templates?include_archived=1"]);
  });

  it("imports from a URL and shows the static HTML instruction on rejection", async () => {
    routes.set("POST /api/templates/import", () => json({
      status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [{ rule: "static-html", file: "index.html", message: SPA, fix: "Prerender." }],
      warnings: [], text_defaults: null, similarity: null, next_step: SPA,
    }));
    render(<TemplatesScreen me={employee} />);
    await screen.findByText("Bolt Harbor");
    fireEvent.change(screen.getByLabelText("URL ของเว็บที่เผยแพร่ (Published URL)"), { target: { value: "https://harbor.example.com/" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต (Template name)"), { target: { value: "Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า (Import)" }));
    expect((await screen.findAllByText(SPA)).length).toBeGreaterThan(0);
    expect(requests.find((r) => r.path === "/api/templates/import")?.body).toEqual({ url: "https://harbor.example.com/", template_name: "Harbor" });
  });

  it("shows the fix text for each rejected issue", async () => {
    routes.set("POST /api/templates/import", () => json({
      status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [{ rule: "static-html", file: "index.html", message: "Page is empty.", fix: "Prerender the page to static HTML." }],
      warnings: [], text_defaults: null, similarity: null, next_step: SPA,
    }));
    render(<TemplatesScreen me={employee} />);
    await screen.findByText("Bolt Harbor");
    fireEvent.change(screen.getByLabelText("URL ของเว็บที่เผยแพร่ (Published URL)"), { target: { value: "https://harbor.example.com/" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต (Template name)"), { target: { value: "Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า (Import)" }));
    expect(await screen.findByText("Prerender the page to static HTML.")).toBeTruthy();
  });

  it("shows warnings returned from a duplicate import", async () => {
    routes.set("POST /api/templates/import", () => json({
      status: "duplicate", template_version_id: null, version: null, sha256: null, dashboard_url: null,
      issues: [], warnings: [{ rule: "similarity", message: "Similar copy needs review.", fix: "Discuss the copy." }],
      text_defaults: null, similarity: null, next_step: "Already submitted.",
    }));
    render(<TemplatesScreen me={employee} />);
    await screen.findByText("Bolt Harbor");
    fireEvent.change(screen.getByLabelText("URL ของเว็บที่เผยแพร่ (Published URL)"), { target: { value: "https://harbor.example.com/" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต (Template name)"), { target: { value: "Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า (Import)" }));
    const warnings = await screen.findByRole("note", { name: "คำเตือน (Warnings)" });
    expect(warnings.classList.contains("note")).toBe(true);
    expect(warnings.textContent).toContain("Similar copy needs review.");
    expect(warnings.textContent).toContain("Discuss the copy.");
  });

  it("shows the bad_url message from a 422", async () => {
    routes.set("POST /api/templates/import", () => json({ error: "bad_url", message: "Only public https URLs are accepted." }, 422));
    render(<TemplatesScreen me={employee} />);
    await screen.findByText("Bolt Harbor");
    fireEvent.change(screen.getByLabelText("URL ของเว็บที่เผยแพร่ (Published URL)"), { target: { value: "http://10.0.0.1/" } });
    fireEvent.change(screen.getByLabelText("ชื่อเทมเพลต (Template name)"), { target: { value: "Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "นำเข้า (Import)" }));
    expect(await screen.findByText("Only public https URLs are accepted.")).toBeTruthy();
  });
});

describe("App deep link", () => {
  it("switches from Brands to Templates when the hash changes to #templates/<id>", async () => {
    routes.set("GET /api/me", () => json({ user: owner }));
    routes.set("GET /api/lifecycle/brands", () => json({ brands: [] }));
    routes.set("GET /api/brands", () => json({ brands: [], generated_at: STAMP }));
    routes.set("GET /api/templates/sealed", () => json({ templates: [] }));
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: /^แบรนด์$/ }));
    expect(await screen.findByRole("heading", { name: "แบรนด์" })).toBeTruthy();
    await goTo("#other");
    expect(screen.queryByRole("heading", { name: "เทมเพลต (Templates)" })).toBeNull();
    await goTo("#templates/tv-bolt-1");
    expect(await screen.findByRole("heading", { name: "เทมเพลต (Templates)" })).toBeTruthy();
    expect(await screen.findByText("Harbor | Funding")).toBeTruthy();
    expect(window.location.pathname).toBe("/templates/tv-bolt-1");
    expect(screen.queryByRole("heading", { name: "แบรนด์" })).toBeNull();
  });

  describe("theme vars", () => {
    const sealedSummary = { ...summary, status: "approved", sealed_at: STAMP };
    const sealedDetail = (themeVars: unknown) => ({ ...detail, template: { ...detail.template, status: "approved", sealed_at: STAMP, sealed_by: "owner", theme_vars: themeVars } });
    const empty = { primary: [], primary_dark: [], secondary: [] };
    const found = { primary: ["--color-royal"], primary_dark: [], secondary: ["--color-sand"] };
    const open = async (me: typeof owner | typeof employee) => {
      render(<TemplatesScreen me={me} />);
      fireEvent.click(await screen.findByText("Bolt Harbor"));
      await screen.findByText("Harbor | Funding");
    };

    it("owner detects colors on a sealed version and saves the map", async () => {
      let saved: unknown = null;
      routes.set("GET /api/templates?include_archived=1", () => json({ templates: [sealedSummary] }));
      routes.set("GET /api/templates/tv-bolt-1", () => json(sealedDetail(saved)));
      routes.set("POST /api/templates/tv-bolt-1/detect-theme-vars", () => json({ template_version_id: "tv-bolt-1", theme_vars: found }));
      routes.set("PUT /api/templates/tv-bolt-1/theme-vars", (init) => { saved = JSON.parse(String(init?.body)).theme_vars; return json({ template_version_id: "tv-bolt-1", theme_vars: saved }); });
      await open(owner);
      fireEvent.click(screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }));
      await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("--color-royal"));
      expect((screen.getByLabelText("สีรอง") as HTMLInputElement).value).toBe("--color-sand");
      fireEvent.click(screen.getByRole("button", { name: "บันทึกแผนที่สี (Save color map)" }));
      expect(await screen.findByText("บันทึกแล้ว Redeploy แบรนด์เพื่อให้สีมีผล (Saved. Redeploy brands to apply)")).toBeTruthy();
      expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ theme_vars: found });
      expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("--color-royal");
      // The saved-map ledger shows the reloaded map above the inputs.
      expect(screen.getByText("--color-royal")).toBeTruthy();
      expect(screen.getByText("--color-sand")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "อนุมัติ (Approve)" })).toBeNull();
    });

    it("save note shows even when the reload fails", async () => {
      let saved = false;
      routes.set("GET /api/templates?include_archived=1", () => json({ templates: [sealedSummary] }));
      routes.set("GET /api/templates/tv-bolt-1", () => (saved ? json({ error: "reload_failed" }, 500) : json(sealedDetail(null))));
      routes.set("PUT /api/templates/tv-bolt-1/theme-vars", () => { saved = true; return json({ template_version_id: "tv-bolt-1", theme_vars: found }); });
      await open(owner);
      fireEvent.change(screen.getByLabelText("สีหลัก"), { target: { value: "--color-royal" } });
      fireEvent.click(screen.getByRole("button", { name: "บันทึกแผนที่สี (Save color map)" }));
      expect(await screen.findByText("บันทึกแล้ว Redeploy แบรนด์เพื่อให้สีมีผล (Saved. Redeploy brands to apply)")).toBeTruthy();
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.getByText("บันทึกแล้ว Redeploy แบรนด์เพื่อให้สีมีผล (Saved. Redeploy brands to apply)")).toBeTruthy();
    });

    it("detect with no variables clears filled inputs", async () => {
      routes.set("GET /api/templates?include_archived=1", () => json({ templates: [sealedSummary] }));
      routes.set("GET /api/templates/tv-bolt-1", () => json(sealedDetail(found)));
      routes.set("POST /api/templates/tv-bolt-1/detect-theme-vars", () => json({ template_version_id: "tv-bolt-1", theme_vars: empty }));
      await open(owner);
      expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("--color-royal");
      fireEvent.click(screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }));
      expect(await screen.findByText("ไม่พบตัวแปรสี (No color variables found)")).toBeTruthy();
      for (const label of ["สีหลัก", "สีหลักเข้ม", "สีรอง"]) {
        expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
      }
    });

    it("approve is disabled while detect is pending", async () => {
      routes.set("POST /api/templates/tv-bolt-1/detect-theme-vars", () => new Promise<Response>(() => {}) as unknown as Response);
      await open(owner);
      const approve = screen.getByRole("button", { name: "อนุมัติ (Approve)" }) as HTMLButtonElement;
      expect(approve.disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }));
      await waitFor(() => expect(approve.disabled).toBe(true));
      expect((screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("opening another template resets the color inputs", async () => {
      const second = { ...sealedSummary, template_version_id: "tv-bolt-2", name: "Bolt Marina", version: 2 };
      routes.set("GET /api/templates?include_archived=1", () => json({ templates: [sealedSummary, second] }));
      routes.set("GET /api/templates/tv-bolt-1", () => json(sealedDetail(null)));
      routes.set("GET /api/templates/tv-bolt-2", () => json({ ...detail2, template: { ...sealedDetail(null).template, template_version_id: "tv-bolt-2", version: 2, text_defaults: detail2.template.text_defaults } }));
      routes.set("POST /api/templates/tv-bolt-1/detect-theme-vars", () => json({ template_version_id: "tv-bolt-1", theme_vars: found }));
      await open(owner);
      fireEvent.click(screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }));
      await waitFor(() => expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("--color-royal"));
      fireEvent.click(screen.getByText("Bolt Marina"));
      await screen.findByText("Marina | Funding");
      expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("");
      expect((screen.getByLabelText("สีรอง") as HTMLInputElement).value).toBe("");
    });

    it("detect with no variables shows the empty note", async () => {
      routes.set("POST /api/templates/tv-bolt-1/detect-theme-vars", () => json({ template_version_id: "tv-bolt-1", theme_vars: empty }));
      await open(owner);
      fireEvent.click(screen.getByRole("button", { name: "ตรวจหาสี (Detect colors)" }));
      expect(await screen.findByText("ไม่พบตัวแปรสี (No color variables found)")).toBeTruthy();
      expect((screen.getByLabelText("สีหลัก") as HTMLInputElement).value).toBe("");
      expect(screen.queryByRole("button", { name: "บันทึกแผนที่สี (Save color map)" })).toBeNull();
    });

    it("employee sees no detect button", async () => {
      routes.set("GET /api/templates/tv-bolt-1", () => json(sealedDetail(found)));
      await open(employee);
      expect(screen.queryByRole("button", { name: "ตรวจหาสี (Detect colors)" })).toBeNull();
      expect(screen.queryByRole("button", { name: "บันทึกแผนที่สี (Save color map)" })).toBeNull();
    });
  });
});
