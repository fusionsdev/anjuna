import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import type { ConversionsReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type Me } from "../src/client/api";
import { clickLossWarning, isStale } from "../src/client/home-metrics";
import { HomeScreen } from "../src/client/screens/Home";
import { IncidentBanner } from "../src/client/screens/home/IncidentBanner";

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
// Spend in baht as the THB accounts bill it, with the server's USD at 35 THB per USD. 62,300 THB is $1,780.
const spendReport = (cost: number, clicks: number, thbPerUsd = 35) => ({
  period: "7d", from: "2026-10-16", to: "2026-10-22", totals: { cost_by_currency: { THB: cost, USD: 0 }, clicks, impressions: 9000 },
  brands: [{ brand_id: "cg", currency: "THB", cost, cost_usd: Math.round((cost / thbPerUsd) * 100) / 100, clicks, impressions: 9000, updated_at: "2026-10-22T09:00:00.000Z" }],
  total_cost_usd: Math.round((cost / thbPerUsd) * 100) / 100, fx: { thbPerUsd },
  daily: [{ date: "2026-10-21", cost: cost * 0.4, currency: "THB" }, { date: "2026-10-22", cost: cost * 0.6, currency: "THB" }],
});
const alertsReport = {
  generated_at: "2026-10-22T10:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "demo06", leads: 5 }] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.05, alert_at: 0.1, samples: [] } },
  reject_rate: { state: "warn", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [{ brand: "Credit Genie", rejected: 5, decided: 13, rate: 0.38 }] } },
};
// Traffic breakdown: form-views from form_started events, /go counted from click_sessions (landing_path='/go').
// cg: 283 reach the site, 94 open the form. go_count is null in this default so most tests exercise the "—" path;
// the tests that need a measured /go override breakdownReply with a value.
const breakdownReport = {
  period: "today", by: "source", from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z", timezone: "America/New_York",
  rows: [],
  brands: [{ brand_id: "cg", hostname: "creditgenie.test", visits: 283, go_count: null, form_views: 94, leads: 17 }],
};
// The same brands with a measured /go, for scenarios that assert the Home /go stage shows a number.
const breakdownWithGo = (go: number) => ({ ...breakdownReport, brands: breakdownReport.brands.map((b) => ({ ...b, go_count: go })) });
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
// Brand ids match the funnel rows. cg and d6 are live, dr is a draft with a form, demo01 is a demo brand the list hides.
const lifecycleBrand = (brand_id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  brand_id, name, account: "acct", hostnames: [`${name.toLowerCase()}.test`], status, current_revision_id: status === "draft" ? null : "rev-1",
  runtime_sync_status: status === "draft" ? "queued" : "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", latest_install: null, ...extra,
});
const BRANDS = [lifecycleBrand("cg", "Creditgenie", "live"), lifecycleBrand("d6", "Sixpack", "live"), lifecycleBrand("dr", "Draftco", "draft"), lifecycleBrand("demo01", "demo01", "live")];
const evidence = (item: string) => ({ item, evidence: {} });
// cg: test sold and drain route done. d6: drain route done, test sold still open.
const checklistsBody = (templateApproved = true) => ({ brands: {
  cg: { checklist: [evidence("test_sold"), evidence("drain_route")], template_approved: templateApproved, template_waiting_id: templateApproved ? null : "tv-2" },
  d6: { checklist: [evidence("drain_route")], template_approved: true, template_waiting_id: null },
  demo01: { checklist: [], template_approved: true, template_waiting_id: null },
} });

