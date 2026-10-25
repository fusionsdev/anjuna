import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsersScreen } from "../src/client/screens/Users";
import type { PanelUser } from "../src/client/api";
import { answerConfirm } from "./confirm";

const me = { id: "me", email: "owner@example.test", role: "owner" as const };
const staff = { id: "u2", email: "staff@example.test", name: "Staff", role: "employee" as const, banned: false };
const banned = { id: "u3", email: "banned@example.test", name: "Banned", role: "employee" as const, banned: true };

const sessions = [
  { id: "s1", created_at: "2026-10-20T00:00:00.000Z", expires_at: "2026-10-27T00:00:00.000Z", ip_address: "1.2.3.4", user_agent: "TestAgent/1.0" },
  { id: "s2", created_at: "2026-10-21T00:00:00.000Z", expires_at: "2026-10-28T00:00:00.000Z", ip_address: null, user_agent: null },
];

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let users: PanelUser[];
let requests: Array<{ method: string; path: string; body: Record<string, unknown> }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (method: string, suffix: string) => requests.filter((r) => r.method === method && r.path.endsWith(suffix));
const rowOf = (email: string) => screen.getByText(email).closest("tr")!;

beforeEach(() => {
  users = [
    { id: "me", email: "owner@example.test", name: "Owner", role: "owner", banned: false },
    { ...staff },
    { ...banned },
  ];
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/users", () => json({ users })],
    ["POST /api/users/u2/ban", (init) => json({ user: { id: "u2", banned: true } })],
    ["POST /api/users/u2/unban", () => json({ user: { id: "u2", banned: false } })],
    ["POST /api/users/u3/unban", () => json({ user: { id: "u3", banned: false } })],
    ["POST /api/users/u2/password", () => json({ user: { id: "u2" } })],
    ["DELETE /api/users/u2", () => json({ removed: true })],
    ["GET /api/users/u2/sessions", () => json({ sessions })],
    ["DELETE /api/users/u2/sessions", () => json({ revoked: true })],
    ["DELETE /api/users/u2/sessions/s1", () => json({ revoked: true })],
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

describe("Users screen admin actions and search", () => {
  it("shows Active and Banned badges", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    expect(screen.getAllByText("ใช้งาน (Active)").length).toBeGreaterThan(0);
    expect(screen.getByText("ถูกระงับ (Banned)")).toBeTruthy();
  });

  it("your own row has no action buttons", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    expect(within(rowOf("owner@example.test")).queryAllByRole("button")).toHaveLength(0);
    expect(within(rowOf("staff@example.test")).queryAllByRole("button").length).toBeGreaterThan(0);
  });

  it("Ban confirms with an optional reason and posts it", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "ระงับ (Ban)" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("เหตุผล (Reason)"), { target: { value: "spam" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "ระงับ (Ban)" }));
    await waitFor(() => expect(sent("POST", "/api/users/u2/ban")).toHaveLength(1));
    expect(sent("POST", "/api/users/u2/ban")[0]!.body).toEqual({ reason: "spam" });
    await screen.findByText(/ระงับ staff@example.test แล้ว/);
  });

  it("cancelling Ban sends no request", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "ระงับ (Ban)" }));
    await answerConfirm(false);
    expect(sent("POST", "/api/users/u2/ban")).toHaveLength(0);
  });

  it("Delete confirms with tone danger and the user's email", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "ลบ (Delete)" }));
    const dialog = await answerConfirm(false);
    expect(dialog.textContent).toContain("staff@example.test");
    expect(within(dialog).getByRole("button", { name: "ลบ (Delete)" }).className).toContain("danger");
    expect(sent("DELETE", "/api/users/u2")).toHaveLength(0);
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "ลบ (Delete)" }));
    await answerConfirm(true);
    await waitFor(() => expect(sent("DELETE", "/api/users/u2")).toHaveLength(1));
  });

  it("Reset password rejects a 7-character password before sending", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "รีเซ็ตรหัสผ่าน (Reset password)" }));
    const form = await screen.findByRole("dialog", { name: "รีเซ็ตรหัสผ่าน (Reset password)" });
    fireEvent.change(within(form).getByLabelText("รหัสผ่านใหม่ (New password)"), { target: { value: "1234567" } });
    fireEvent.click(within(form).getByRole("button", { name: "บันทึก (Save)" }));
    await screen.findByText("รหัสผ่านต้องมี 8 ถึง 128 ตัว (Password must be 8 to 128 characters)");
    expect(sent("POST", "/api/users/u2/password")).toHaveLength(0);
  });

  it("Reset password confirms and posts a valid password", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "รีเซ็ตรหัสผ่าน (Reset password)" }));
    const form = await screen.findByRole("dialog", { name: "รีเซ็ตรหัสผ่าน (Reset password)" });
    fireEvent.change(within(form).getByLabelText("รหัสผ่านใหม่ (New password)"), { target: { value: "new-password-1" } });
    fireEvent.click(within(form).getByRole("button", { name: "บันทึก (Save)" }));
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", "/api/users/u2/password")).toHaveLength(1));
    expect(sent("POST", "/api/users/u2/password")[0]!.body).toEqual({ password: "new-password-1" });
  });

  it("Unban posts to the unban route", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("banned@example.test");
    fireEvent.click(within(rowOf("banned@example.test")).getByRole("button", { name: "ยกเลิกการระงับ (Unban)" }));
    await answerConfirm(true);
    await waitFor(() => expect(sent("POST", "/api/users/u3/unban")).toHaveLength(1));
  });

  it("the sessions drawer lists sessions and revokes one", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "เซสชัน (Sessions)" }));
    const drawer = await screen.findByRole("complementary", { name: /เซสชันของ staff@example.test/ });
    expect(within(drawer).getByText("s1")).toBeTruthy();
    expect(within(drawer).getByText("s2")).toBeTruthy();
    fireEvent.click(within(drawer).getAllByRole("button", { name: "เพิกถอน (Revoke)" })[0]!);
    await waitFor(() => expect(sent("DELETE", "/api/users/u2/sessions/s1")).toHaveLength(1));
  });

  it("Revoke all calls the revoke-all route", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "เซสชัน (Sessions)" }));
    const drawer = await screen.findByRole("complementary", { name: /เซสชันของ staff@example.test/ });
    fireEvent.click(within(drawer).getByRole("button", { name: "เพิกถอนทั้งหมด (Revoke all)" }));
    await waitFor(() => expect(sent("DELETE", "/api/users/u2/sessions")).toHaveLength(1));
  });

  it("search matches a name-only hit and an email-only hit separately", async () => {
    users = [
      { id: "me", email: "owner@example.test", name: "Owner", role: "owner", banned: false },
      { id: "u2", email: "somchai@example.test", name: "Support Guy", role: "employee", banned: false },
    ];
    render(<UsersScreen me={me} />);
    await screen.findByText("somchai@example.test");
    const search = screen.getByLabelText("ค้นหาผู้ใช้ (Search users)");
    // "SUPPORT" matches the name only, not the email.
    fireEvent.change(search, { target: { value: "SUPPORT" } });
    expect(screen.queryByText("owner@example.test")).toBeNull();
    expect(screen.getByText("somchai@example.test")).toBeTruthy();
    // "somchai" matches the email only, not the name.
    fireEvent.change(search, { target: { value: "somchai" } });
    expect(screen.queryByText("owner@example.test")).toBeNull();
    expect(screen.getByText("somchai@example.test")).toBeTruthy();
    expect(screen.getByText("Support Guy")).toBeTruthy();
  });

  it("a failed sessions load shows the error instead of spinning forever", async () => {
    routes.set("GET /api/users/u2/sessions", () => json({ error: "boom" }, 500));
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.click(within(rowOf("staff@example.test")).getByRole("button", { name: "เซสชัน (Sessions)" }));
    const drawer = await screen.findByRole("complementary", { name: /เซสชันของ staff@example.test/ });
    await waitFor(() => expect(drawer.querySelector("p[role=alert]")).not.toBeNull());
    expect(drawer.querySelector("p[role=alert]")!.textContent).toBe("เกิดข้อผิดพลาด (500)");
    expect(within(drawer).queryByRole("status")).toBeNull();
  });

  it("a search with no match shows the empty state", async () => {
    render(<UsersScreen me={me} />);
    await screen.findByText("staff@example.test");
    fireEvent.change(screen.getByLabelText("ค้นหาผู้ใช้ (Search users)"), { target: { value: "nobody-here" } });
    await screen.findByText("ไม่พบผู้ใช้ที่ตรงกับคำค้น (No users match this search)");
    expect(screen.queryByText("staff@example.test")).toBeNull();
  });
});
