import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import type { ConversionsReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
import { HomeScreen } from "../src/client/screens/Home";

const owner = { id: "o", email: "o@example.test", role: "owner" } as Me;
const employee = { id: "e", email: "e@example.test", role: "employee" } as Me;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = (brand: string, clicks: number, go: number, form: number, submits: number, sold: number, revenue: number | null) => ({
  brand, keyword: null, variant: null, clicks, go_count: go, form_views: form, submits, sold, revenue, submit_rate: null, sold_rate: null,
});
// 7 days: reached 283, /go 131, form 94, leads 17, sold 4, revenue 410. The biggest drop is form -> lead (82%).
const FUNNEL_7D = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", rows: [row("cg", 212, 98, 70, 11, 3, 254), row("d6", 71, 33, 24, 6, 1, 156)] };
// 30 days: reached 900, leads 60, sold 12, revenue 1500.
const FUNNEL_30D = { from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", rows: [row("cg", 900, 600, 400, 60, 12, 1500)] };
// The window before 7d (from 2026-10-09): reached 300, leads 10, sold 2, revenue 600. Against FUNNEL_7D that is visits ▼ 6%, leads ▲ 70%, sold ▲ 100%, revenue ▼ 32%.
const FUNNEL_BEFORE = { from: "2026-10-09T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z", rows: [row("cg", 200, 90, 60, 8, 2, 500), row("d6", 100, 40, 30, 2, 0, 100)] };
// The previous range starts one window earlier than the current one: 7d 2026-10-09, 30d 2026-08-24, today 2026-10-21.
const isPreviousFrom = (from: string) => ["2026-10-09", "2026-08-24", "2026-10-21"].some((day) => from.startsWith(day));
const spendReport = (cost: number, clicks: number) => ({
  period: "7d", from: "2026-10-16", to: "2026-10-22", totals: { cost, clicks, impressions: 9000 },
  brands: [{ brand_id: "cg", cost, clicks, impressions: 9000, updated_at: "2026-10-22T09:00:00.000Z" }],
});
const alertsReport = {
  generated_at: "2026-10-22T10:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "demo06", leads: 5 }] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.05, alert_at: 0.1, samples: [] } },
  reject_rate: { state: "warn", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [{ brand: "Credit Genie", rejected: 5, decided: 13, rate: 0.38 }] } },
};
// The Conversions fixture, owner view: uploaded 5, pending 3, dead 4, stalled 1, uploaded value 412.5.
const CONVERSIONS_OWNER = conversionsFixture as ConversionsReportResponse;
// 30 days: every count is different so the period switch shows in the card.
const CONVERSIONS_30D: ConversionsReportResponse = { ...CONVERSIONS_OWNER, period: "30d", totals: { pending: 6, processing: 2, uploaded: 20, dead: 9 }, value_totals: { uploaded: 1800, dead: 400 }, stalled: 2 };
// Employee view: core withholds every money field.
const redact = (report: ConversionsReportResponse): ConversionsReportResponse => ({ ...report, value_totals: null, rows: report.rows.map((r) => ({ ...r, value: null })) });
const template = (id: string, status: string) => ({ template_version_id: id, template_id: id, name: id, version: 1, status, submitted_by_label: null, created_at: "2026-10-20", sealed_at: null, thumbnail_url: null, brands_using: 0 });
// Daily outcome counts: 2026-10-21 has 3 pending + 1 sold (4 leads, 1 sold); 2026-10-22 has 2 sold + 1 rejected (3 leads, 2 sold).
const aggregateRows = [
  { brand_id: "cg", day: "2026-10-21", status: "pending", count: 3 },
  { brand_id: "cg", day: "2026-10-21", status: "sold", count: 1 },
  { brand_id: "cg", day: "2026-10-22", status: "sold", count: 2 },
  { brand_id: "cg", day: "2026-10-22", status: "rejected", count: 1 },
];
const aggregatesBody = (from: string, to: string) => ({ from, to, timezone: "UTC", rows: aggregateRows });

let funnel: (from: string) => Response | Promise<Response>;
let conversions: (period: string) => Response | Promise<Response>;
let aggregates: (from: string, to: string) => Response | Promise<Response>;
let alertsBody: unknown;
let alertsReply: () => Response | Promise<Response>;
let spend: ReturnType<typeof vi.fn>;
const realSpend = api.spend;
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
  requests = [];
  funnel = (from) => json(isPreviousFrom(from) ? FUNNEL_BEFORE : from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D);
  conversions = (period) => json(period === "30d" ? CONVERSIONS_30D : CONVERSIONS_OWNER);
  aggregates = (from, to) => json(aggregatesBody(from, to));
  alertsBody = alertsReport;
  alertsReply = () => json(alertsBody);
  spend = vi.fn(async (period: string) => (period === "30d" ? spendReport(2400, 1200) : spendReport(1780, 402)));
  (api as unknown as { spend: unknown }).spend = spend;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "http://panel.test");
    if (url.pathname === "/api/funnel") return funnel(url.searchParams.get("from") ?? "");
    if (url.pathname === "/api/conversions") return conversions(url.searchParams.get("period") ?? "");
    if (url.pathname === "/api/leads/aggregates") return aggregates(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    if (url.pathname === "/api/alerts") return alertsReply();
    if (url.pathname === "/api/templates") return json({ templates: [template("t1", "awaiting_approval"), template("t2", "awaiting_approval"), template("t3", "approved")] });
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "a", status: "live" }, { brand_id: "b", status: "live" }, { brand_id: "c", status: "draft" }] });
    if (url.pathname === "/api/brands/a/checklist") return json({ brand_id: "a", checklist: [{ item: "test_sold", evidence: {} }, { item: "drain_route", evidence: {} }] });
    if (url.pathname === "/api/brands/b/checklist") return json({ brand_id: "b", checklist: [{ item: "drain_route", evidence: {} }] });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  api.spend = realSpend;
  // navigate() moves the jsdom location; the next test starts on Home.
  window.history.replaceState(null, "", "/");
});