let funnel: (from: string) => Response | Promise<Response>;
let conversions: (period: string) => Response | Promise<Response>;
let aggregates: (from: string, to: string) => Response | Promise<Response>;
let alertsBody: unknown;
let alertsReply: () => Response | Promise<Response>;
let brandsReply: () => Response | Promise<Response>;
let checklistsReply: () => Response | Promise<Response>;
let runtimeReply: () => Response | Promise<Response>;
let breakdownReply: () => Response | Promise<Response>;
let spend: ReturnType<typeof vi.fn>;
const realSpend = api.spend;
let requests: string[];
// Answers the per-status upload reads of the brand table. Unset, they fall through to `conversions`.
let convFacts: ((url: URL) => Response | Promise<Response>) | undefined;
let adsReply: () => Response | Promise<Response>;
// The realtime report of one brand, for its gclid warning. Default: plenty of landings, few without a gclid.
let realtimeReply: (brand: string) => Response | Promise<Response>;
// Google Ads state: Creditgenie has an account and an enabled campaign; Sixpack has no account.
const ADS_BODY = {
  campaigns: [{ draft_job_id: "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f", campaign_id: null, brand_id: "cg", account: "1234567890", name: "cg-search-1", daily_budget: 100, currency: "THB", daily_budget_thb: 100, state: "enabled", updated_at: "2026-10-22T00:00:00.000Z", geo: { country: "US" }, final_url: "https://cg.test/" }],
  brands: [{ brand_id: "cg", currency: "THB", thb_per_unit: 1, committed_thb_day: 0 }],
  caps: { total_thb_day: 1000, brand_thb_day: 500 }, enabled_total_thb_day: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
  requests = [];
  convFacts = undefined;
  adsReply = () => json(ADS_BODY);
  realtimeReply = () => json({ kpis: { landing_views: 400, no_gclid_landings: { count: 20, pct: 5 } } });
  funnel = (from) => json(isPreviousFrom(from) ? FUNNEL_BEFORE : from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D);
  conversions = (period) => json(period === "30d" ? CONVERSIONS_30D : CONVERSIONS_OWNER);
  aggregates = (from, to) => json(aggregatesBody(from, to));
  alertsBody = alertsReport;
  alertsReply = () => json(alertsBody);
  brandsReply = () => json({ brands: BRANDS });
  checklistsReply = () => json(checklistsBody());
  runtimeReply = () => json({ brands: [{ brand_id: "cg", status: "live", hostnames: ["creditgenie.test"] }, { brand_id: "d6", status: "live", hostnames: ["sixpack.test"] }] });
  breakdownReply = () => json(breakdownReport);
  spend = vi.fn(async (period: string) => (period === "30d" ? spendReport(84000, 1200) : spendReport(62300, 402)));
  (api as unknown as { spend: unknown }).spend = spend;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "http://panel.test");
    if (url.pathname === "/api/funnel") return funnel(url.searchParams.get("from") ?? "");
    if (url.pathname === "/api/conversions" && convFacts && /status=(uploaded|dead)/.test(input)) return convFacts(url);
    if (url.pathname === "/api/conversions") return conversions(url.searchParams.get("period") ?? "");
    if (url.pathname === "/api/leads/aggregates") return aggregates(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "");
    if (url.pathname === "/api/alerts") return alertsReply();
    if (url.pathname === "/api/templates") return json({ templates: [template("t1", "awaiting_approval"), template("t2", "awaiting_approval"), template("t3", "approved")] });
    if (url.pathname === "/api/lifecycle/brands") return brandsReply();
    if (url.pathname === "/api/ads/campaigns") return adsReply();
    if (url.pathname === "/api/traffic/realtime") return realtimeReply(url.searchParams.get("brand") ?? "");
    if (url.pathname === "/api/traffic/breakdown") return breakdownReply();
    if (url.pathname === "/api/brands/checklists") return checklistsReply();
    if (url.pathname === "/api/brands") return runtimeReply();
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
/** The numbers sentence under the page title. It reads the loaded values, so tests wait on it. */
const heading = (name: string) => screen.findByText(name, { selector: "p.home-summary" });
/** The delta line under a ledger value, `null` when the cell has none. */
const ledgerDelta = (label: string) => {
  const d = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText(label).parentElement!.querySelector(".d");
  return d ? { text: d.textContent, className: d.className } : null;
};
/** The brand table asks once for the last 30 days (its stages) on mount. The period requests are the rest, so that first one is left out. */
const dropFirst = <T,>(list: T[], match: (item: T) => boolean): T[] => { const at = list.findIndex(match); return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]; };
const funnelQueries = () => dropFirst(requests.filter((r) => r.startsWith("/api/funnel")).map((r) => new URL(r, "http://panel.test").searchParams), (q) => q.get("from") === "2026-09-23T00:00:00.000Z" && q.get("to") === "2026-10-23T00:00:00.000Z");
// The brand table asks per status for its upload dots (brand-facts.ts). The period requests are the ones without a status.
const conversionRequests = () => requests.filter((r) => r.startsWith("/api/conversions") && !/[?&]status=(uploaded|dead)/.test(r));
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
/** The count line of one to-do card, by its title. Several cards can read "1 แบรนด์", so a test names the card. */
const taskCount = (title: string) => within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" })).queryByText(title)?.querySelector("span")?.textContent ?? null;
const taskOpen = (title: string) => within(within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" })).getByText(title).parentElement!).getByRole("button", { name: "เปิด" });
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
    breakdownReply = () => json(breakdownWithGo(131));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");

    expect(ledgerValue("ค่าโฆษณา").text).toBe("฿62,300");
    expect(ledgerValue("ต้นทุนต่อลีด").text).toBe("฿3,665");
    expect(ledgerValue("รายได้").text).toBe("$410");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,370", className: "v neg" });

    const stages = [...document.querySelectorAll(".home-stage")].map((s) => s.textContent);
    // /go shows the measured count (131) from the traffic breakdown; เปิดฟอร์ม shows 94. Biggest leak is เปิดฟอร์ม -> ลีด (82%).
    expect(stages).toEqual(["402คลิกที่จ่าย", "283ถึงเว็บ", "131ถึง /go", "94เปิดฟอร์ม", "17ลีด", "4ขายได้"]);
    expect(document.querySelector(".home-stage.leak")!.textContent).toBe("17ลีด");
    expect(document.querySelector(".home-drops .amb")!.textContent).toBe("หลุด 82%");
    expect(document.querySelector(".note")!.textContent).toContain('หลุดมากที่สุดที่ขั้น "เปิดฟอร์ม" ไป "ลีด": จาก 94 เหลือ 17 (82%)');

    const fixes = within(screen.getByRole("region", { name: "ต้องแก้" }));
    expect(await fixes.findByText("demo06")).toBeTruthy();
    expect(fixes.getByText("5 ลีดยังไม่มีผลจาก LeadsGate เกิน 24 ชั่วโมง")).toBeTruthy();
    expect(fixes.getByText("Credit Genie")).toBeTruthy();
    expect(fixes.getByText("อัตรา reject 38% สูงกว่าค่าปกติ 10%")).toBeTruthy();

    await waitFor(() => expect(taskCount("ยืนยัน Test sold")).toBe("1 แบรนด์"));
    expect(taskCount("อนุมัติเทมเพลต")).toBe("2 รายการ");
    // The drafts card counts brands and says so; it opens the drafts list, not a blank wizard.
    expect(taskCount("แบรนด์ที่สร้างค้างไว้")).toBe("1 แบรนด์");
  });

  it("shows the domain for a fix-list brand id, like the Alerts screen", async () => {
    // "cg" is a live brand (creditgenie.test); the fix list must show the domain, not the raw brand id.
    alertsBody = { ...alertsReport, brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "cg", leads: 3 }] } } };
    render(<HomeScreen me={owner} />);
    const fixes = within(screen.getByRole("region", { name: "ต้องแก้" }));
    expect(await fixes.findByText("creditgenie.test")).toBeTruthy();
    expect(fixes.queryByText("cg")).toBeNull();
  });

  it("shows spend and cost per lead in baht with the server's USD spend under it, and profit in USD", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    const spendCell = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText("ค่าโฆษณา").parentElement!;
    expect(spendCell.querySelector(".hint")!.textContent).toBe("≈$1,780");
    // Revenue $410 minus $1,780, never $410 minus 62,300 baht.
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,370", className: "v neg" });
  });

  it("draws a spend sparkline with one point per day of the window from the daily series", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    const spendCell = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText("ค่าโฆษณา").parentElement!;
    const line = within(spendCell).getByRole("img", { name: "ค่าโฆษณารายวัน" }).querySelector("polyline")!;
    // 16 to 22 October is 7 days; only the last two have spend, so the line rises from the floor at the end.
    expect(line.getAttribute("points")!.split(" ")).toHaveLength(7);
    expect(line.getAttribute("points")!.split(" ")[0]!.endsWith(",26")).toBe(true);
    expect(line.getAttribute("points")!.split(" ")[6]!.endsWith(",2")).toBe(true);
  });

  it("draws no sparkline for a single day or when core sends no daily rows", async () => {
    spend.mockResolvedValue({ ...spendReport(62300, 402), period: "today", from: "2026-10-22", to: "2026-10-22", daily: [{ date: "2026-10-22", cost: 62300, currency: "THB" }] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(screen.queryByRole("img", { name: "ค่าโฆษณารายวัน" })).toBeNull();
    cleanup();
    spend.mockResolvedValue({ ...spendReport(62300, 402), daily: [] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(screen.queryByRole("img", { name: "ค่าโฆษณารายวัน" })).toBeNull();
  });

  it("takes profit from the server's total_cost_usd at the owner's rate, not a client-side rate", async () => {
    spend.mockResolvedValue(spendReport(62300, 402, 31.15));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,590", className: "v neg" });
  });

  it("names the paid-click loss in the note when it is the biggest leak", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 900, 800, 700, 600, 500, 5000)] });
    spend.mockResolvedValue(spendReport(91770, 3000));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿91,770 ได้ 600 ลีด ต้นทุนลีดละ ฿153");
    expect(document.querySelector(".home-stage.leak")!.textContent).toBe("900ถึงเว็บ");
    expect(document.querySelector(".home-drops .amb")!.textContent).toBe("หลุด 70%");
    expect(document.querySelector(".note")!.textContent).toContain("Google คิดเงิน 3,000 คลิก มาถึงเว็บจริง 900 คน หายไป 2,100 คลิก (70%)");
  });

  it("opens on today, compares it with yesterday, and switches to 7 days and 30 days", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(screen.getByRole("button", { name: "วันนี้" }).getAttribute("aria-pressed")).toBe("true");
    // Every period asks the funnel twice: the window itself, then the window of equal length before it.
    const funnelQuery = (n: number) => funnelQueries()[n]!;
    expect(funnelQuery(0).get("from")).toBe("2026-10-22T00:00:00.000Z");
    expect(funnelQuery(0).get("to")).toBe("2026-10-23T00:00:00.000Z");
    expect(funnelQuery(1).get("from")).toBe("2026-10-21T00:00:00.000Z");
    expect(funnelQuery(1).get("to")).toBe("2026-10-22T00:00:00.000Z");
    expect(spend).toHaveBeenCalledWith("today");

    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(spend).toHaveBeenCalledWith("7d"));
    await waitFor(() => expect(funnelQueries()).toHaveLength(4));
    expect(funnelQuery(2).get("from")).toBe("2026-10-16T00:00:00.000Z");
    expect(funnelQuery(2).get("to")).toBe("2026-10-23T00:00:00.000Z");
    expect(funnelQuery(3).get("from")).toBe("2026-10-09T00:00:00.000Z");
    expect(funnelQuery(3).get("to")).toBe("2026-10-16T00:00:00.000Z");

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await heading("จ่ายค่าโฆษณา ฿84,000 ได้ 60 ลีด ต้นทุนลีดละ ฿1,400");
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("true");
    expect(funnelQuery(4).get("from")).toBe("2026-09-23T00:00:00.000Z");
    expect(funnelQuery(5).get("from")).toBe("2026-08-24T00:00:00.000Z");
    expect(funnelQuery(5).get("to")).toBe("2026-09-23T00:00:00.000Z");
    expect(spend).toHaveBeenCalledWith("30d");
  });

  it("shows the revenue change against the previous window, the spend change in the neutral colour, and none on cost per lead or profit", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "▼ 32%", className: "d neg" }));
    // Today against yesterday. The spend mock answers 62,300 for both, so the change is 0%, drawn without a good or bad colour.
    await waitFor(() => expect(ledgerDelta("ค่าโฆษณา")).toEqual({ text: "0%", className: "d" }));
    expect(spend).toHaveBeenCalledWith("yesterday");
    expect(ledgerDelta("ต้นทุนต่อลีด")).toBeNull();
    expect(ledgerDelta("กำไร/ขาดทุน")).toBeNull();
  });

  it("shows a dash instead of a percent when the previous revenue is 0", async () => {
    funnel = (from) => json(isPreviousFrom(from) ? { ...FUNNEL_BEFORE, rows: [row("cg", 200, 90, 60, 8, 2, 0)] } : FUNNEL_7D);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
  });

  it("shows a dash for the revenue change when core withheld the revenue", async () => {
    funnel = () => json({ ...FUNNEL_7D, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(ledgerValue("รายได้").text).toBe("—");
  });

  it("keeps the current values and shows a dash when the previous window fails", async () => {
    funnel = (from) => (isPreviousFrom(from) ? json({ error: "core_unavailable" }, 502) : json(FUNNEL_7D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(ledgerDelta("รายได้")).toEqual({ text: "–", className: "d" }));
    expect(ledgerValue("รายได้").text).toBe("$410");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "−$1,370", className: "v neg" });
  });

  it("shows no delta while the previous window loads and drops a late answer for an old period", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
    funnel = (from) => (from.startsWith("2026-10-21") ? old : json(isPreviousFrom(from) ? FUNNEL_BEFORE : from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(ledgerDelta("รายได้")).toBeNull();

    // The 30 day previous window (1500 now against 600 before) answers; then yesterday's window arrives with a different number.
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
    spend.mockResolvedValue({ period: "7d", from: "2026-10-16", to: "2026-10-22", totals: { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 }, brands: [], total_cost_usd: 0, fx: { thbPerUsd: 35 } });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา — ได้ 17 ลีด ต้นทุนลีดละ —");
  });

  it("shows — for every funnel number when the funnel API fails", async () => {
    funnel = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ — ลีด ต้นทุนลีดละ —");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน").text).toBe("—");
    // The funnel API failed, so visits/leads/sold read "—"; the form count comes from the traffic breakdown, which still answered.
    expect([...document.querySelectorAll(".home-stage")].map((s) => s.textContent)).toEqual(["402คลิกที่จ่าย", "—ถึงเว็บ", "—ถึง /go", "94เปิดฟอร์ม", "—ลีด", "—ขายได้"]);
    expect(document.querySelector(".note")).toBeNull();
  });

  it("shows — for revenue and profit when every funnel row has null revenue instead of $0", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, null)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "—", className: "v" });
  });

  it("shows — for revenue and profit when one funnel row has null revenue instead of a partial sum", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [row("cg", 212, 98, 70, 11, 3, null), row("d6", 71, 33, 24, 6, 1, 156)] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(ledgerValue("รายได้").text).toBe("—");
    expect(ledgerValue("กำไร/ขาดทุน")).toEqual({ text: "—", className: "v" });
  });

  it("shows a real 0 for no leads and — for the cost per lead it cannot divide", async () => {
    funnel = () => json({ from: FUNNEL_7D.from, to: FUNNEL_7D.to, rows: [] });
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 0 ลีด ต้นทุนลีดละ —");
    expect(ledgerValue("รายได้").text).toBe("$0");
    expect(ledgerValue("กำไร/ขาดทุน").text).toBe("−$1,780");
  });

  it("opens the matching screen from the buttons", async () => {
    const onGo = vi.fn();
    render(<HomeScreen me={owner} onGo={onGo} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    fireEvent.click(screen.getByRole("button", { name: "+ สร้างแบรนด์ใหม่" }));
    fireEvent.click(screen.getByRole("button", { name: "ดูทั้งหมด" }));
    fireEvent.click(screen.getByRole("button", { name: "แยกตามแบรนด์" }));
    await waitFor(() => expect(taskCount("อนุมัติเทมเพลต")).toBe("2 รายการ"));
    expect(onGo.mock.calls.map((c) => c[0])).toEqual(["new-brand", "alerts", "funnel"]);
    // The templates card opens the list filtered to the versions it counted.
    fireEvent.click(taskOpen("อนุมัติเทมเพลต"));
    expect(window.location.pathname + window.location.search).toBe("/templates?status=awaiting_approval");
  });

  it("opens each brand to-do card on the Brands list with that card's chip in the URL", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(taskCount("ยืนยัน Test sold")).toBe("1 แบรนด์"));
    fireEvent.click(taskOpen("ยืนยัน Test sold"));
    expect(window.location.pathname + window.location.search).toBe("/brands?chip=test-sold");
    fireEvent.click(taskOpen("แบรนด์ที่สร้างค้างไว้"));
    expect(window.location.pathname + window.location.search).toBe("/brands?chip=drafts");
    // No bulk dialog opens on Home any more: the bulk Test sold lives above the filtered list.
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows conversion counts and links the card and the dead count to the Conversions page", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    expect(cardValue("ค้างส่ง")).toBe("3");
    expect(cardValue("ส่งไม่ได้")).toBe("4");
    expect(cardValue("ค้างเกิน 6 ชม.")).toBe("1");
    expect(cardValue("มูลค่าที่ส่งแล้ว")).toBe("$412.50");
    expect(conversionRequests()).toEqual(["/api/conversions?period=today"]);

    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 4" });
    expect(dead.getAttribute("href")).toBe("/conversions?period=today&status=dead");
    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname).toBe("/conversions");
    expect(window.location.search).toBe("?period=today&status=dead");

    window.history.replaceState(null, "", "/");
    const all = card().getByRole("link", { name: "ดูคิว" });
    expect(all.getAttribute("href")).toBe("/conversions?period=today");
    expect(appTakesClick(all)).toBe(true);
    expect(window.location.pathname).toBe("/conversions");
    expect(window.location.search).toBe("?period=today");
  });

  it("keeps the selected period in the card and fix list links", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(cardValue("ส่งไม่ได้")).toBe("9"));

    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 9" });
    expect(dead.getAttribute("href")).toBe("/conversions?period=30d&status=dead");
    expect(card().getByRole("link", { name: "ดูคิว" }).getAttribute("href")).toBe("/conversions?period=30d");
    await waitFor(() => expect(fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ }).map((l) => l.getAttribute("href"))).toEqual(["/conversions?period=30d&status=dead", "/conversions?period=30d&status=pending"]));

    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=30d&status=dead");

    // Today is not the Conversions default, so it stays in the query. 7d is the default and leaves the query out.
    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(card().getByRole("link", { name: "ดูคิว" }).getAttribute("href")).toBe("/conversions?period=today"));
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(card().getByRole("link", { name: "ดูคิว" }).getAttribute("href")).toBe("/conversions"));
  });

  it("keeps the browser default for a ctrl-click, meta-click or middle-click on the card and fix links", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งแล้ว")).toBe("5"));
    const dead = card().getByRole("link", { name: "ส่งไม่ได้ 4" });
    const all = card().getByRole("link", { name: "ดูคิว" });
    for (const link of [dead, all]) {
      expect(appTakesClick(link, { ctrlKey: true })).toBe(false);
      expect(appTakesClick(link, { metaKey: true })).toBe(false);
      expect(appTakesClick(link, { shiftKey: true })).toBe(false);
      expect(appTakesClick(link, { button: 1 })).toBe(false);
    }
    await waitFor(() => expect(fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ })).toHaveLength(2));
    const [deadItem] = fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ });
    expect(appTakesClick(deadItem!, { ctrlKey: true })).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/");

    // A plain left click on the same link stays in the app.
    expect(appTakesClick(dead)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=today&status=dead");
  });

  it("asks for the conversions of the chosen period and drops a late answer for an old one", async () => {
    let releaseOld: (response: Response) => void = () => {};
    const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
    conversions = (period) => (period === "today" ? old : json(CONVERSIONS_30D));
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
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
    expect(conversionRequests()).toEqual(["/api/conversions?period=today", "/api/conversions?period=30d"]);
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

    const links = fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ });
    // Stalled rows count at any age, so their link opens the widest list.
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/conversions?period=today&status=dead", "/conversions?period=30d&status=pending"]);
    expect(appTakesClick(links[1]!)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=30d&status=pending");
    // The postback item opens that brand's leads. The reject item keeps the button that opens the alerts screen.
    expect(fixList().getAllByRole("link", { name: "ดูลีด" })).toHaveLength(1);
    expect(fixList().getAllByRole("button", { name: "ดูรายละเอียด" })).toHaveLength(1);
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
    expect(fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ }).map((l) => l.getAttribute("href"))).toEqual(["/conversions?period=today&status=dead", "/conversions?period=30d&status=pending"]);
    expect(fixList().queryByText("ไม่มีเรื่องที่ต้องแก้")).toBeNull();
  });

  it("shows the conversion items while the alerts call has not answered", async () => {
    alertsReply = () => new Promise<Response>(() => {});
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixTexts()).toEqual(["คอนเวอร์ชันส่งไม่ได้ 4 รายการ", "คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ"]));
    expect(fixList().getByText("…")).toBeTruthy();
    expect(fixList().getAllByRole("link", { name: /^(ลองใหม่|ดูรายละเอียด)$/ })).toHaveLength(2);
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
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
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
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
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
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
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
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
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
    breakdownReply = () => json(breakdownWithGo(131));
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
    await waitFor(() => expect(taskCount("ยืนยัน Test sold")).toBe("1 แบรนด์"));
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
    expect(card().getByRole("link", { name: "ส่งไม่ได้ 4" }).getAttribute("href")).toBe("/conversions?period=today&status=dead");
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

