import type { LeadAggregatesResponse } from "@anjuna/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DailyBars, dailySeries } from "../src/client/components/DailyBars";

afterEach(cleanup);

type Row = LeadAggregatesResponse["rows"][number];
const cell = (brand_id: string, day: string, status: Row["status"], count: number): Row => ({ brand_id, day, status, count });
const response = (from: string, to: string, rows: Row[]): LeadAggregatesResponse => ({ from, to, timezone: "UTC", rows });

describe("dailySeries", () => {
  it("zero-fills missing days and sums statuses per day", () => {
    // 2026-10-20: 3 pending over two brands + 2 sold = 5 leads, 2 sold. 2026-10-22: 1 rejected. 2026-10-21 has no row.
    // The rows on 2026-10-19 (before `from`) and 2026-10-23 (after `to`) are ignored.
    const rows = [
      cell("brand-a", "2026-10-20", "pending", 2),
      cell("brand-b", "2026-10-20", "pending", 1),
      cell("brand-a", "2026-10-20", "sold", 2),
      cell("brand-a", "2026-10-22", "rejected", 1),
      cell("brand-a", "2026-10-19", "sold", 9),
      cell("brand-a", "2026-10-23", "sold", 7),
    ];
    expect(dailySeries(response("2026-10-20", "2026-10-22", rows), "2026-10-20", "2026-10-22")).toEqual([
      { day: "2026-10-20", leads: 5, sold: 2 },
      { day: "2026-10-21", leads: 0, sold: 0 },
      { day: "2026-10-22", leads: 1, sold: 0 },
    ]);
  });
});

describe("DailyBars", () => {
  const days = [
    { day: "2026-10-20", leads: 5, sold: 2 },
    { day: "2026-10-21", leads: 0, sold: 0 },
    { day: "2026-10-22", leads: 1, sold: 0 },
  ];

  it("renders one leads bar, one sold bar and one hover area per day with a title", () => {
    const { container } = render(<DailyBars days={days} />);
    const svg = screen.getByRole("img", { name: "ลีดและยอดขายรายวัน" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 72 120");
    expect(container.querySelectorAll("svg rect.bar-leads")).toHaveLength(3);
    expect(container.querySelectorAll("svg rect.bar-sold")).toHaveLength(3);
    expect(container.querySelectorAll("svg rect.bar-hit")).toHaveLength(3);
    expect([...container.querySelectorAll("svg g > title")].map((t) => t.textContent)).toEqual([
      "2026-10-20: ลีด 5, ขายได้ 2",
      "2026-10-21: ลีด 0, ขายได้ 0",
      "2026-10-22: ลีด 1, ขายได้ 0",
    ]);

    // The largest leads count (5) fills 100 px above the baseline at y 110; sold uses the same scale.
    const box = (selector: string) => [...container.querySelectorAll(selector)].map((r) => ({ x: r.getAttribute("x"), y: r.getAttribute("y"), width: r.getAttribute("width"), height: r.getAttribute("height") }));
    expect(box("rect.bar-leads")).toEqual([
      { x: "0", y: "10", width: "10", height: "100" },
      { x: "24", y: "110", width: "10", height: "0" },
      { x: "48", y: "90", width: "10", height: "20" },
    ]);
    expect(box("rect.bar-sold")).toEqual([
      { x: "11", y: "70", width: "10", height: "40" },
      { x: "35", y: "110", width: "10", height: "0" },
      { x: "59", y: "110", width: "10", height: "0" },
    ]);
    // The hover area is transparent and spans the plot height (y 10 to 110) over the whole day slot, so a 0-lead day still shows its title.
    expect([...container.querySelectorAll("rect.bar-hit")].map((r) => ({ x: r.getAttribute("x"), y: r.getAttribute("y"), width: r.getAttribute("width"), height: r.getAttribute("height"), fill: r.getAttribute("fill"), parent: r.parentElement!.querySelector("title")!.textContent }))).toEqual([
      { x: "0", y: "10", width: "24", height: "100", fill: "transparent", parent: "2026-10-20: ลีด 5, ขายได้ 2" },
      { x: "24", y: "10", width: "24", height: "100", fill: "transparent", parent: "2026-10-21: ลีด 0, ขายได้ 0" },
      { x: "48", y: "10", width: "24", height: "100", fill: "transparent", parent: "2026-10-22: ลีด 1, ขายได้ 0" },
    ]);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("renders an empty state when every day is zero", () => {
    const { container } = render(<DailyBars days={days.map((d) => ({ ...d, leads: 0, sold: 0 }))} />);
    expect(screen.getByText("ยังไม่มีลีดในช่วงนี้")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});