const ledgerValue = (label: string) => {
  const cell = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText(label).parentElement!;
  return { text: cell.querySelector(".v")!.textContent, className: cell.querySelector(".v")!.className };
};
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
/** The delta line under a ledger value, `null` when the cell has none. */
const ledgerDelta = (label: string) => {
  const d = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText(label).parentElement!.querySelector(".d");
  return d ? { text: d.textContent, className: d.className } : null;
};
const funnelQueries = () => requests.filter((r) => r.startsWith("/api/funnel")).map((r) => new URL(r, "http://panel.test").searchParams);
const conversionRequests = () => requests.filter((r) => r.startsWith("/api/conversions"));
/** The `[from, to]` days of every daily-bars request, in call order. */
const aggregateQueries = () => requests.filter((r) => r.startsWith("/api/leads/aggregates")).map((r) => {
  const params = new URL(r, "http://panel.test").searchParams;
  return [params.get("from"), params.get("to")];
});
const dailyPanel = () => within(screen.getByRole("region", { name: "ลีดรายวัน" }));
/** One `<title>` per day in the daily bars. */
const dayTitles = () => [...screen.getByRole("region", { name: "ลีดรายวัน" }).querySelectorAll("svg g > title")].map((t) => t.textContent);
const card = () => within(screen.getByRole("region", { name: "คอนเวอร์ชัน" }));
/** The big number under a card label. */
const cardValue = (label: string) => card().getByText(label).parentElement!.querySelector(".v")!.textContent;
const fixList = () => within(screen.getByRole("region", { name: "ต้องแก้" }));
const fixTexts = () => [...screen.getByRole("region", { name: "ต้องแก้" }).querySelectorAll(".home-item .t span")].map((s) => s.textContent);
/**
 * Clicks a link and says whether the app took the click (default prevented, so no new page loads).
 * The click is cancelled afterwards so jsdom does not try to navigate.
 */
const appTakesClick = (link: Element, init: MouseEventInit = {}) => {
  let prevented = false;
  const seen = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
  document.addEventListener("click", seen);
  fireEvent.click(link, init);
  document.removeEventListener("click", seen);
  return prevented;
};