describe("home-metrics: stale spend and click loss", () => {
  it("isStale is true once the newest AdKit sync is older than the limit", () => {
    const now = new Date("2026-10-22T12:30:00.000Z");
    expect(isStale("2026-10-22T10:00:00.000Z", now)).toBe(true);
    expect(isStale("2026-10-22T10:29:59.000Z", now)).toBe(true);
    expect(isStale("2026-10-22T10:30:00.000Z", now)).toBe(false);
    expect(isStale("2026-10-22T12:00:00.000Z", now)).toBe(false);
    expect(isStale("2026-10-22T08:00:00.000Z", now, 6)).toBe(false);
    // A time that cannot be read counts as stale: never show a number of unknown age.
    expect(isStale("not a date", now)).toBe(true);
  });

  it("clickLossWarning needs 20 paid clicks and fewer than 5 percent reaching the site", () => {
    expect(clickLossWarning(170, 141)).toBe(false);
    expect(clickLossWarning(170, 4)).toBe(true);
    expect(clickLossWarning(10, 0)).toBe(false);
    expect(clickLossWarning(20, 0)).toBe(true);
    expect(clickLossWarning(100, 5)).toBe(false);
    expect(clickLossWarning(100, 4)).toBe(true);
  });
});

const brandRow = (id: string) => document.querySelector<HTMLElement>(`[data-brand-id="${id}"]`);
const rowCell = (id: string, col: string) => brandRow(id)?.querySelector(`[data-col="${col}"]`)?.textContent;
const rowButton = (id: string) => brandRow(id)?.querySelector<HTMLButtonElement>("button[data-next-action]");
const brandsRegion = () => screen.getByRole("region", { name: "แบรนด์" });

