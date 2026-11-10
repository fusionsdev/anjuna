import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesScreen } from "../src/client/screens/Templates";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };
const STAMP = "2026-11-01T00:00:00.000Z";
const LIST = "GET /api/templates?include_archived=1";

const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  // A template that was never approved by default, so the delete rule only blocks what a test sets up.
  template_version_id: `tv-${id}`, template_id: `tpl-${id}`, name, version: 1, status: "awaiting_approval",
  submitted_by_label: "Somchai", created_at: STAMP, sealed_at: null, thumbnail_url: null, brands_using: 0, archived: false, category_id: null, was_approved: false, ...over,
});
const categories = [{ id: "cat-loan", name: "เงินกู้", sort: 1 }, { id: "cat-card", name: "บัตรเครดิต", sort: 2 }];

type Handler = (init?: RequestInit) => Response;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string; body: unknown }>;
let templates: Array<ReturnType<typeof summary>>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls = (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path);

beforeEach(() => {
  requests = [];
  templates = [
    summary("a", "Alpha", { category_id: "cat-loan" }),
    summary("b", "Bravo", { category_id: "cat-card" }),
    summary("c", "Charlie", { archived: true }),
  ];
  routes = new Map<string, Handler>([[LIST, () => json({ templates, categories })]]);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const bulk = () => within(screen.getByRole("toolbar", { name: "จัดการเทมเพลตที่เลือก" }));
const check = (label: string) => fireEvent.click(screen.getByRole("checkbox", { name: label }));
const confirmDialog = async (label: string) => fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: label }));