describe("Home screen, owner", () => {
  it("shows spend, leads, cost per lead, the ledger, the money flow and the to-do list", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");

    expect(ledgerValue("ค่าโฆษณา").text).toBe("$1,780");
    expect(ledgerValue("ต้นทุนต่อลีด").text).toBe("$105");
    expect(ledgerValue("รายได้").text).toBe("$410");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,370", className: "v neg" });

    const stages = [...document.querySelectorAll(".home-stage")].map((s) => s.textContent);
    expect(stages).toEqual(["402คลิกที่จ่าย", "283ถึงเว็บ", "131ถึง /go", "94เปิดฟอร์ม", "17ลีด", "4ขายได้"]);
    expect(document.querySelector(".home-stage.leak")!.textContent).toBe("17ลีด");
    expect(document.querySelector(".home-drops .amb")!.textContent).toBe("หลุด 82%");
    expect(document.querySelector(".note")!.textContent).toContain('หลุดมากที่สุดที่ขั้น "เปิดฟอร์ม" ไป "ลีด": จาก 94 เหลือ 17 (82%)');

    const fixes = within(screen.getByRole("region", { name: "ต้องแก้" }));
    expect(await fixes.findByText("demo06")).toBeTruthy();
    expect(fixes.getByText("5 ลีดยังไม่มีผลจาก LeadsGate เกิน 24 ชั่วโมง")).toBeTruthy();
    expect(fixes.getByText("Credit Genie")).toBeTruthy();
    expect(fixes.getByText("อัตรา reject 38% สูงกว่าค่าปกติ 10%")).toBeTruthy();

    const todo = within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
    expect(await todo.findByText("1 แบรนด์")).toBeTruthy();
    expect(todo.getByText("ยืนยัน Test sold")).toBeTruthy();
    expect(todo.getByText("2 รายการ")).toBeTruthy();
    expect(todo.getByText("1 ร่าง")).toBeTruthy();
  });

  it("names the paid-click loss in the note when it is the biggest leak", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 900, 800, 700, 600, 500, 5000)] });
    spend.mockResolvedValue(spendReport(2622, 3000));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $2,622 ได้ 600 ลีด ต้นทุนลีดละ $4.37");
    expect(document.querySelector(".home-stage.leak")!.textContent).toBe("900ถึงเว็บ");
    expect(document.querySelector(".home-drops .amb")!.textContent).toBe("หลุด 70%");
    expect(document.querySelector(".note")!.textContent).toContain("Google คิดเงิน 3,000 คลิก มาถึงเว็บจริง 900 คน หายไป 2,100 คลิก (70%)");
  });

  it("switches between today, 7 days and 30 days and asks funnel and spend for that window", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
    // Every period asks the funnel twice: the window itself, then the window of equal length before it.
    const funnelQuery = (n: number) => funnelQueries()[n]!;
    expect(funnelQuery(0).get("from")).toBe("2026-10-16T00:00:00.000Z");
    expect(funnelQuery(0).get("to")).toBe("2026-10-23T00:00:00.000Z");
    expect(funnelQuery(1).get("from")).toBe("2026-10-09T00:00:00.000Z");
    expect(funnelQuery(1).get("to")).toBe("2026-10-16T00:00:00.000Z");
    expect(spend).toHaveBeenLastCalledWith("7d");

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await heading("จ่ายค่าโฆษณา $2,400 ได้ 60 ลีด ต้นทุนลีดละ $40");
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("true");
    expect(funnelQuery(2).get("from")).toBe("2026-09-23T00:00:00.000Z");
    expect(funnelQuery(3).get("from")).toBe("2026-08-24T00:00:00.000Z");
    expect(funnelQuery(3).get("to")).toBe("2026-09-23T00:00:00.000Z");
    expect(spend).toHaveBeenLastCalledWith("30d");

    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(spend).toHaveBeenLastCalledWith("today"));
    await waitFor(() => expect(funnelQueries()).toHaveLength(6));
    expect(funnelQuery(4).get("from")).toBe("2026-10-22T00:00:00.000Z");
    expect(funnelQuery(4).get("to")).toBe("2026-10-23T00:00:00.000Z");
    expect(funnelQuery(5).get("from")).toBe("2026-10-21T00:00:00.000Z");
    expect(funnelQuery(5).get("to")).toBe("2026-10-22T00:00:00.000Z");
  });

  it("shows the revenue change against the previous window and no delta on spend, cost per lead or profit", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "▼ 32%", className: "d neg" }));
    expect(ledgerDelta("ค่าโฆษณา")).toBeNull();
    expect(ledgerDelta("ต้นทุนต่อลีด")).toBeNull();
    expect(ledgerDelta("กำไร/ขาดทุน")).toBeNull();
  });

  it("shows a dash instead of a percent when the previous revenue is 0", async () => {
    funnel = (from) => json(isPreviousFrom(from) ? { ...FUNNEL_BEFORE, rows: [row("cg", 200, 90, 60, 8, 2, 0)] } : FUNNEL_7D);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
  });

  it("shows a dash for the revenue change when core withheld the revenue", async () => {
    funnel = () => json({ ...FUNNEL_7D, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(ledgerValue("รายได้").text).toBe("—");
  });

  it("keeps the current values and shows a dash when the previous window fails", async () => {
    funnel = (from) => (isPreviousFrom(from) ? json({ error: "core_unavailable" }, 502) : json(FUNNEL_7D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(ledgerValue("รายได้").text).toBe("$410");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,370", className: "v neg" });
  });

  it("shows no delta while the previous window loads and drops a late answer for an old period", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
    funnel = (from) => (from.startsWith("2026-10-09") ? old : json(isPreviousFrom(from) ? FUNNEL_BEFORE : from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    expect(ledgerDelta("รายได้")).toBeNull();

    // The 30 day previous window (1500 now against 600 before) answers; then the 7 day one arrives with a different number.
    funnel = (from) => json(from.startsWith("2026-08-24") ? { ...FUNNEL_BEFORE, rows: [row("cg", 1, 1, 1, 1, 1, 600)] } : FUNNEL_30D);
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "▲ 150%", className: "d pos" }));
    releaseOld(json({ ...FUNNEL_BEFORE, rows: [row("cg", 1, 1, 1, 1, 1, 1500)] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ledgerDelta("รายได้")).toEqual({ text: "▲ 150%", className: "d pos" });
  });

  it("shows — for spend, cost per lead and profit when the spend API fails, and keeps revenue", async () => {
    spend.mockRejectedValue(new ApiError(502, { error: "core_unavailable" }));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา — ได้ 17 ลีด ต้นทุนลีดละ —");
    expect(ledgerValue("ค่าโฆษณา").text).toBe("—");
    expect(ledgerValue("ต้นทุนต่อลีด").text).toBe("—");
    expect(ledgerValue("รายได้").text).toBe("$410");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "—", className: "v" });
    expect(document.querySelector(".home-stage")!.textContent).toBe("—คลิกที่จ่าย");
  });

  it("shows — when the spend API has no rows for the period instead of $0", async () => {
    spend.mockResolvedValue({ period: "7d", from: "2026-10-16", to: "2026-10-22", totals: { cost: 0, clicks: 0, impressions: 0 }, brands: [] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา — ได้ 17 ลีด ต้นทุนลีดละ —");
  });

  it("shows — for every funnel number when the funnel API fails", async () => {
    funnel = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ — ลีด ต้นทุนลีดละ —");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน").text).toBe("—");
    expect([...document.querySelectorAll(".home-stage")].map((s) => s.textContent)).toEqual(["402คลิกที่จ่าย", "—ถึงเว็บ", "—ถึง /go", "—เปิดฟอร์ม", "—ลีด", "—ขายได้"]);
    expect(document.querySelector(".note")).toBeNull();
  });

  it("shows — for revenue and profit when every funnel row has null revenue instead of $0", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "—", className: "v" });
  });

  it("shows — for revenue and profit when one funnel row has null revenue instead of a partial sum", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, 156)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "—", className: "v" });
  });

  it("shows a real 0 for no leads and — for the cost per lead it cannot divide", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 0 ลีด ต้นทุนลีดละ —");
    expect(ledgerValue("รายได้").text).toBe("$0");
    expect(ledgerValue("กำไร/ขาดทุน").text).toBe("−$1,780");
  });

  it("opens the matching screen from the buttons", async () => {
    const onGo = vi.fn();
    render(<HomeScreen me={owner} onGo={onGo} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    fireEvent.click(screen.getByRole("button", { name: "+ สร้างแบรนด์ใหม่" }));
    fireEvent.click(screen.getByRole("button", { name: "ดูทั้งหมด" }));
    fireEvent.click(screen.getByRole("button", { name: "แยกตามแบรนด์" }));
    const todo = within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
    await todo.findByText("2 รายการ");
    fireEvent.click(todo.getAllByRole("button", { name: "เปิด" })[1]!);
    expect(onGo.mock.calls.map((c) => c[0])).toEqual(["new-brand", "alerts", "funnel", "templates"]);
  });

  it("shows conversion counts and links the card and the dead count to the Conversions page", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    expect(cardValue("ค้างส่ง")).toBe("3");
    expect(cardValue("ส่งไม่ได้")).toBe("4");
    expect(cardValue("ค้างเกิน 6 ชม.")).toBe("1");
    expect(cardValue("มูลค่าที่ส่งแล้ว")).toBe("$412.50");
    expect(conversionRequests()).toEqual(["/api/conversions?period=7d"]);

    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 4" });
    expect(dead.getAttribute("href")).toBe("/conversions?status=dead");
    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname).toBe("/conversions");
    expect(window.location.search).toBe("?status=dead");

    window.history.replaceState(null, "", "/");
    const all = card().getByRole("link", { name: "ดูทั้งหมด" });
    expect(all.getAttribute("href")).toBe("/conversions");
    expect(appTakesClick(all)).toBe(true);
    expect(window.location.pathname).toBe("/conversions");
    expect(window.location.search).toBe("");
  });

  it("keeps the selected period in the card and fix list links", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(cardValue("ส่งไม่ได้")).toBe("9"));

    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 9" });
    expect(dead.getAttribute("href")).toBe("/conversions?period=30d&status=dead");
    expect(card().getByRole("link", { name: "ดูทั้งหมด" }).getAttribute("href")).toBe("/conversions?period=30d");
    await waitFor(() => expect(fixList().getAllByRole("link", { name: "ดูรายละเอียด" }).map((l) => l.getAttribute("href"))).toEqual(["/conversions?period=30d&status=dead", "/conversions?period=30d&status=pending"]));

    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=30d&status=dead");

    // Today is not the Conversions default, so it stays in the query. 7d is the default and leaves the query out.
    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(card().getByRole("link", { name: "ดูทั้งหมด" }).getAttribute("href")).toBe("/conversions?period=today"));
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(card().getByRole("link", { name: "ดูทั้งหมด" }).getAttribute("href")).toBe("/conversions"));
  });

  it("keeps the browser default for a ctrl-click, meta-click or middle-click on the card and fix links", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 4" });
    const all = card().getByRole("link", { name: "ดูทั้งหมด" });
    for (const link of [dead, all]) {
      expect(appTakesClick(link, { ctrlKey: true })).toBe(false);
      expect(appTakesClick(link, { metaKey: true })).toBe(false);
      expect(appTakesClick(link, { shiftKey: true })).toBe(false);
      expect(appTakesClick(link, { button: 1 })).toBe(false);
    }
    await waitFor(() => expect(fixList().getAllByRole("link", { name: "ดูรายละเอียด" })).toHaveLength(2));
    const [deadItem] = fixList().getAllByRole("link", { name: "ดูรายละเอียด" });
    expect(appTakesClick(deadItem!, { ctrlKey: true })).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/");

    // A plain left click on the same link stays in the app.
    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?status=dead");
  });

  it("asks for the conversions of the chosen period and drops a late answer for an old one", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
    conversions = (period) => (period === "7d" ? old : json(CONVERSIONS_30D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    // The 7 day answer is still on its way: every cell shows the loading mark.
    expect(["ส่งแล้ว", "ค้างส่ง", "ส่งไม่ได้", "ค้างเกิน 6 ชม."].map(cardValue)).toEqual(["…", "…", "…", "…"]);
    expect(card().queryByText("มูลค่าที่ส่งแล้ว")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("20"));
    expect(cardValue("ส่งไม่ได้")).toBe("9");
    expect(cardValue("มูลค่าที่ส่งแล้ว")).toBe("$1,800.00");
    releaseOld(json(CONVERSIONS_OWNER));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cardValue("ส่งแล้ว")).toBe("20");
    expect(cardValue("ส่งไม่ได้")).toBe("9");
    expect(conversionRequests()).toEqual(["/api/conversions?period=7d", "/api/conversions?period=30d"]);
  });

  it("adds dead and stalled conversions to the fix list, bad first, with links to the filtered Conversions page", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toContain("คอนเวอร์ชันส่งไม่ได้ 4 รายการ"));
    expect(fixTexts()).toEqual([
      "คอนเวอร์ชันส่งไม่ได้ 4 รายการ",
      "คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ",
      "5 ลีดยังไม่มีผลจาก LeadsGate เกิน 24 ชั่วโมง",
      "อัตรา reject 38% สูงกว่าค่าปกติ 10%",
    ]);
    const dots = [...screen.getByRole("region", { name: "ต้องแก้" }).querySelectorAll(".home-item .dot")].map((d) => d.getAttribute("style") ?? "");
    expect(dots.map((style) => (style.includes("--bad") ? "bad" : "warn"))).toEqual(["bad", "warn", "warn", "warn"]);

    const links = fixList().getAllByRole("link", { name: "ดูรายละเอียด" });
    // Stalled rows count at any age, so their link opens the widest list.
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/conversions?status=dead", "/conversions?period=30d&status=pending"]);
    expect(appTakesClick(links[1]!)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=30d&status=pending");
    // The alert items keep their button that opens the alerts screen.
    expect(fixList().getAllByRole("button", { name: "ดูรายละเอียด" })).toHaveLength(2);
  });

  it("keeps the top 4 of the fix list with bad items before warn items", async () => {
    const sample = (brand: string) => ({ brand, errors: 2, submits: 8, rate: 0.2 });
    alertsBody = { ...alertsReport, submit_error_rate: { state: "alert", detail: { window_hours: 24, warn_at: 0.05, alert_at: 0.1, samples: [sample("s1"), sample("s2"), sample("s3")] } } };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toContain("คอนเวอร์ชันส่งไม่ได้ 4 รายการ"));
    expect(fixTexts()).toEqual(["คอนเวอร์ชันส่งไม่ได้ 4 รายการ", "ส่งฟอร์มผิดพลาด 20% (2 จาก 10 ครั้ง)", "ส่งฟอร์มผิดพลาด 20% (2 จาก 10 ครั้ง)", "ส่งฟอร์มผิดพลาด 20% (2 จาก 10 ครั้ง)"]);
  });

  it("shows the stalled conversions once when the stalled alert reports the same stall", async () => {
    alertsBody = { ...alertsReport, conversion_stalled: { state: "warn", detail: { max_hours: 6, stuck_count: 2, oldest_created_at: "2026-10-22T01:00:00.000Z" } } };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toContain("คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ"));
    expect(fixTexts().filter((t) => /ค้างเกิน|ยังไม่ถูกส่ง/.test(t ?? ""))).toEqual(["คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ"]);
  });

  it("keeps the stalled alert item when the conversions show no stall or fail", async () => {
    alertsBody = { ...alertsReport, conversion_stalled: { state: "warn", detail: { max_hours: 6, stuck_count: 2, oldest_created_at: "2026-10-22T01:00:00.000Z" } } };
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { ...CONVERSIONS_OWNER.totals, dead: 0 }, stalled: 0 });
    const { unmount } = render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toContain("2 คอนเวอร์ชันยังไม่ถูกส่งเกิน 6 ชั่วโมง"));
    await waitFor(() => expect(cardValue("ส่งไม่ได้")).toBe("0"));
    expect(fixTexts().some((t) => t?.startsWith("คอนเวอร์ชัน"))).toBe(false);
    unmount();

    conversions = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("—"));
    expect(fixTexts()).toContain("2 คอนเวอร์ชันยังไม่ถูกส่งเกิน 6 ชั่วโมง");
  });

  it("shows the dead and stalled conversion items with their links when the alerts call fails", async () => {
    alertsReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toEqual(["คอนเวอร์ชันส่งไม่ได้ 4 รายการ", "คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ"]));
    expect(fixList().getByText("— โหลดการแจ้งเตือนไม่สำเร็จ")).toBeTruthy();
    expect(fixList().getAllByRole("link", { name: "ดูรายละเอียด" }).map((l) => l.getAttribute("href"))).toEqual(["/conversions?status=dead", "/conversions?period=30d&status=pending"]);
    expect(fixList().queryByText("ไม่มีเรื่องที่ต้องแก้")).toBeNull();
  });

  it("shows the conversion items while the alerts call has not answered", async () => {
    alertsReply = () => new Promise<Response>(() => {});
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toEqual(["คอนเวอร์ชันส่งไม่ได้ 4 รายการ", "คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ"]));
    expect(fixList().getByText("…")).toBeTruthy();
    expect(fixList().getAllByRole("link", { name: "ดูรายละเอียด" })).toHaveLength(2);
    expect(fixList().queryByText("ไม่มีเรื่องที่ต้องแก้")).toBeNull();
  });

  it("shows the alert items and an error line when the conversions call fails, and never claims nothing to fix", async () => {
    conversions = () => json({ error: "core_unavailable" }, 502);
    // One warn alert (a brand without postbacks) stays, so the list has an item to wait for.
    alertsBody = { ...alertsReport, brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "demo06", leads: 5 }] } }, reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } } };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toEqual(["5 ลีดยังไม่มีผลจาก LeadsGate เกิน 24 ชั่วโมง"]));
    expect(fixList().getByText("— โหลดคอนเวอร์ชันไม่สำเร็จ")).toBeTruthy();
    expect(fixList().queryByText("ไม่มีเรื่องที่ต้องแก้")).toBeNull();
  });

  it("shows … for the conversions that still load when the alerts call failed and nothing else is listed", async () => {
    alertsReply = () => json({ error: "core_unavailable" }, 502);
    conversions = () => new Promise<Response>(() => {});
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixList().getByText("— โหลดการแจ้งเตือนไม่สำเร็จ")).toBeTruthy());
    expect(fixList().getAllByText("…")).toHaveLength(1);
    expect(fixTexts()).toEqual([]);
    expect(fixList().queryByText("ไม่มีเรื่องที่ต้องแก้")).toBeNull();
  });

  it("says nothing to fix only when both calls answered and nothing is wrong", async () => {
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { ...CONVERSIONS_OWNER.totals, dead: 0 }, stalled: 0 });
    alertsBody = { ...alertsReport, brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } }, reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } } };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixList().getByText("ไม่มีเรื่องที่ต้องแก้")).toBeTruthy());
    expect(fixTexts()).toEqual([]);
  });

  it("hides the card body behind — when the conversions call fails", async () => {
    conversions = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("—"));
    expect(["ส่งแล้ว", "ค้างส่ง", "ส่งไม่ได้", "ค้างเกิน 6 ชม."].map(cardValue)).toEqual(["—", "—", "—", "—"]);
    expect(card().queryByText("มูลค่าที่ส่งแล้ว")).toBeNull();
    // The alert items stay; no conversion item appears.
    await waitFor(() => expect(fixTexts()).toContain("อัตรา reject 38% สูงกว่าค่าปกติ 10%"));
    expect(fixTexts().some((t) => t?.startsWith("คอนเวอร์ชัน"))).toBe(false);
  });

  it("asks for the daily lead counts of the chosen window and widens today to the last 7 days", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(aggregateQueries()).toEqual([["2026-10-16", "2026-10-22"]]);
    expect(dayTitles()).toEqual([
      "2026-10-16: ลีด 0, ขายได้ 0",
      "2026-10-17: ลีด 0, ขายได้ 0",
      "2026-10-18: ลีด 0, ขายได้ 0",
      "2026-10-19: ลีด 0, ขายได้ 0",
      "2026-10-20: ลีด 0, ขายได้ 0",
      "2026-10-21: ลีด 4, ขายได้ 1",
      "2026-10-22: ลีด 3, ขายได้ 2",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(dayTitles()).toHaveLength(30));
    expect(aggregateQueries()[1]).toEqual(["2026-09-23", "2026-10-22"]);
    expect(dayTitles().slice(-2)).toEqual(["2026-10-21: ลีด 4, ขายได้ 1", "2026-10-22: ลีด 3, ขายได้ 2"]);

    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(aggregateQueries()).toHaveLength(3));
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(aggregateQueries()[2]).toEqual(["2026-10-16", "2026-10-22"]);
  });

  it("shows the daily bars legend and the loading mark until the counts arrive", async () => {
    let release: (response: Response) => void = () => {};
    aggregates = () => new Promise<Response>((resolve) => { release = resolve; });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    expect(dailyPanel().getByText("…")).toBeTruthy();
    expect(screen.getByRole("region", { name: "ลีดรายวัน" }).querySelector("svg")).toBeNull();

    release(json(aggregatesBody("2026-10-16", "2026-10-22")));
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(dailyPanel().queryByText("…")).toBeNull();
    expect(dailyPanel().getByRole("img", { name: "ลีดและยอดขายรายวัน" })).toBeTruthy();
    expect(dailyPanel().getByText("ขายได้")).toBeTruthy();
    expect(dailyPanel().getByText("ลีด", { selector: "li" })).toBeTruthy();
  });

  it("shows — and the failure in the daily bars panel when the aggregates call fails and keeps the other panels", async () => {
    aggregates = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    await waitFor(() => expect(dailyPanel().getByText("— โหลดลีดรายวันไม่สำเร็จ")).toBeTruthy());
    expect(screen.getByRole("region", { name: "ลีดรายวัน" }).querySelector("svg")).toBeNull();
    expect(dailyPanel().queryByText("ยังไม่มีลีดในช่วงนี้")).toBeNull();

    expect(ledgerValue("รายได้").text).toBe("$410");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    await waitFor(() => expect(fixTexts()).toContain("คอนเวอร์ชันส่งไม่ได้ 4 รายการ"));
    expect(document.querySelector(".home-stage.leak")!.textContent).toBe("17ลีด");
  });

  it("shows the empty state when the window has no leads", async () => {
    aggregates = (from, to) => json({ from, to, timezone: "UTC", rows: [] });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(dailyPanel().getByText("ยังไม่มีลีดในช่วงนี้")).toBeTruthy());
    expect(screen.getByRole("region", { name: "ลีดรายวัน" }).querySelector("svg")).toBeNull();
  });

  it("drops a late daily bars answer for an old period", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
    // The 7 day window starts on 2026-10-16 and is still on its way; the 30 day window answers first.
    aggregates = (from, to) => (from === "2026-10-16" ? old : json(aggregatesBody(from, to)));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา $1,780 ได้ 17 ลีด ต้นทุนลีดละ $105");
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(dayTitles()).toHaveLength(30));

    releaseOld(json(aggregatesBody("2026-10-16", "2026-10-22")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dayTitles()).toHaveLength(30);
  });
});