describe("Home screen, work queue", () => {
  it("puts the incident banner, needs-fix list, human tasks, KPI tiles and brand rows in that order", async () => {
    render(<HomeScreen me={owner} />);
    const banner = await screen.findByRole("alert", { name: "เหตุด่วน" });
    const needsFix = screen.getByRole("region", { name: "ต้องแก้" });
    const tasks = screen.getByRole("region", { name: "งานที่ต้องใช้คน" });
    const kpis = screen.getByRole("group", { name: "สรุปตัวเลข" });
    const brands = brandsRegion();
    const funnelStrip = screen.getByRole("region", { name: "เงินไหลไปถึงไหน" });
    const conversionQueue = screen.getByRole("region", { name: "คอนเวอร์ชัน" });
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const order = [banner, needsFix, tasks, kpis, brands, funnelStrip, conversionQueue];
    for (let i = 1; i < order.length; i++) expect(follows(order[i - 1]!, order[i]!)).toBe(true);
    // Five KPI cards for the owner. The revenue and profit card holds two figures.
    expect(kpis.children).toHaveLength(5);
  });

  it("shows no banner when nothing is urgent", async () => {
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { ...CONVERSIONS_OWNER.totals, dead: 0 }, stalled: 0 });
    alertsBody = { ...alertsReport, reject_rate: { state: "warn", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } } };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งไม่ได้")).toBe("0"));
    expect(screen.queryByRole("alert", { name: "เหตุด่วน" })).toBeNull();
  });

  it("names the paid clicks that never reached the site in the banner", async () => {
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { ...CONVERSIONS_OWNER.totals, dead: 0 }, stalled: 0 });
    // 6,000 paid clicks and 283 visitors: 4.7 percent reached the site.
    spend.mockResolvedValue(spendReport(62300, 6000));
    render(<HomeScreen me={owner} />);
    const banner = await screen.findByRole("alert", { name: "เหตุด่วน" });
    expect(banner.textContent).toContain("Google คิดเงิน 6,000 คลิก แต่มาถึงเว็บเพียง 283 คน");
  });

  it("does not warn about click loss when enough paid clicks reached the site", async () => {
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { ...CONVERSIONS_OWNER.totals, dead: 0 }, stalled: 0 });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(cardValue("ส่งไม่ได้")).toBe("0"));
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    expect(screen.queryByRole("alert", { name: "เหตุด่วน" })).toBeNull();
  });

  it("reads every brand checklist with one request and never asks per brand", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(taskCount("ยืนยัน Test sold")).toBe("1 แบรนด์"));
    expect(requests.filter((r) => r === "/api/brands/checklists")).toHaveLength(1);
    expect(requests.some((r) => /^\/api\/brands\/[^/]+\/checklist$/.test(r))).toBe(false);
  });

  it("the Test sold task opens the Brands list filtered to the brands it counted, with no dialog on Home", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(taskCount("ยืนยัน Test sold")).toBe("1 แบรนด์"));
    fireEvent.click(taskOpen("ยืนยัน Test sold"));
    expect(window.location.pathname + window.location.search).toBe("/brands?chip=test-sold");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows — for the test sold count when the checklist read fails, and keeps the rest", async () => {
    checklistsReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    const todo = within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
    // Test sold and drain route both read their counts from the checklist batch, so both show a dash.
    expect(await todo.findAllByText("— แบรนด์")).toHaveLength(2);
    expect(await todo.findByText("2 รายการ")).toBeTruthy();
  });

  it("opens the Test sold chip of Brands from the Test sold task when the checklist read failed", async () => {
    checklistsReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    const todo = within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
    await todo.findAllByText("— แบรนด์");
    fireEvent.click(taskOpen("ยืนยัน Test sold"));
    expect(window.location.pathname + window.location.search).toBe("/brands?chip=test-sold");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("lists the brands but not demo brands, one button each from nextAction", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")).toBeTruthy());
    expect(brandRow("demo01")).toBeNull();
    expect(rowButton("cg")).toMatchObject({ textContent: "ดูแบรนด์", disabled: false });
    expect(rowButton("cg")!.dataset.nextAction).toBe("open");
    expect(rowButton("d6")!.textContent).toBe("ยืนยันขายทดสอบ");
    expect(rowButton("d6")!.dataset.nextAction).toBe("test-sold");
    expect(rowButton("dr")!.textContent).toBe("ติดตั้ง");
    expect(brandsRegion().querySelectorAll("button[data-next-action]")).toHaveLength(3);
  });

  it("a row button that changes something opens a dialog naming the brand and its domain, and does not navigate", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("d6")).toBeTruthy());
    fireEvent.click(rowButton("d6")!);
    const first = await screen.findByRole("alertdialog");
    expect(first.textContent).toContain("Sixpack");
    expect(first.textContent).toContain("sixpack.test");
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /ยกเลิก/ }));
    cleanup();
    window.history.replaceState(null, "", "/");

    checklistsReply = () => json(checklistsBody(false));
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")!.dataset.nextAction).toBe("approve-template"));
    expect(rowButton("cg")!.textContent).toBe("อนุมัติเทมเพลต");
    fireEvent.click(rowButton("cg")!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Creditgenie");
    expect(dialog.textContent).toContain("creditgenie.test");
    expect(window.location.pathname).toBe("/");
  });

  it("a paused brand's resume button still opens its page", async () => {
    runtimeReply = () => json({ brands: [{ brand_id: "cg", status: "paused" }, { brand_id: "d6", status: "live" }] });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")!.dataset.nextAction).toBe("resume"));
    fireEvent.click(rowButton("cg")!);
    expect(window.location.pathname).toBe("/brands/cg");
  });

  it("offers set-route when the brand has no drain route, and leaves owner-only actions disabled for an employee", async () => {
    checklistsReply = () => json({ brands: { cg: { checklist: [evidence("test_sold")], template_approved: true, template_waiting_id: null }, d6: { checklist: [evidence("drain_route")], template_approved: false, template_waiting_id: "tv-9" } } });
    const { unmount } = render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")!.dataset.nextAction).toBe("set-route"));
    expect(rowButton("cg")).toMatchObject({ textContent: "ตั้งเส้นทาง", disabled: false });
    expect(rowButton("d6")).toMatchObject({ textContent: "อนุมัติเทมเพลต", disabled: false });
    unmount();

    render(<HomeScreen me={employee} />);
    await waitFor(() => expect(rowButton("cg")!.dataset.nextAction).toBe("set-route"));
    expect(rowButton("cg")!.disabled).toBe(true);
    expect(rowButton("cg")!.title).toBe("เฉพาะเจ้าของตั้งเส้นทางได้");
    expect(rowButton("d6")!.disabled).toBe(true);
  });

  it("falls back to the plain open button when the checklist read fails, never inventing an action", async () => {
    checklistsReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")).toBeTruthy());
    expect(rowButton("cg")!.dataset.nextAction).toBe("open");
    expect(rowButton("d6")!.dataset.nextAction).toBe("open");
  });

  it("gives a brand core has paused the same next step as the Brands screen: resume", async () => {
    runtimeReply = () => json({ brands: [{ brand_id: "cg", status: "paused" }, { brand_id: "d6", status: "live" }] });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")!.dataset.nextAction).toBe("resume"));
    expect(rowButton("cg")).toMatchObject({ textContent: "เปิดใช้งานต่อ", disabled: false });
    expect(rowButton("d6")!.dataset.nextAction).toBe("test-sold");
    fireEvent.click(rowButton("cg")!);
    expect(window.location.pathname).toBe("/brands/cg");
  });

  it("treats a failed runtime list as no pause, never inventing one", async () => {
    runtimeReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("d6")!.dataset.nextAction).toBe("test-sold"));
    expect(rowButton("cg")!.dataset.nextAction).toBe("open");
  });

  it("offers no fix button for a brand whose checklist is unknown because core did not answer", async () => {
    checklistsReply = () => json({ brands: {
      cg: { checklist: [], template_approved: true, template_waiting_id: null, unknown: true },
      d6: { checklist: [evidence("drain_route"), evidence("test_sold")], template_approved: true, template_waiting_id: null },
    } });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("cg")).toBeTruthy());
    // No drain route row and no test sold row, yet nothing is offered: the open button shows.
    expect(rowButton("cg")!.dataset.nextAction).toBe("open");
    expect(rowButton("cg")!.disabled).toBe(false);
    expect(rowButton("d6")!.dataset.nextAction).toBe("open");
  });

  it("ranks the brands that need a person first by the kind of the action", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowButton("d6")).toBeTruthy());
    const order = [...brandsRegion().querySelectorAll<HTMLElement>("[data-brand-id]")].map((li) => li.dataset.brandId);
    // d6 (test-sold) and dr (install) need a person; cg only opens.
    expect(order.at(-1)).toBe("cg");
    expect(order.slice(0, 2).sort()).toEqual(["d6", "dr"]);
  });

  it("keeps a broken brand among the 5 rows when 11 healthy brands sort after it", async () => {
    const healthy = Array.from({ length: 11 }, (_, i) => lifecycleBrand(`ok${i}`, `Healthy${i}`, "live"));
    brandsReply = () => json({ brands: [...healthy, lifecycleBrand("bad", "Broken", "live", { runtime_sync_status: "sync_error" })] });
    checklistsReply = () => json({ brands: {} });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("bad")).toBeTruthy());
    expect(brandsRegion().querySelectorAll("[data-brand-id]")).toHaveLength(5);
    expect(brandsRegion().querySelector("[data-brand-id]")!.getAttribute("data-brand-id")).toBe("bad");
    expect(rowButton("bad")!.textContent).toBe("ตรวจสอบ");
  });

  it("shows each brand's leads, spend in baht and cost per lead in baht", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowCell("cg", "spend")).toBe("฿62,300"));
    expect(rowCell("cg", "leads")).toBe("11");
    // 62,300 baht over 11 leads. The server's USD figure never joins a baht number.
    expect(rowCell("cg", "cpl")).toBe("฿5,664");
    // d6 has leads but no spend row: nothing was synced, so spend and cost per lead are unknown.
    expect(rowCell("d6", "leads")).toBe("6");
    expect(rowCell("d6", "spend")).toBe("—");
    expect(rowCell("d6", "cpl")).toBe("—");
    expect(brandsRegion().textContent).not.toContain("$");
  });

  it("shows — for spend and cost per lead of a brand whose AdKit data is older than 2 hours", async () => {
    const report = spendReport(62300, 402);
    // The system time is 10:00 UTC; 06:00 is 4 hours old.
    spend.mockResolvedValue({ ...report, brands: report.brands.map((b) => ({ ...b, updated_at: "2026-10-22T06:00:00.000Z" })) });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowCell("cg", "leads")).toBe("11"));
    expect(rowCell("cg", "spend")).toBe("—");
    expect(rowCell("cg", "cpl")).toBe("—");
  });

  it("keeps a fresh brand's numbers while a stale brand shows —", async () => {
    const report = spendReport(62300, 402);
    spend.mockResolvedValue({ ...report, brands: [...report.brands, { ...report.brands[0]!, brand_id: "d6", cost: 7000, cost_usd: 200, updated_at: "2026-10-22T03:00:00.000Z" }] });
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowCell("cg", "spend")).toBe("฿62,300"));
    expect(rowCell("d6", "spend")).toBe("—");
    expect(rowCell("d6", "cpl")).toBe("—");
  });

  it("gives an employee the brand rows without spend, cost per lead or any dollar sign", async () => {
    render(<HomeScreen me={employee} />);
    await waitFor(() => expect(rowButton("cg")).toBeTruthy());
    expect(rowCell("cg", "leads")).toBe("11");
    expect(brandRow("cg")!.querySelector('[data-col="spend"]')).toBeNull();
    expect(brandRow("cg")!.querySelector('[data-col="cpl"]')).toBeNull();
    expect(brandsRegion().textContent).not.toMatch(/฿|\$/);
  });

  it("shows — for leads when the funnel fails and an error line when the brand list fails", async () => {
    funnel = () => json({ error: "core_unavailable" }, 502);
    const { unmount } = render(<HomeScreen me={owner} />);
    await waitFor(() => expect(rowCell("cg", "leads")).toBe("—"));
    unmount();

    brandsReply = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    expect(await within(screen.getByRole("region", { name: "แบรนด์" })).findByText("— โหลดรายการแบรนด์ไม่สำเร็จ")).toBeTruthy();
  });
});