describe("template manager: categories", () => {
  it("filters the list by category and keeps archived templates out of every category view", async () => {
    render(<TemplatesScreen me={owner} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("Charlie")).toBeNull();

    const nav = screen.getByRole("navigation", { name: "หมวดเทมเพลต" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["ทุกหมวด2", "เงินกู้1", "บัตรเครดิต1", "เพิ่มหมวด"]);
    fireEvent.click(within(nav).getByRole("button", { name: /^เงินกู้/ }));
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();

    const chips = screen.getByRole("group", { name: "กรองสถานะเทมเพลต" });
    fireEvent.click(within(chips).getByRole("button", { name: /^เก็บถาวร/ }));
    expect(await screen.findByText("ไม่มีเทมเพลตในมุมมองนี้")).toBeTruthy();
    fireEvent.click(within(nav).getByRole("button", { name: /^ทุกหมวด/ }));
    expect(screen.getByText("Charlie")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();

    fireEvent.click(within(chips).getByRole("button", { name: /^ทุกสถานะ/ }));
    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("Charlie")).toBeNull();
  });

  it("sends the chosen category for the template, then reloads", async () => {
    routes.set("PATCH /api/templates/tpl-b/category", () => json({ template_id: "tpl-b", category_id: "cat-loan" }));
    render(<TemplatesScreen me={owner} />);
    fireEvent.change(await screen.findByLabelText("หมวดของ Bravo"), { target: { value: "cat-loan" } });
    await screen.findByText("บันทึกหมวดแล้ว");
    expect(calls("PATCH", "/api/templates/tpl-b/category")[0]!.body).toEqual({ category_id: "cat-loan" });
    expect(calls("GET", "/api/templates?include_archived=1")).toHaveLength(2);
  });

  it("sends null when the owner clears the category", async () => {
    routes.set("PATCH /api/templates/tpl-a/category", () => json({ template_id: "tpl-a", category_id: null }));
    render(<TemplatesScreen me={owner} />);
    fireEvent.change(await screen.findByLabelText("หมวดของ Alpha"), { target: { value: "" } });
    await screen.findByText("บันทึกหมวดแล้ว");
    expect(calls("PATCH", "/api/templates/tpl-a/category")[0]!.body).toEqual({ category_id: null });
  });

  it("creates a category from the owner's field and clears the field", async () => {
    routes.set("POST /api/templates/categories", () => json({ category: { id: "cat-new", name: "สินเชื่อบ้าน", sort: 3 } }, 201));
    render(<TemplatesScreen me={owner} />);
    const field = (await screen.findByLabelText("ชื่อหมวดใหม่")) as HTMLInputElement;
    const add = screen.getByRole("button", { name: "เพิ่มหมวด" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "  สินเชื่อบ้าน " } });
    fireEvent.click(add);
    await screen.findByText("เพิ่มหมวด สินเชื่อบ้าน แล้ว");
    expect(calls("POST", "/api/templates/categories")[0]!.body).toEqual({ name: "สินเชื่อบ้าน" });
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("shows the Thai reason for a duplicate category name and keeps the typed name", async () => {
    routes.set("POST /api/templates/categories", () => json({ error: "category_exists" }, 409));
    render(<TemplatesScreen me={owner} />);
    const field = (await screen.findByLabelText("ชื่อหมวดใหม่")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "เงินกู้" } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มหมวด" }));
    expect(await screen.findByText("มีหมวดชื่อนี้อยู่แล้ว")).toBeTruthy();
    expect(field.value).toBe("เงินกู้");
  });

  it("gives an employee the category names only: no picker, no add field, no archive, no delete", async () => {
    render(<TemplatesScreen me={employee} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByLabelText("หมวดของ Alpha")).toBeNull();
    expect(screen.queryByLabelText("ชื่อหมวดใหม่")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    // The category name is visible in the row as a label, besides the list entry.
    expect(screen.getAllByText("เงินกู้").length).toBe(2);
  });
});

describe("template manager: bulk bar, archive and delete", () => {
  it("shows the bulk bar for checked rows and moves them to a category", async () => {
    routes.set("PATCH /api/templates/tpl-a/category", () => json({ template_id: "tpl-a", category_id: "cat-card" }));
    routes.set("PATCH /api/templates/tpl-b/category", () => json({ template_id: "tpl-b", category_id: "cat-card" }));
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    expect(screen.queryByRole("toolbar")).toBeNull();
    check("เลือก Alpha v1");
    check("เลือก Bravo v1");
    expect(screen.getByText("เลือก 2 รายการ")).toBeTruthy();
    fireEvent.change(bulk().getByLabelText("ย้ายไปหมวด"), { target: { value: "cat-card" } });
    expect(await screen.findByText("ย้าย 2 รายการแล้ว")).toBeTruthy();
    expect(calls("PATCH", "/api/templates/tpl-a/category")[0]!.body).toEqual({ category_id: "cat-card" });
    expect(calls("PATCH", "/api/templates/tpl-b/category")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  });

  it("archives only after the owner confirms", async () => {
    routes.set("POST /api/templates/tpl-a/archive", () => json({ ok: true, template_id: "tpl-a", archived_at: STAMP }));
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Alpha v1");
    fireEvent.click(bulk().getByRole("button", { name: "เก็บถาวร" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/แบรนด์ที่ใช้อยู่ยังทำงานต่อ/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก (Cancel)" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("POST", "/api/templates/tpl-a/archive")).toHaveLength(0);

    fireEvent.click(bulk().getByRole("button", { name: "เก็บถาวร" }));
    await confirmDialog("เก็บถาวร");
    expect(await screen.findByText("เก็บ Alpha เข้าคลังแล้ว")).toBeTruthy();
    expect(calls("POST", "/api/templates/tpl-a/archive")).toHaveLength(1);
  });

  it("deletes after confirmation and reloads the list", async () => {
    routes.set("DELETE /api/templates/tpl-a", () => new Response(null, { status: 204 }));
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Alpha v1");
    fireEvent.click(bulk().getByRole("button", { name: "ลบ" }));
    expect(calls("DELETE", "/api/templates/tpl-a")).toHaveLength(0);
    await confirmDialog("ลบ");
    expect(await screen.findByText("ลบ Alpha แล้ว")).toBeTruthy();
    expect(calls("DELETE", "/api/templates/tpl-a")).toHaveLength(1);
    expect(calls("GET", "/api/templates?include_archived=1")).toHaveLength(2);
  });

  it("disables delete with the reason while a selected template is used by a brand", async () => {
    templates = [summary("a", "Alpha", { brands_using: 2 }), summary("b", "Bravo")];
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Bravo v1");
    expect((bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement).disabled).toBe(false);
    check("เลือก Alpha v1");
    expect((bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement).disabled).toBe(true);
    expect(bulk().getByText("มีเทมเพลตที่แบรนด์ใช้อยู่ ลบไม่ได้ ใช้เก็บถาวรแทน")).toBeTruthy();
    expect((bulk().getByRole("button", { name: "เก็บถาวร" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables delete for an approved version with no brand, and for a draft whose sibling version was approved", async () => {
    templates = [
      summary("a", "Alpha", { status: "approved", sealed_at: STAMP, was_approved: true }),
      summary("b", "Bravo", { was_approved: true }),
      summary("b2", "Bravo", { template_id: "tpl-b", version: 2, status: "approved", sealed_at: STAMP, was_approved: true }),
      summary("d", "Delta"),
    ];
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    const del = () => bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement;
    // A never approved template with no brand can go.
    check("เลือก Delta v1");
    expect(del().disabled).toBe(false);
    // An approved version with zero brands is blocked, with the live reason.
    check("เลือก Alpha v1");
    expect(del().disabled).toBe(true);
    expect(bulk().getByText("มีเทมเพลตที่เคยอนุมัติแล้ว ลบไม่ได้ ใช้เก็บถาวรแทน")).toBeTruthy();
    check("เลือก Alpha v1");
    expect(del().disabled).toBe(false);
    // Bravo v1 was never approved itself, but version 2 of the same template was: delete removes every version, so it is blocked.
    check("เลือก Bravo v1");
    expect(del().disabled).toBe(true);
    expect(bulk().getByText("มีเทมเพลตที่เคยอนุมัติแล้ว ลบไม่ได้ ใช้เก็บถาวรแทน")).toBeTruthy();
    expect((bulk().getByRole("button", { name: "เก็บถาวร" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables delete for a draft whose approved version is not in the loaded list, and not for a draft the server says was never approved", async () => {
    // The list holds the newest 200 versions. Here the approved version of tpl-b is cut from it: only its was_approved flag says so.
    templates = [summary("b", "Bravo", { was_approved: true }), summary("d", "Delta")];
    expect(templates.some((t) => t.status === "approved" || t.sealed_at !== null)).toBe(false);
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Bravo");
    const del = () => bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement;
    check("เลือก Delta v1");
    expect(del().disabled).toBe(false);
    check("เลือก Bravo v1");
    expect(del().disabled).toBe(true);
    expect(bulk().getByText("มีเทมเพลตที่เคยอนุมัติแล้ว ลบไม่ได้ ใช้เก็บถาวรแทน")).toBeTruthy();
    check("เลือก Delta v1");
    expect(del().disabled).toBe(true);
    expect(calls("DELETE", "/api/templates/tpl-b")).toHaveLength(0);
  });

  it("names both reasons when a selected template is in use and was approved", async () => {
    templates = [summary("a", "Alpha", { status: "approved", sealed_at: STAMP, brands_using: 1 }), summary("b", "Bravo")];
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Alpha v1");
    expect(bulk().getByText("มีแบรนด์ใช้อยู่และเคยอนุมัติแล้ว ลบไม่ได้ ใช้เก็บถาวรแทน")).toBeTruthy();
    expect((bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["template_in_use", "ลบไม่ได้ เพราะมีแบรนด์ใช้เทมเพลตนี้อยู่"],
    ["template_was_approved", "ลบไม่ได้ เพราะเทมเพลตนี้เคยอนุมัติแล้ว"],
  ])("shows the Thai reason for a 409 %s and offers archive instead", async (error, reason) => {
    routes.set("DELETE /api/templates/tpl-a", () => json({ error }, 409));
    routes.set("POST /api/templates/tpl-a/archive", () => json({ ok: true, template_id: "tpl-a", archived_at: STAMP }));
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Alpha v1");
    fireEvent.click(bulk().getByRole("button", { name: "ลบ" }));
    await confirmDialog("ลบ");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(reason)).toBeTruthy();
    expect(calls("POST", "/api/templates/tpl-a/archive")).toHaveLength(0);

    fireEvent.click(within(alert).getByRole("button", { name: "เก็บถาวรแทน" }));
    await confirmDialog("เก็บถาวร");
    expect(await screen.findByText("เก็บ Alpha เข้าคลังแล้ว")).toBeTruthy();
    expect(calls("POST", "/api/templates/tpl-a/archive")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops a bulk delete at the first refusal and keeps the rest checked", async () => {
    routes.set("DELETE /api/templates/tpl-a", () => json({ error: "template_was_approved" }, 409));
    routes.set("DELETE /api/templates/tpl-b", () => new Response(null, { status: 204 }));
    render(<TemplatesScreen me={owner} />);
    await screen.findByText("Alpha");
    check("เลือก Alpha v1");
    check("เลือก Bravo v1");
    fireEvent.click(bulk().getByRole("button", { name: "ลบ" }));
    await confirmDialog("ลบ");
    expect(await screen.findByText("ลบไม่ได้ เพราะเทมเพลตนี้เคยอนุมัติแล้ว")).toBeTruthy();
    expect(calls("DELETE", "/api/templates/tpl-b")).toHaveLength(0);
    expect(bulk().getByText("เลือก 2 รายการ")).toBeTruthy();
  });

  it("marks an archived template, lists it under the archive chip and gives it no archive in the bulk bar", async () => {
    render(<TemplatesScreen me={owner} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "กรองสถานะเทมเพลต" })).getByRole("button", { name: /^เก็บถาวร/ }));
    const row = (await screen.findByText("Charlie")).closest("tr")!;
    expect(within(row).getByText("เก็บถาวร")).toBeTruthy();
    check("เลือก Charlie v1");
    expect((bulk().getByRole("button", { name: "เก็บถาวร" }) as HTMLButtonElement).disabled).toBe(true);
    expect((bulk().getByRole("button", { name: "ลบ" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