describe("Home screen, employee", () => {
  beforeEach(() => {
    conversions = (period) => json(redact(period === "30d" ? CONVERSIONS_30D : CONVERSIONS_OWNER));
  });

  it("shows visitors, leads, sold and pending with no money and no spend request", async () => {
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");

    expect(ledgerValue("ผู้เข้าเว็บ").text).toBe("283");
    expect(ledgerValue("ลีด").text).toBe("17");
    expect(ledgerValue("ขายได้").text).toBe("4");
    await waitFor(() => expect(ledgerValue("รอผล").text).toBe("5"));

    expect(spend).not.toHaveBeenCalled();
    expect(requests.some((r) => r.startsWith("/api/spend"))).toBe(false);
    expect(document.body.textContent).not.toContain("$");
    expect(screen.queryByText("ค่าโฆษณา")).toBeNull();
    expect(screen.queryByText("รายได้")).toBeNull();
    expect(screen.queryByText("กำไร/ขาดทุน")).toBeNull();
    expect(screen.queryByText("คลิกที่จ่าย")).toBeNull();
    expect([...document.querySelectorAll(".home-stage")].map((s) => s.textContent)).toEqual(["283ถึงเว็บ", "131ถึง /go", "94เปิดฟอร์ม", "17ลีด", "4ขายได้"]);
    // Only the owner can approve a template.
    expect(screen.queryByText("อนุมัติเทมเพลต")).toBeNull();
    expect(await within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" })).findByText("1 แบรนด์")).toBeTruthy();
  });

  it("employee sees no revenue", async () => {
    funnel = (from) => json({ ...(from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D), rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(ledgerValue("รอผล").text).toBe("5"));

    expect(screen.queryByText("รายได้")).toBeNull();
    expect(screen.queryByText("กำไร/ขาดทุน")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$0(?!\.)/);
    expect(document.body.textContent).not.toContain("$");
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("shows visits, leads and sold against the previous window and no delta on pending", async () => {
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(ledgerDelta("ผู้เข้าเว็บ")).toEqual({ text: "▼ 6%", className: "d neg" }));
    expect(ledgerDelta("ลีด")).toEqual({ text: "▲ 70%", className: "d pos" });
    expect(ledgerDelta("ขายได้")).toEqual({ text: "▲ 100%", className: "d pos" });
    await waitFor(() => expect(ledgerValue("รอผล").text).toBe("5"));
    expect(ledgerDelta("รอผล")).toBeNull();
  });

  it("employee gets no revenue delta when the funnel withholds revenue", async () => {
    funnel = (from) => json({ ...(isPreviousFrom(from) ? FUNNEL_BEFORE : FUNNEL_7D), rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(ledgerDelta("ลีด")).toEqual({ text: "0%", className: "d" }));
    expect(screen.queryByText("รายได้")).toBeNull();
    expect(document.body.textContent).not.toContain("$");
  });

  it("employee sees conversion counts without value", async () => {
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    expect(cardValue("ค้างส่ง")).toBe("3");
    expect(cardValue("ส่งไม่ได้")).toBe("4");
    expect(cardValue("ค้างเกิน 6 ชม.")).toBe("1");
    expect(card().queryByText("มูลค่าที่ส่งแล้ว")).toBeNull();
    expect(card().getByRole("link", { name: "ส่งไม่ได้ 4" }).getAttribute("href")).toBe("/conversions?status=dead");
    await waitFor(() => expect(fixTexts()).toContain("คอนเวอร์ชันส่งไม่ได้ 4 รายการ"));
    expect(document.body.textContent).not.toContain("$");
  });

  it("employee sees the daily bars, which carry counts only", async () => {
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(dayTitles()).toHaveLength(7));
    expect(dayTitles().slice(-2)).toEqual(["2026-10-21: ลีด 4, ขายได้ 1", "2026-10-22: ลีด 3, ขายได้ 2"]);
    expect(aggregateQueries()).toEqual([["2026-10-16", "2026-10-22"]]);
    expect(document.body.textContent).not.toContain("$");
  });

  it("hides the uploaded value from an employee even if the response carries it", async () => {
    conversions = () => json(CONVERSIONS_OWNER);
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    expect(card().queryByText("มูลค่าที่ส่งแล้ว")).toBeNull();
    expect(document.body.textContent).not.toContain("$");
  });

  it("shows — for pending when the alerts API fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input), "http://panel.test").pathname;
      if (path === "/api/funnel") return json(FUNNEL_7D);
      return json({ error: "core_unavailable" }, 502);
    });
    render(<HomeScreen me={employee} />);
    await heading("ผู้เข้าเว็บ 283 คน ได้ 17 ลีด ขายได้ 4");
    await waitFor(() => expect(ledgerValue("รอผล").text).toBe("—"));
  });
});