describe("Home screen, v9 layout", () => {
  it("heads the page หน้าแรก with the Thai date, the range toggle, the comparison text and the create button", async () => {
    render(<HomeScreen me={owner} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("หน้าแรก");
    expect(screen.getByText(/วันพฤหัสบดีที่ 22 ตุลาคม 2569|วันพฤหัสบดี 22 ตุลาคม 2569/)).toBeTruthy();
    expect(screen.getByText("เทียบกับเมื่อวาน")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    expect(screen.getByText("เทียบกับ 30 วันก่อนหน้า")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ สร้างแบรนด์ใหม่" })).toBeTruthy();
  });

  it("gives each fix item the button its kind names: ลองใหม่, ตั้ง drain route, ตรวจ gclid, else ดูรายละเอียด", async () => {
    // The list shows 4 items. The alert items are quiet here so the drain route and gclid items fit; ดูลีด is covered with the alert items above.
    const quiet = { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } };
    alertsBody = { ...alertsReport, brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } }, reject_rate: quiet };
    // d6 has no drain route row, and Google billed 6,000 clicks of which 283 reached the sites.
    checklistsReply = () => json({ brands: { ...checklistsBody().brands, d6: { checklist: [evidence("test_sold")], template_approved: true, template_waiting_id: null } } });
    spend = vi.fn(async () => spendReport(62300, 6000));
    (api as unknown as { spend: unknown }).spend = spend;
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(fixList().getByRole("button", { name: "ตั้ง drain route" })).toBeTruthy());
    expect(fixList().getByRole("link", { name: "ลองใหม่" }).getAttribute("href")).toBe("/conversions?period=today&status=dead");
    expect(fixList().getByRole("link", { name: "ตรวจ gclid" }).getAttribute("href")).toBe("/traffic");
    // The stalled conversions item has no kind of its own.
    expect(fixList().getByRole("link", { name: "ดูรายละเอียด" }).getAttribute("href")).toBe("/conversions?period=30d&status=pending");
  });

  it("adds a ตั้ง drain route row to the work list with the brand count", async () => {
    checklistsReply = () => json({ brands: { ...checklistsBody().brands, d6: { checklist: [evidence("test_sold")], template_approved: true, template_waiting_id: null } } });
    render(<HomeScreen me={owner} />);
    const todo = within(screen.getByRole("region", { name: "งานที่ต้องใช้คน" }));
    await waitFor(() => expect(todo.getByText("ตั้ง drain route").querySelector("span")!.textContent).toBe("1 แบรนด์"));
  });

  it("shows seven stage dots per brand and the brand count on the link that opens every brand", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")).toBeTruthy());
    const dots = brandRow("cg")!.querySelector('[role="img"]')!;
    expect(dots.querySelectorAll(".stage-dot")).toHaveLength(7);
    expect(dots.getAttribute("aria-label")).toContain("สร้าง: เสร็จ");
    expect(dots.getAttribute("aria-label")).toContain("เทมเพลต: เสร็จ");
    // Creditgenie has leads in the 30 day funnel and a test sold row.
    expect(dots.getAttribute("aria-label")).toContain("ลีด: เสร็จ");
    expect(dots.getAttribute("aria-label")).toContain("ขายได้: เสร็จ");
    // Three brands are listed: the two live ones and the draft. The demo brand is not.
    expect(within(brandsRegion()).getByRole("link", { name: "ดูทั้งหมด 3" })).toBeTruthy();
  });

  it("shows the Google Ads chip of each brand from today's spend", async () => {
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent).toBe("ใช้งาน"));
    // d6 has no spend rows, so no account is connected to it.
    expect(brandRow("d6")!.querySelector('[data-col="ads"]')!.textContent).toBe("ยังไม่เชื่อม");
  });

  it("closes the queue card with sold = sent + failed + waiting, waiting counting the rows in flight", async () => {
    // 12 sold = 5 sent + 4 failed + (1 pending + 2 processing): one period, every brand, nothing left over.
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { pending: 1, processing: 2, uploaded: 5, dead: 4 } });
    funnel = (from) => json(isPreviousFrom(from) ? FUNNEL_BEFORE : { ...FUNNEL_7D, rows: [row("cg", 212, 98, 70, 11, 12, 254)] });
    render(<HomeScreen me={owner} />);
    const line = await screen.findByTestId("reconciliation");
    await waitFor(() => expect(line.textContent).toBe("กระทบยอด: ขายได้ 12 = ส่งแล้ว 5 + ส่งไม่ได้ 4 + ค้างส่ง 3"));
    expect(screen.getByRole("link", { name: "ดูคิว" }).getAttribute("href")).toBe("/conversions?period=today");
  });

  it("shows the gap instead of hiding it when the two sides do not match", async () => {
    conversions = () => json({ ...CONVERSIONS_OWNER, totals: { pending: 1, processing: 0, uploaded: 5, dead: 4 } });
    funnel = (from) => json(isPreviousFrom(from) ? FUNNEL_BEFORE : { ...FUNNEL_7D, rows: [row("cg", 212, 98, 70, 11, 12, 254)] });
    render(<HomeScreen me={owner} />);
    const line = await screen.findByTestId("reconciliation");
    await waitFor(() => expect(line.textContent).toBe("กระทบยอด: ขายได้ 12 = ส่งแล้ว 5 + ส่งไม่ได้ 4 + ค้างส่ง 1 · ต่างกัน +2"));
  });

  it("hides the reconciliation line while a source loads or when one fails", async () => {
    conversions = () => json({ error: "bad_gateway" }, 502);
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    await waitFor(() => expect(within(screen.getByRole("region", { name: "คอนเวอร์ชัน" })).queryByText(/กระทบยอด/)).toBeNull());
    expect(screen.queryByTestId("reconciliation")).toBeNull();
  });

  it("lists every line the incident banner counts, each with its own button, and no page-wide button whose page counts differently", async () => {
    // 6,000 paid clicks and 283 visitors adds the click-loss line to the dead conversions line.
    spend.mockResolvedValue(spendReport(62300, 6000));
    render(<HomeScreen me={owner} />);
    const banner = await screen.findByRole("alert", { name: "เหตุด่วน" });
    await waitFor(() => expect(banner.querySelectorAll("li")).toHaveLength(2));
    const count = Number(/มีเรื่องด่วน (\d+) เรื่อง/.exec(banner.textContent ?? "")![1]);
    const lines = [...banner.querySelectorAll("li")];
    expect(lines).toHaveLength(count);
    for (const line of lines) expect(line.querySelectorAll("a, button")).toHaveLength(1);
    expect(within(banner).getByRole("link", { name: "ลองใหม่" }).getAttribute("href")).toBe("/conversions?period=today&status=dead");
    expect(within(banner).getByRole("link", { name: "ตรวจ gclid" }).getAttribute("href")).toBe("/traffic");
    expect(within(banner).queryByRole("button", { name: "การแจ้งเตือน" })).toBeNull();
    expect(within(banner).queryByRole("button", { name: "ดูคิว" })).toBeNull();
  });

  it("shows the first 5 banner lines and a toggle that reveals the rest in place, with the count staying the total", () => {
    const urgent = Array.from({ length: 7 }, (_, i) => ({ id: `alert:${i}`, level: "bad" as const, brand: `brand-${i}`, message: `ลีดโดนปฏิเสธ ${i}`, path: `/alerts?brand=brand-${i}` }));
    render(<IncidentBanner urgent={urgent} clickLoss={{ paid: 6000, reached: 283 }} />);
    const banner = screen.getByRole("alert", { name: "เหตุด่วน" });
    expect(within(banner).getByText("มีเรื่องด่วน 8 เรื่อง")).toBeTruthy();
    expect(banner.querySelectorAll("li")).toHaveLength(5);
    expect(within(banner).queryByText(/brand-5/)).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "ดูทั้งหมด (8)" }));
    expect(banner.querySelectorAll("li")).toHaveLength(8);
    expect(within(banner).getByText(/Google คิดเงิน/)).toBeTruthy();
    expect(within(banner).getByText("มีเรื่องด่วน 8 เรื่อง")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    fireEvent.click(within(banner).getByRole("button", { name: "ย่อ" }));
    expect(banner.querySelectorAll("li")).toHaveLength(5);
  });

  it("shows no toggle when the banner has 5 lines or fewer", () => {
    const urgent = Array.from({ length: 5 }, (_, i) => ({ id: `alert:${i}`, level: "bad" as const, brand: `brand-${i}`, message: "ลีดโดนปฏิเสธ" }));
    render(<IncidentBanner urgent={urgent} clickLoss={null} />);
    const banner = screen.getByRole("alert", { name: "เหตุด่วน" });
    expect(banner.querySelectorAll("li")).toHaveLength(5);
    expect(within(banner).queryByRole("button", { name: /ดูทั้งหมด/ })).toBeNull();
  });
});

