import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import type { TrafficReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrafficScreen, readTrafficPeriod, trafficPath } from "../src/client/screens/Traffic";

const report = trafficFixture as TrafficReportResponse;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const recent = () => screen.findByRole("table", { name: "เหตุการณ์ล่าสุด (Recent events)" });
const breakdown = () => screen.getByRole("table", { name: "แยกตาม (Breakdown)" });

let requests: URL[];
let respond: (url: URL) => Response | Promise<Response>;
const reportCalls = () => requests.filter((url) => url.pathname === "/api/traffic/report");

beforeEach(() => {
  window.history.replaceState(null, "", "/traffic");
  requests = [];
  respond = (url) => json({ ...report, period: url.searchParams.get("period") });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, window.location.origin);
    requests.push(url);
    if (url.pathname === "/api/traffic/report") return respond(url);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Traffic screen", () => {
  it("loads 24h by default and shows the five totals", async () => {
    render(<TrafficScreen />);
    await recent();
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0]!.searchParams.get("period")).toBe("24h");
    expect(pressed("24 ชม. (24h)")).toBe("true");
    expect(pressed("7 วัน (7d)")).toBe("false");
    const tiles = screen.getByRole("group", { name: "สรุปทราฟฟิก" });
    const total = (label: string) => within(tiles).getByText(label).nextElementSibling?.textContent;
    expect(total("เข้าชมหน้าแรก (Landing views)")).toBe("160");
    expect(total("เริ่มกรอกฟอร์ม (Form starts)")).toBe("72");
    expect(total("ส่งลีด (Leads)")).toBe("21");
    expect(total("กรอกผิด (Validation errors)")).toBe("9");
    expect(total("ส่งต่อไม่สำเร็จ (Redirect errors)")).toBe("2");
    expect(screen.getByRole("img", { name: "แนวโน้มทราฟฟิก (Traffic trend)" })).toBeTruthy();
  });

  it("a period chip navigates to /traffic?period=7d and refetches with period=7d", async () => {
    render(<TrafficScreen />);
    await recent();
    const entries = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "7 วัน (7d)" }));
    expect(window.location.pathname + window.location.search).toBe("/traffic?period=7d");
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(reportCalls()).toHaveLength(2));
    expect(reportCalls()[1]!.searchParams.get("period")).toBe("7d");
    expect(pressed("7 วัน (7d)")).toBe("true");
    await recent();

    fireEvent.click(screen.getByRole("button", { name: "24 ชม. (24h)" }));
    expect(window.location.pathname + window.location.search).toBe("/traffic");
    await waitFor(() => expect(reportCalls()).toHaveLength(3));
  });

  it("reads the period from the URL", async () => {
    window.history.replaceState(null, "", "/traffic?period=30d");
    render(<TrafficScreen />);
    await recent();
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0]!.searchParams.get("period")).toBe("30d");
    expect(pressed("30 วัน (30d)")).toBe("true");
  });

  it("readTrafficPeriod reads an unknown period as 24h", () => {
    expect(readTrafficPeriod("")).toBe("24h");
    expect(readTrafficPeriod("?period=7d")).toBe("7d");
    expect(readTrafficPeriod("?period=30d")).toBe("30d");
    expect(readTrafficPeriod("?period=bogus")).toBe("24h");
    expect(readTrafficPeriod("?period=toString")).toBe("24h");
    expect(readTrafficPeriod("?period=7D")).toBe("24h");
    expect(trafficPath("24h")).toBe("/traffic");
    expect(trafficPath("30d")).toBe("/traffic?period=30d");
  });

  it("breakdown tabs switch the table rows to the selected dimension without a new request", async () => {
    render(<TrafficScreen />);
    await recent();
    expect(pressed("แบรนด์")).toBe("true");
    expect(within(breakdown()).getByText("a.example")).toBeTruthy();
    expect(within(breakdown()).getByText("brand-b")).toBeTruthy();

    const expectations: Array<[string, string[], string]> = [
      ["โดเมน (Hostname)", ["brand-a.example", "brand-b.example"], "100"],
      ["อุปกรณ์", ["mobile", "desktop"], "110"],
      ["เบราว์เซอร์", ["chrome", "safari"], "90"],
      ["แหล่งที่มา (Source)", ["google", "unknown"], "120"],
    ];
    for (const [tab, keys, firstViews] of expectations) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(pressed(tab)).toBe("true");
      const rows = within(breakdown()).getAllByRole("row");
      expect(rows).toHaveLength(1 + 2);
      for (const key of keys) expect(within(breakdown()).getByText(key)).toBeTruthy();
      expect(within(rows[1]!).getAllByRole("cell")[1]!.textContent).toBe(firstViews);
      expect(within(breakdown()).getByRole("columnheader", { name: tab })).toBeTruthy();
    }
    expect(pressed("แบรนด์")).toBe("false");
    expect(reportCalls()).toHaveLength(1);
  });

  it("the recent table shows session refs in monospace, UTC times and no raw session id", async () => {
    render(<TrafficScreen />);
    const table = await recent();
    const ref = within(table).getByText("3f9a1c0be274");
    expect(ref.tagName).toBe("TD");
    expect(ref.className).toContain("mono");
    expect(within(table).getByText("a81d05e7c9b2")).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "เวลา (UTC)" })).toBeTruthy();
    expect(within(table).getByText("2026-11-02 12:31:07")).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(1 + report.recent.length);
    expect(document.body.textContent).not.toMatch(/session_id/);
    // Null cells read as a dash, not "null".
    expect(table.textContent).not.toContain("null");
  });

  it("the CSV link points at /api/traffic/report.csv with the period", async () => {
    window.history.replaceState(null, "", "/traffic?period=7d");
    render(<TrafficScreen />);
    await recent();
    const link = screen.getByRole("link", { name: "ดาวน์โหลด CSV" });
    expect(link.getAttribute("href")).toBe("/api/traffic/report.csv?period=7d");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("a failed load shows the error card and Retry refetches", async () => {
    respond = () => json({ error: "internal" }, 500);
    render(<TrafficScreen />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("เกิดข้อผิดพลาด (500)");
    expect(screen.queryByRole("table")).toBeNull();
    expect(reportCalls()).toHaveLength(1);

    respond = (url) => json({ ...report, period: url.searchParams.get("period") });
    fireEvent.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    await recent();
    expect(reportCalls()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a spinner while loading", async () => {
    respond = () => new Promise<Response>(() => {});
    render(<TrafficScreen />);
    expect(screen.getByRole("status").textContent).toContain("กำลังโหลด");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("drops a late response for the previous period", async () => {
    const waiting: Array<(response: Response) => void> = [];
    respond = () => new Promise<Response>((resolve) => { waiting.push(resolve); });
    render(<TrafficScreen />);
    await waitFor(() => expect(reportCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "7 วัน (7d)" }));
    await waitFor(() => expect(reportCalls()).toHaveLength(2));

    const totals = (views: number) => ({ ...report, totals: { ...report.totals, landing_views: views } });
    const tile = () => within(screen.getByRole("group", { name: "สรุปทราฟฟิก" })).getByText("เข้าชมหน้าแรก (Landing views)").nextElementSibling?.textContent;
    waiting[1]!(json(totals(777)));
    await recent();
    expect(tile()).toBe("777");

    // The answer for 24h arrives last and must not replace the 7d data.
    await act(async () => {
      waiting[0]!(json(totals(111)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(tile()).toBe("777");
    expect(reportCalls()).toHaveLength(2);
  });

  it("shows the empty state for a table with no rows", async () => {
    respond = () => json({ ...report, recent: [], breakdowns: { ...report.breakdowns, brand: [] } });
    render(<TrafficScreen />);
    const table = await recent();
    expect(within(table).getByText("ยังไม่มีทราฟฟิกในช่วงนี้")).toBeTruthy();
    expect(within(breakdown()).getByText("ยังไม่มีทราฟฟิกในช่วงนี้")).toBeTruthy();
  });
});
