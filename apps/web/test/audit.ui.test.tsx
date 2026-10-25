import type { AuditEntry } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
import { AuditScreen } from "../src/client/screens/Audit";

const me: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "e1", email: "emp@example.test", role: "employee" };
const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1, actor_id: "owner@example.test", actor_role: "owner", action: "brand.pause",
  target: { type: "brand", id: "b1" }, old: null, new: { paused: true }, at: "2026-10-23T01:02:03.000Z", ...over,
});

function mockLabels() {
  vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "b1", hostnames: ["one.example"] }] as never });
  vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
}

function mockUsers() {
  return vi.spyOn(api, "users").mockResolvedValue([
    { id: "u1", name: "Owner One", email: "owner@example.test", role: "owner", banned: false },
    { id: "u2", name: "Alice A", email: "alice@example.test", role: "employee", banned: false },
  ]);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Audit screen", () => {
  it("shows a brand target as domain first with the id in code, and any other target as type:id", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({
      entries: [entry({ id: 2 }), entry({ id: 1, action: "user.role_change", target: { type: "user", id: "u9" } })],
      next_cursor: null,
    });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const brandCell = await within(rows[0]!).findByText("one.example");
    expect(brandCell.closest(".brand-label")).toBeTruthy();
    expect(within(rows[0]!).getByText("b1").tagName).toBe("CODE");
    expect(within(rows[1]!).getByText("user:u9")).toBeTruthy();
    expect(within(rows[1]!).queryByText("one.example")).toBeNull();
  });

  it("reads a brand target as the id when no domain is known", async () => {
    vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "brands").mockRejectedValue(new Error("down"));
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ target: { type: "brand", id: "b7" } })], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("b7").closest(".brand-label")).toBeTruthy();
    expect(table.querySelector(".brand-id")).toBeNull();
  });

  it("the first load shows the spinner, not the empty state", async () => {
    mockLabels();
    mockUsers();
    let release: ((value: { entries: AuditEntry[]; next_cursor: string | null }) => void) | undefined;
    vi.spyOn(api, "audit").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(<AuditScreen me={me} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("ยังไม่มีรายการ")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => { release!({ entries: [], next_cursor: null }); });
    expect(await screen.findByText("ยังไม่มีรายการ")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the empty state for an empty list", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("ยังไม่มีรายการ")).toBeTruthy();
  });

  it("shows the error text when the API fails", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockRejectedValue(new ApiError(503, { error: "internal" }));
    render(<AuditScreen me={me} />);
    expect(await screen.findByText("เกิดข้อผิดพลาด (503)")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the actor name and email for a known user", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ actor_id: "u1" })], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("Owner One (owner@example.test)")).toBeTruthy();
  });

  it("shows ระบบ (system) for a system row", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ actor_id: "system", actor_role: "system" })], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("ระบบ (system)")).toBeTruthy();
  });

  it("shows the raw id with the deleted-user title for an unknown actor", async () => {
    mockLabels();
    mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ actor_id: "gone-1" })], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    const raw = within(table).getByText("gone-1");
    expect(raw.tagName).toBe("CODE");
    expect(raw.getAttribute("title")).toBe("ผู้ใช้ที่ถูกลบ (Deleted user)");
  });

  it("an employee sees their own email and no filter bar and never calls /api/users", async () => {
    mockLabels();
    const usersSpy = mockUsers();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ actor_id: "e1", actor_role: "employee" })], next_cursor: null });
    render(<AuditScreen me={employee} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("emp@example.test")).toBeTruthy();
    expect(screen.queryByLabelText(/ผู้ใช้ \(Actor\)/)).toBeNull();
    expect(screen.queryByLabelText(/ประเภทเป้าหมาย \(Target type\)/)).toBeNull();
    expect(screen.queryByLabelText(/รหัสเป้าหมาย \(Target ID\)/)).toBeNull();
    expect(usersSpy).not.toHaveBeenCalled();
  });

  it("Load more appends the next page using next_cursor", async () => {
    mockLabels();
    mockUsers();
    const auditSpy = vi.spyOn(api, "audit").mockImplementation(async (query) => {
      if (query?.cursor === "cur2") return { entries: [entry({ id: 1, action: "brand.resume" })], next_cursor: null };
      return { entries: [entry({ id: 2 })], next_cursor: "cur2" };
    });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(2));
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cur2" }));
    expect(within(table).getByText("brand.resume")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
  });

  it("changing the actor filter reloads from page 1 with actor_id", async () => {
    mockLabels();
    mockUsers();
    const auditSpy = vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ id: 2 })], next_cursor: "cur2" });
    render(<AuditScreen me={me} />);
    await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    await screen.findByRole("option", { name: "Alice A (alice@example.test)" });
    auditSpy.mockClear();
    fireEvent.change(screen.getByLabelText(/ผู้ใช้ \(Actor\)/), { target: { value: "u2" } });
    await waitFor(() => expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ actor_id: "u2" })));
    expect(auditSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty("cursor");
  });

  it("the brand target filter sends the brand id chosen by domain", async () => {
    mockLabels();
    mockUsers();
    const auditSpy = vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ id: 2 })], next_cursor: null });
    render(<AuditScreen me={me} />);
    await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    fireEvent.change(screen.getByLabelText(/ประเภทเป้าหมาย \(Target type\)/), { target: { value: "brand" } });
    await screen.findByRole("option", { name: "one.example" });
    auditSpy.mockClear();
    fireEvent.change(screen.getByLabelText(/แบรนด์ \(Brand\)/), { target: { value: "b1" } });
    await waitFor(() => expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ target_type: "brand", target_id: "b1" })));
  });

  it("a stale Load more response is dropped after a filter change", async () => {
    mockLabels();
    mockUsers();
    let release: ((value: { entries: AuditEntry[]; next_cursor: string | null }) => void) | undefined;
    const auditSpy = vi.spyOn(api, "audit").mockImplementation((query) => {
      if (query?.cursor === "cur2") return new Promise((resolve) => { release = resolve; });
      if (query?.actor_id === "u2") return Promise.resolve({ entries: [entry({ id: 3, actor_id: "u2", action: "brand.resume" })], next_cursor: null });
      return Promise.resolve({ entries: [entry({ id: 2 })], next_cursor: "cur2" });
    });
    render(<AuditScreen me={me} />);
    await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    await screen.findByRole("option", { name: "Alice A (alice@example.test)" });
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cur2" })));
    fireEvent.change(screen.getByLabelText(/ผู้ใช้ \(Actor\)/), { target: { value: "u2" } });
    // The reload blanks the list to the spinner, so the fresh table carries the new rows.
    const fresh = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    await waitFor(() => expect(within(fresh).getAllByRole("row").slice(1)).toHaveLength(1));
    expect(within(fresh).getByText("brand.resume")).toBeTruthy();
    await act(async () => {
      release!({ entries: [entry({ id: 1, action: "brand.pause" })], next_cursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(fresh).getAllByRole("row").slice(1)).toHaveLength(1);
    expect(within(fresh).getByText("brand.resume")).toBeTruthy();
    expect(within(fresh).queryByText("brand.pause")).toBeNull();
  });

  it("Load more during a filter reload sends no stale cursor", async () => {
    mockLabels();
    mockUsers();
    let release: ((value: { entries: AuditEntry[]; next_cursor: string | null }) => void) | undefined;
    const auditSpy = vi.spyOn(api, "audit").mockImplementation((query) => {
      if (query?.actor_id === "u2") return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ entries: [entry({ id: 2 })], next_cursor: "cur2" });
    });
    render(<AuditScreen me={me} />);
    await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    await screen.findByRole("option", { name: "Alice A (alice@example.test)" });
    auditSpy.mockClear();
    fireEvent.change(screen.getByLabelText(/ผู้ใช้ \(Actor\)/), { target: { value: "u2" } });
    // The reload blanks the list to the spinner, so LoadMore (inside `entries &&`) stays hidden: no stale cursor can send.
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: "cur2" }));
    expect(auditSpy.mock.calls.filter(([q]) => q?.cursor)).toHaveLength(0);
    await act(async () => {
      release!({ entries: [entry({ id: 3, actor_id: "u2", action: "brand.resume" })], next_cursor: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("brand.resume")).toBeTruthy();
  });

  it("a failed Load more shows the error and a retry works", async () => {
    mockLabels();
    mockUsers();
    let fail = true;
    vi.spyOn(api, "audit").mockImplementation(async (query) => {
      if (query?.cursor === "cur2") {
        if (fail) throw new ApiError(503, { error: "internal" });
        return { entries: [entry({ id: 1, action: "brand.resume" })], next_cursor: null };
      }
      return { entries: [entry({ id: 2 })], next_cursor: "cur2" };
    });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    expect(await screen.findByText("เกิดข้อผิดพลาด (503)")).toBeTruthy();
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(1);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }));
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(2));
    expect(within(table).getByText("brand.resume")).toBeTruthy();
    expect(screen.queryByText("เกิดข้อผิดพลาด (503)")).toBeNull();
  });

  it("typing a target id sends one request on Enter", async () => {
    mockLabels();
    mockUsers();
    const auditSpy = vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ id: 2 })], next_cursor: null });
    render(<AuditScreen me={me} />);
    await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    fireEvent.change(screen.getByLabelText(/ประเภทเป้าหมาย \(Target type\)/), { target: { value: "user" } });
    await waitFor(() => expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ target_type: "user" })));
    auditSpy.mockClear();
    const input = screen.getByLabelText(/รหัสเป้าหมาย \(Target ID\)/);
    fireEvent.change(input, { target: { value: "u" } });
    fireEvent.change(input, { target: { value: "u9" } });
    expect(auditSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ target_type: "user", target_id: "u9" })));
    expect(auditSpy.mock.calls.filter(([q]) => q?.target_id)).toHaveLength(1);
  });

  it("a failed users load shows the note and no deleted-user title", async () => {
    mockLabels();
    vi.spyOn(api, "users").mockRejectedValue(new ApiError(503, { error: "internal" }));
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ actor_id: "gone-1" })], next_cursor: null });
    render(<AuditScreen me={me} />);
    expect(await screen.findByText("โหลดชื่อผู้ใช้ไม่สำเร็จ (Could not load user names)")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    const raw = within(table).getByText("gone-1");
    expect(raw.getAttribute("title")).not.toBe("ผู้ใช้ที่ถูกลบ (Deleted user)");
  });

  it("on a narrow screen the filters sit behind the Filters button", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      mockLabels();
      mockUsers();
      vi.spyOn(api, "audit").mockResolvedValue({ entries: [], next_cursor: null });
      render(<AuditScreen me={me} />);
      const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
      expect(within(table).getByText("ยังไม่มีรายการ")).toBeTruthy();
      expect(screen.getByRole("button", { name: "ตัวกรอง (Filters)" })).toBeTruthy();
      expect(screen.queryByLabelText(/ผู้ใช้ \(Actor\)/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "ตัวกรอง (Filters)" }));
      expect(screen.getByRole("dialog", { name: "ตัวกรองประวัติการแก้ไข (Audit filters)" })).toBeTruthy();
      expect(screen.getByLabelText(/ผู้ใช้ \(Actor\)/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "เสร็จ (Done)" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