describe("Home screen, facts behind the brand table", () => {
  const convRow = (brand: string, status: string) => ({ lead_id: `${brand}-1`, brand, status, reason_code: null, last_error: null, click_type: null, attempts: 1, value: null, currency: "THB", occurred_at: "2026-10-20T00:00:00.000Z", created_at: "2026-10-20T00:00:00.000Z", updated_at: "2026-10-20T00:00:00.000Z", next_attempt_at: null });
  const page = (rows: ReturnType<typeof convRow>[], truncated: boolean) => ({ ...CONVERSIONS_OWNER, rows, truncated });
  const dotsOf = (id: string) => brandRow(id)!.querySelector('[role="img"]')!.getAttribute("aria-label")!;

  it("reads the upload dot of a brand exactly when the page of 200 rows is full of other brands", async () => {
    // The big page holds only Sixpack rows and is cut. Creditgenie has an uploaded row that the cut left out: its own read finds it.
    convFacts = (url) => {
      const brand = url.searchParams.get("brand");
      const status = url.searchParams.get("status")!;
      if (brand) return json(page(brand === "cg" && status === "uploaded" ? [convRow("cg", "uploaded")] : [], false));
      return json(page(status === "uploaded" ? [convRow("d6", "uploaded")] : [], true));
    };
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(dotsOf("cg")).toContain("อัปโหลด: เสร็จ"));
    expect(dotsOf("d6")).toContain("อัปโหลด: เสร็จ");
    expect(requests.filter((r) => /status=uploaded&brand=cg&limit=1/.test(r))).toHaveLength(1);
  });

  it("shows a dead conversion as a failed upload dot", async () => {
    convFacts = (url) => json(page(url.searchParams.get("status") === "dead" ? [convRow("cg", "dead")] : [], false));
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(dotsOf("cg")).toContain("อัปโหลด: ล้มเหลว"));
  });

  it("reads the upload dot as ไม่ทราบ, never done, when both reads fail", async () => {
    convFacts = () => json({ error: "bad_gateway" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(dotsOf("cg")).toContain("อัปโหลด: ไม่ทราบ");
    expect(dotsOf("cg")).not.toContain("อัปโหลด: เสร็จ");
  });

  it("does not call an upload done when uploaded answered but the dead read failed", async () => {
    // Uploaded has a row for Creditgenie; the dead read fails. "No dead conversion" is not known, so the dot is unknown, not done.
    convFacts = (url) => (url.searchParams.get("status") === "dead" ? json({ error: "bad_gateway" }, 502) : json(page([convRow("cg", "uploaded")], false)));
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(dotsOf("cg")).toContain("อัปโหลด: ไม่ทราบ");
    expect(dotsOf("cg")).not.toContain("อัปโหลด: เสร็จ");
    expect(brandRow("cg")!.querySelector('[data-stage="อัปโหลด"]')!.getAttribute("title")).toBe("อัปโหลด · ไม่ทราบ");
  });

  it("keeps the Google Ads chip the same when the period changes: it reads today's spend and the campaigns, not the chosen window", async () => {
    render(<HomeScreen me={owner} />);
    const chip = () => brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent;
    await waitFor(() => expect(chip()).toBe("ใช้งาน"));
    for (const label of ["7 วัน", "30 วัน", "วันนี้"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true"));
      expect(chip()).toBe("ใช้งาน");
    }
  });

  it("shows ไม่มี gclid when the brand's landings of the last 24 hours had too few gclids, and keeps it across periods", async () => {
    realtimeReply = (brand) => json({ kpis: { landing_views: 300, no_gclid_landings: { count: brand === "cg" ? 120 : 3, pct: brand === "cg" ? 40 : 1 } } });
    render(<HomeScreen me={owner} />);
    const chip = () => brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent;
    await waitFor(() => expect(chip()).toBe("ไม่มี gclid (24 ชม.)"));
    for (const label of ["7 วัน", "30 วัน", "วันนี้"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true"));
      expect(chip()).toBe("ไม่มี gclid (24 ชม.)");
    }
    // Asked for 24 hours and for the brand that spends today only (Sixpack has no spend row).
    const asked = requests.filter((r) => r.startsWith("/api/traffic/realtime"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => r === "/api/traffic/realtime?period=24h&brand=cg")).toBe(true);
  });

  it("keeps ใช้งาน when the gclid read fails, and never asks for an employee", async () => {
    realtimeReply = () => json({ error: "bad_gateway" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent).toBe("ใช้งาน"));
    cleanup();
    requests = [];
    render(<HomeScreen me={employee} />);
    await waitFor(() => expect(brandRow("cg")).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(requests.some((r) => r.startsWith("/api/traffic/realtime"))).toBe(false);
  });

  it("shows a dash in the Google Ads cell while the campaigns read fails, never not connected", async () => {
    adsReply = () => json({ error: "bad_gateway" }, 502);
    render(<HomeScreen me={owner} />);
    await waitFor(() => expect(brandRow("cg")).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent).toBe("—");
  });

  it("gives an employee the chip the campaigns show, without spend: เปิดแล้ว for an enabled campaign", async () => {
    render(<HomeScreen me={employee} />);
    await waitFor(() => expect(brandRow("cg")!.querySelector('[data-col="ads"]')!.textContent).toBe("เปิดแล้ว"));
    expect(brandRow("d6")!.querySelector('[data-col="ads"]')!.textContent).toBe("ยังไม่เชื่อม");
  });
});

describe("Home screen, spend change and funnel strip", () => {
  const thirtyDays = (recent: number, older: number) => {
    const daily = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 23 + i)).toISOString().slice(0, 10), cost: i >= 23 ? recent : i >= 16 ? older : 100, currency: "THB" as const }));
    return { ...spendReport(84000, 1200), period: "30d", from: "2026-09-23", to: "2026-10-22", daily };
  };

  it("compares 7 days with the 7 days before from the daily rows, and says so in the neutral colour", async () => {
    spend = vi.fn(async (period: string) => (period === "30d" ? thirtyDays(2000, 1000) : spendReport(14000, 400)));
    (api as unknown as { spend: unknown }).spend = spend;
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿14,000 ได้ 17 ลีด ต้นทุนลีดละ ฿824");
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(ledgerDelta("ค่าโฆษณา")).toEqual({ text: "▲ 100%", className: "d" }));
  });

  it("shows a dash for the spend change over 30 days and when the earlier window cannot be read", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await waitFor(() => expect(ledgerDelta("ค่าโฆษณา")).toEqual({ text: "–", className: "d" }));
    // 7 days with only two daily rows: the earlier week is not in the report, so it is a dash too.
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(ledgerDelta("ค่าโฆษณา")).toEqual({ text: "–", className: "d" }));
  });

  it("draws each stage of the funnel with a horizontal bar sized against the largest stage", async () => {
    render(<HomeScreen me={owner} />);
    await heading("จ่ายค่าโฆษณา ฿62,300 ได้ 17 ลีด ต้นทุนลีดละ ฿3,665");
    const bars = [...document.querySelectorAll<HTMLElement>(".home-stage .home-bar")];
    expect(bars.length).toBeGreaterThan(3);
    expect(bars.every((bar) => bar.style.width.endsWith("%") && bar.style.height === "")).toBe(true);
    expect(Math.max(...bars.map((bar) => parseInt(bar.style.width, 10)))).toBe(100);
  });
});
