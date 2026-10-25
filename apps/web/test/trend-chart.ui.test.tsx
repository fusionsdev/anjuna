// spec traffic
import type { TrafficReportResponse } from "@anjuna/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { TrendChart } from "../src/client/components/TrendChart";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Bucket = TrafficReportResponse["trend"][number];
const bucket = (at: string, landing_views: number, leads: number, rest: Partial<Bucket> = {}): Bucket =>
  ({ at, landing_views, form_starts: 0, leads, validation_errors: 0, redirect_errors: 0, ...rest });

const days: Bucket[] = [
  bucket("2026-10-20T00:00:00.000Z", 10, 2, { form_starts: 6, validation_errors: 1, redirect_errors: 3 }),
  bucket("2026-10-21T00:00:00.000Z", 0, 0),
  bucket("2026-10-22T00:00:00.000Z", 5, 1),
];

const points = (container: HTMLElement, cls: string) => container.querySelector(`polyline.${cls}`)!.getAttribute("points")!;

describe("TrendChart", () => {
  it("renders one titled bucket per trend entry with every metric", () => {
    const { container } = render(<TrendChart trend={days} bucket="day" />);
    const svg = screen.getByRole("img", { name: "แนวโน้มทราฟฟิก (Traffic trend)" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect([...container.querySelectorAll("svg g > title")].map((t) => t.textContent)).toEqual([
      "2026-10-20: เข้าชม 10, เริ่มกรอก 6, ลีด 2, กรอกผิด 1, ส่งต่อไม่สำเร็จ 3",
      "2026-10-21: เข้าชม 0, เริ่มกรอก 0, ลีด 0, กรอกผิด 0, ส่งต่อไม่สำเร็จ 0",
      "2026-10-22: เข้าชม 5, เริ่มกรอก 0, ลีด 1, กรอกผิด 0, ส่งต่อไม่สำเร็จ 0",
    ]);
    // A transparent slot-wide hit area carries each title, so a zero bucket still shows it.
    const hits = [...container.querySelectorAll("rect.trend-hit")];
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.getAttribute("fill")).toBe("transparent");
      expect(hit.getAttribute("width")).toBe("24");
      expect(hit.parentElement!.querySelector("title")).not.toBeNull();
    }
    expect(screen.getByText("เวลา UTC")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("labels hourly buckets HH:00 and daily buckets YYYY-MM-DD in UTC", () => {
    // 23:00Z is the next calendar day in UTC+7, so a local-time label would read 06:00 and 2026-10-21.
    const hours = [bucket("2026-10-20T23:00:00.000Z", 1, 0), bucket("2026-10-21T00:00:00.000Z", 2, 1)];
    const hourly = render(<TrendChart trend={hours} bucket="hour" />);
    expect([...hourly.container.querySelectorAll("svg g > title")].map((t) => t.textContent!.split(": ")[0])).toEqual(["23:00", "00:00"]);
    hourly.unmount();

    const daily = render(<TrendChart trend={[bucket("2026-10-20T00:00:00.000Z", 1, 0)]} bucket="day" />);
    expect(daily.container.querySelector("svg g > title")!.textContent!.split(": ")[0]).toBe("2026-10-20");
  });

  it("draws the landing and leads polylines with one point per bucket", () => {
    const { container } = render(<TrendChart trend={days} bucket="day" />);
    expect(container.querySelectorAll("svg polyline")).toHaveLength(2);
    // 24 viewBox units per bucket, points at slot centres. The largest value (10 landing views) fills 100 above the baseline at y 110.
    expect(screen.getByRole("img").getAttribute("viewBox")).toBe("0 0 72 120");
    expect(points(container, "trend-landing")).toBe("12,10 36,110 60,60");
    expect(points(container, "trend-leads")).toBe("12,90 36,110 60,100");
  });

  it("scales y to the largest of landing views and leads", () => {
    const { container } = render(<TrendChart trend={[bucket("2026-10-20T00:00:00.000Z", 1, 4), bucket("2026-10-21T00:00:00.000Z", 2, 0)]} bucket="day" />);
    expect(points(container, "trend-leads")).toBe("12,10 36,110");
    expect(points(container, "trend-landing")).toBe("12,85 36,60");
  });

  it("shows the empty state when every bucket is zero", () => {
    const { container } = render(<TrendChart trend={days.map((d) => bucket(d.at, 0, 0))} bucket="day" />);
    expect(screen.getByText("ยังไม่มีทราฟฟิกในช่วงนี้")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps the chart, with flat lines and no NaN, when only the other metrics are non-zero", () => {
    const { container } = render(<TrendChart trend={[bucket("2026-10-20T00:00:00.000Z", 0, 0, { form_starts: 2 })]} bucket="day" />);
    expect(screen.queryByText("ยังไม่มีทราฟฟิกในช่วงนี้")).toBeNull();
    expect(points(container, "trend-landing")).toBe("12,110");
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("api.clientErrors", () => {
  const body = { period: "24h", from: "2026-10-24T13:00:00.000Z", to: "2026-10-25T12:00:00.000Z", counts: [], rows: [], next_cursor: null };
  const stub = () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };

  it("omits unset filters from the query", async () => {
    const fetcher = stub();
    await api.clientErrors({ period: "24h" });
    await api.clientErrors({ period: "7d", brand_id: undefined, error_type: "", cursor: undefined });
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(["/api/client-errors?period=24h", "/api/client-errors?period=7d"]);
  });

  it("sends every filter that is set and parses the body", async () => {
    const fetcher = stub();
    const result = await api.clientErrors({ period: "30d", brand_id: "brand-a", error_type: "timeout", cursor: "51" });
    expect(fetcher.mock.calls[0]![0]).toBe("/api/client-errors?period=30d&brand_id=brand-a&error_type=timeout&cursor=51");
    expect(result.next_cursor).toBeNull();
  });

  it("rejects a body that breaks the contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...body, rows: [{ id: 1, session_id: "raw" }] }), { status: 200 })));
    await expect(api.clientErrors({ period: "24h" })).rejects.toThrow();
  });
});

describe("api.trafficReport", () => {
  it("requests the period and builds the CSV link", async () => {
    const fetcher = vi.fn(async (_input: string) => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.trafficReport("7d")).rejects.toThrow();
    expect(fetcher.mock.calls[0]![0]).toBe("/api/traffic/report?period=7d");
    expect(api.trafficReportCsvUrl("30d")).toBe("/api/traffic/report.csv?period=30d");
  });
});
