import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesScreen } from "../src/client/screens/Templates";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const STAMP = "2026-10-17T00:00:00.000Z";
const SPA = "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.";
const summary = {
  template_version_id: "tv-bolt-1", template_id: "tpl-bolt", name: "Bolt Harbor", version: 1, status: "awaiting_approval",
  submitted_by_label: "Somchai (bolt.new)", created_at: STAMP, sealed_at: null,
};
const detail = {
  template: { ...summary, sha256: "a".repeat(64), sealed_by: null, text_defaults: { brand_name: "Harbor", title: "Harbor | Funding", description: "Check options." } },
  checks: [
    { check_name: "identity_scan", result: "pass", details: { similarity: { summary: "PASS: no sealed templates to compare against yet." } }, created_at: STAMP },
    { check_name: "lint", result: "pass", details: {}, created_at: STAMP },
  ],
  screenshots: { desktop: "/api/templates/tv-bolt-1/screenshots/desktop", mobile: null },
};

type Handler = (init?: RequestInit) => Response;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: unknown }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/templates", () => json({ templates: [summary] })],
    ["GET /api/templates/tv-bolt-1", () => json(detail)],
    ["POST /api/templates/tv-bolt-1/approve", () => json({ ok: true, template_version_id: "tv-bolt-1", sealed_by: "owner", sealed_at: STAMP, already_sealed: false })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Templates screen", () => {
  it("lists versions with their review status and shows the detail", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(await screen.findByText("Bolt Harbor"));
    expect(await screen.findByRole("img", { name: "ภาพหน้าจอ desktop (desktop screenshot)" })).toBeTruthy();
    expect(screen.getByText("ไม่มีภาพ mobile (No mobile screenshot)")).toBeTruthy();
    expect(screen.getByText(/PASS: no sealed templates/)).toBeTruthy();
    expect(screen.getByText("Harbor | Funding")).toBeTruthy();
    expect(screen.getAllByText("รออนุมัติ (Awaiting approval)").length).toBeGreaterThan(0);
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
    expect(await screen.findByText("อนุมัติแล้ว (Approved)")).toBeTruthy();
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/templates/tv-bolt-1/approve")).toBe(true);
  });

  it("opens the version named in the URL hash", async () => {
    window.location.hash = "#templates/tv-bolt-1";
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByText("Harbor | Funding")).toBeTruthy();
  });

  it("shows the list when the URL hash holds a malformed escape", async () => {
    window.location.hash = "#templates/%";
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByText("Bolt Harbor")).toBeTruthy();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/templates"]);
    window.location.hash = "";
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
