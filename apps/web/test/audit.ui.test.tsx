import type { AuditEntry } from "@anjuna/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
import { AuditScreen } from "../src/client/screens/Audit";

const me: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1, actor_id: "owner@example.test", actor_role: "owner", action: "brand.pause",
  target: { type: "brand", id: "b1" }, old: null, new: { paused: true }, at: "2026-10-23T01:02:03.000Z", ...over,
});

function mockLabels() {
  vi.spyOn(api, "lifecycleBrands").mockResolvedValue({ brands: [{ brand_id: "b1", hostnames: ["one.example"] }] as never });
  vi.spyOn(api, "brands").mockResolvedValue({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Audit screen", () => {
  it("shows a brand target as domain first with the id in code, and any other target as type:id", async () => {
    mockLabels();
    vi.spyOn(api, "audit").mockResolvedValue({
      entries: [entry({ id: 2 }), entry({ id: 1, action: "user.role_change", target: { type: "user", id: "u9" } })],
      next_cursor: null,
    });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const brandCell = within(rows[0]!).getByText("one.example");
    expect(brandCell.closest(".brand-label")).toBeTruthy();
    expect(within(rows[0]!).getByText("b1").tagName).toBe("CODE");
    expect(within(rows[1]!).getByText("user:u9")).toBeTruthy();
    expect(within(rows[1]!).queryByText("one.example")).toBeNull();
  });

  it("reads a brand target as the id when no domain is known", async () => {
    vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "brands").mockRejectedValue(new Error("down"));
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [entry({ target: { type: "brand", id: "b7" } })], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("b7").closest(".brand-label")).toBeTruthy();
    expect(table.querySelector(".brand-id")).toBeNull();
  });

  it("shows the empty state for an empty list", async () => {
    mockLabels();
    vi.spyOn(api, "audit").mockResolvedValue({ entries: [], next_cursor: null });
    render(<AuditScreen me={me} />);
    const table = await screen.findByRole("table", { name: "ประวัติการแก้ไข" });
    expect(within(table).getByText("ยังไม่มีรายการ")).toBeTruthy();
  });

  it("shows the error text when the API fails", async () => {
    mockLabels();
    vi.spyOn(api, "audit").mockRejectedValue(new ApiError(503, { error: "internal" }));
    render(<AuditScreen me={me} />);
    expect(await screen.findByText("เกิดข้อผิดพลาด (503)")).toBeTruthy();
  });
});
