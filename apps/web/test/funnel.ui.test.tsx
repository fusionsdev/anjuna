import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficBreakdownResponse } from "@anjuna/contracts";
import { biggestLeak, FunnelScreen } from "../src/client/screens/Funnel";

const from = "2026-10-22T00:00:00.000Z";
const to = "2026-10-22T12:00:00.000Z";
let role: "owner" | "employee";
let spendStatus: number;
let empty: boolean;
let trafficStatus: number;
let requests: string[];
const json = (value: unknown, status = 200) => Response.json(value, { status });
function traffic(period: TrafficBreakdownResponse["period"], by: TrafficBreakdownResponse["by"]): TrafficBreakdownResponse {
  const keys = { source: "google", domain: "a.example", device: "mobile", browser: "safari", hour: "00" };
  return {
    period, by, from, to, timezone: "America/New_York",
    rows: by === "hour" ? Array.from({ length: 24 }, (_, hour) => ({ key: String(hour).padStart(2, "0"), visits: !empty && hour === 8 ? 100 : 0, leads: !empty && hour === 8 ? 10 : 0 })) : empty ? [] : [{ key: keys[by], visits: 100, leads: 10 }],
    brands: empty ? [] : [{ brand_id: "brand-a", hostname: "a.example", visits: 100, go_count: 50, form_views: 40, leads: 10 }],
  };
}
const reportRow = { brand: "brand-a", keyword: "Quick Cash", variant: "a", clicks: 60, go_count: 30, form_views: 25, submits: 6, sold: 2, revenue: 24, submit_rate: .1, sold_rate: 1 / 3 };
let fetchMock: ReturnType<typeof vi.fn<(input: string) => Promise<Response>>>;
beforeEach(() => {
  role = "owner"; spendStatus = 200; empty = false; trafficStatus = 200; requests = [];
  fetchMock = vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "https://app.test");
    if (url.pathname === "/api/me") return json({ user: { id: "user", email: "user@example.test", role } });
    if (url.pathname === "/api/spend") return json(spendStatus === 200 ? { brands: [{ brand_id: "brand-a", clicks: 200 }] } : { error: "not_found" }, spendStatus);
    if (url.pathname === "/api/funnel") return json({ from, to, rows: empty ? [] : [reportRow, { ...reportRow, variant: "b", sold: 3 }] });
    if (url.pathname === "/api/traffic/breakdown") return json(trafficStatus === 200 ? traffic(url.searchParams.get("period") as TrafficBreakdownResponse["period"], url.searchParams.get("by") as TrafficBreakdownResponse["by"]) : { error: "internal" }, trafficStatus);
    throw new Error(`Unexpected fetch ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const brandTable = () => within(screen.getByRole("region", { name: "ฟันเนลรายแบรนด์" }));

describe("Funnel screen", () => {
  it("shows one brand row with paid clicks, stages, summed sales and the biggest leak", async () => {
    render(<FunnelScreen />);
    await waitFor(() => expect(brandTable().getByText("200")).toBeTruthy());
    const row = within(brandTable().getByText("brand-a").closest("tr")!);
    await waitFor(() => expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["brand-aa.example", "200", "100", "50", "40", "10", "5", "ลีด หลุด 75%"]));
    expect(screen.getByRole("heading", { name: "แยกตามคีย์เวิร์ดและ A/B" })).toBeTruthy();
    expect(screen.getAllByText("Quick Cash")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "จำนวนคนเข้าเว็บแต่ละชั่วโมง" }).children).toHaveLength(24);
    expect(screen.getByTitle("08:00 เข้าเว็บ 100 ลีด 10")).toBeTruthy();
  });
  it("shows a dash when spend is absent and still loads the report", async () => {
    spendStatus = 404;
    render(<FunnelScreen />);
    await screen.findAllByText("Quick Cash");
    const cells = within(brandTable().getByText("brand-a").closest("tr")!).getAllByRole("cell");
    expect(cells[1]!.textContent).toBe("—");
    expect(cells[7]!.textContent).toBe("ลีด หลุด 75%");
  });
  it("keeps unknown /go as a dash and excludes it from leak arithmetic", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string) => {
      const response = await normal(input) as Response;
      if (!input.startsWith("/api/traffic/breakdown")) return response;
      const data = await response.json() as TrafficBreakdownResponse;
      data.brands = data.brands.map((b) => ({ ...b, go_count: null }));
      return json(data);
    });
    render(<FunnelScreen />);
    await screen.findAllByText("Quick Cash");
    const cells = within(brandTable().getByText("brand-a").closest("tr")!).getAllByRole("cell");
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[7]!.textContent).toBe("ลีด หลุด 75%");
  });
  it("never requests spend or shows revenue to an employee", async () => {
    role = "employee";
    render(<FunnelScreen />);
    await screen.findAllByText("Quick Cash");
    expect(requests.some((p) => p.startsWith("/api/spend"))).toBe(false);
    expect(screen.queryByRole("columnheader", { name: "รายได้" })).toBeNull();
  });
  it("switches every dimension and refetches the selected period including hours", async () => {
    render(<FunnelScreen />);
    await screen.findByText("google");
    for (const [label, result, by] of [["โดเมน", "a.example", "domain"], ["อุปกรณ์", "มือถือ", "device"], ["Browser", "Safari", "browser"]]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(requests).toContain(`/api/traffic/breakdown?period=today&by=${by}`));
      await waitFor(() => expect(within(screen.getByRole("region", { name: "แหล่งที่มาของผู้เข้าชม" })).getByText(result!)).toBeTruthy());
    }
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(requests).toContain("/api/traffic/breakdown?period=7d&by=browser"));
    expect(requests).toContain("/api/traffic/breakdown?period=7d&by=hour");
    expect(requests).toContain("/api/traffic/breakdown?period=7d&by=source");
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(requests).toContain("/api/traffic/breakdown?period=30d&by=hour"));
  });
  it("shows empty state without NaN or Infinity", async () => {
    empty = true; spendStatus = 404;
    const { container } = render(<FunnelScreen />);
    await screen.findByText("ไม่มีข้อมูลรายชั่วโมงในช่วงนี้");
    expect(brandTable().getByText("ไม่มีข้อมูลในช่วงนี้")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
  it("reports traffic errors without presenting them as zero traffic", async () => {
    trafficStatus = 503;
    render(<FunnelScreen />);
    await waitFor(() => expect(brandTable().getByRole("alert").textContent).toContain("503"));
    expect(brandTable().queryByText("ไม่มีข้อมูลในช่วงนี้")).toBeNull();
  });
  it("ignores a late response from the previous period", async () => {
    let resolveOld!: (response: Response) => void;
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: string) => input === "/api/traffic/breakdown?period=today&by=source"
      ? new Promise<Response>((resolve) => { resolveOld = resolve; }) : normal(input));
    render(<FunnelScreen />);
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await screen.findByText("google");
    await act(async () => { resolveOld(json({ ...traffic("today", "source"), rows: [{ key: "STALE", visits: 999, leads: 0 }] })); });
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.getByText("google")).toBeTruthy();
  });
});

describe("biggest leak", () => {
  it("skips missing stages and zero denominators", () => {
    expect(biggestLeak([["paid", null], ["site", 0], ["go", null], ["form", 0], ["lead", 0]])).toBeNull();
    expect(biggestLeak([["paid", 100], ["site", 10], ["go", 5]])).toEqual({ label: "site", loss: .9 });
  });
  it("does not invent negative losses when stages increase", () => {
    expect(biggestLeak([["site", 10], ["go", 20], ["form", 30]])).toBeNull();
  });
});
