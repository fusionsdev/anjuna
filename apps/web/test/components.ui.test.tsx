import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../src/client/components/DataTable";
import { EmptyState } from "../src/client/components/EmptyState";
import { Spinner } from "../src/client/components/Spinner";
import { StatusBadge } from "../src/client/components/StatusBadge";
import { Toast } from "../src/client/components/Toast";

afterEach(() => { cleanup(); vi.useRealTimers(); });

type Row = { id: string; n: number };
const columns = [
  { key: "id", header: "ID", cell: (r: Row) => r.id, mono: true },
  { key: "n", header: "N", cell: (r: Row) => r.n.toLocaleString("en-US"), align: "right" as const },
];

describe("DataTable", () => {
  it("renders headers, cells, monospace ids and right-aligned numbers", () => {
    render(<DataTable label="rows" columns={columns} rows={[{ id: "a1", n: 1200 }]} rowKey={(r) => r.id} empty="none" />);
    const table = screen.getByRole("table", { name: "rows" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["ID", "N"]);
    const cells = within(table).getAllByRole("cell");
    expect(cells[0]!.className).toContain("mono");
    expect(cells[1]!.className).toContain("num");
    expect(cells[1]!.textContent).toBe("1,200");
  });

  it("shows the empty content in one full-width cell", () => {
    render(<DataTable label="rows" columns={columns} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title="ยังไม่มีรายการ" />} />);
    const cell = screen.getByRole("cell");
    expect(cell.getAttribute("colspan")).toBe("2");
    expect(within(cell).getByText("ยังไม่มีรายการ")).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("carries color, icon and text", () => {
    render(<StatusBadge tone="bad" label="ล้มเหลว (failed)" />);
    const badge = screen.getByText("ล้มเหลว (failed)").closest(".pill")!;
    expect(badge.className).toContain("p-bad");
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe("✕");
  });
});

describe("Spinner", () => {
  it("announces loading", () => {
    render(<Spinner />);
    expect(screen.getByRole("status").textContent).toContain("กำลังโหลด…");
  });
});

describe("Toast", () => {
  it("dismisses on click and after the timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast kind="err" text="ไม่สำเร็จ" onDismiss={onDismiss} timeoutMs={1000} />);
    expect(screen.getByRole("alert").textContent).toContain("ไม่สำเร็จ");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("uses role=status for a success", () => {
    render(<Toast kind="ok" text="บันทึกแล้ว" onDismiss={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("บันทึกแล้ว");
  });
});
