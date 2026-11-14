import type { AlertsReportResponse, ConversionRow, ConversionsReportResponse, LifecycleBrandSummary } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { resetAlertSession } from "../src/client/alerts-session";
import { hostnameBrand } from "../src/client/alert-incidents";
import { brandsPath, routePath, templatesPath } from "../src/client/router";
import { HomeScreen } from "../src/client/screens/Home";
import { conversionsPath } from "../src/client/screens/Conversions";
import { clickRange, clickTotals, taskRows } from "../src/client/task-rows";

// FUS-393: Home is งานรอทำ. The money content it held moved to /money (money.ui.test.tsx).

const owner = { id: "o", email: "o@example.test", role: "owner" } as Me;
const employee = { id: "e", email: "e@example.test", role: "employee" } as Me;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Open: the stalled queue (warn, no brand), cg without buyer results (alert) and d6 rejecting leads (warn).
const ALERTS = {
  generated_at: "2026-10-22T10:00:00.000Z",
  conversion_stalled: { state: "warn", detail: { max_hours: 6, stuck_count: 2, oldest_created_at: "2026-09-01T00:00:00.000Z" } },
  brands_without_postbacks: { state: "alert", detail: { window_hours: 24, brands: [{ brand: "cg", leads: 5 }] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.05, alert_at: 0.1, samples: [] } },
  reject_rate: { state: "warn", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [{ brand: "d6", rejected: 5, decided: 13, rate: 0.38 }] } },
  click_risk: { state: "ok", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [] } },
} as unknown as AlertsReportResponse;
const HEALTHY = {
  ...ALERTS,
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } },
  reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.2, brands: [] } },
} as unknown as AlertsReportResponse;

const brand = (brand_id: string, name: string, status: string): LifecycleBrandSummary => ({
  brand_id, name, account: "acct", hostnames: [`${name.toLowerCase()}.test`], status, current_revision_id: status === "draft" ? null : "rev-1",
  runtime_sync_status: status === "draft" ? "queued" : "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", latest_install: null,
} as unknown as LifecycleBrandSummary);
// cg is done; d6 still needs a test sale; e7 needs a sale route and a test sale; dr is a draft; demo01 is hidden by the default scope.
const BRANDS = [brand("cg", "Creditgenie", "live"), brand("d6", "Sixpack", "live"), brand("e7", "Sevenco", "live"), brand("dr", "Draftco", "draft"), brand("demo01", "demo01", "live")];
const evidence = (item: string) => ({ item, evidence: {} });
const CHECKLISTS = { brands: {
  cg: { checklist: [evidence("test_sold"), evidence("drain_route")], template_approved: true, template_waiting_id: null },
  d6: { checklist: [evidence("drain_route")], template_approved: true, template_waiting_id: null },
  e7: { checklist: [], template_approved: true, template_waiting_id: null },
  demo01: { checklist: [], template_approved: true, template_waiting_id: null },
} };
const template = (id: string, status: string, similarity_fail_count = 0) => ({ template_version_id: id, template_id: id, name: id, version: 7, status, archived: false, submitted_by_label: null, created_at: "2026-10-20", sealed_at: null, thumbnail_url: null, brands_using: 0, similarity_fail_count });
const TEMPLATES = [template("tv_ok", "awaiting_approval"), template("tv_iriswell", "awaiting_approval", 5), template("tv_done", "approved")];
const deadRow = (lead: string, reason_code: ConversionRow["reason_code"], last_error: string | null): ConversionRow => ({
  lead_id: lead, brand: "cg", status: "dead", reason_code, last_error, click_type: "gclid", attempts: 5, value: 10, currency: "USD",
  occurred_at: "2026-10-20T00:00:00.000Z", created_at: "2026-10-20T00:00:00.000Z", updated_at: "2026-10-20T00:00:00.000Z", next_attempt_at: null,
} as ConversionRow);
// Two one-per-click refusals, one AdKit failure and one row without a click id.
const DEAD: ConversionsReportResponse = {
  period: "30d", from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z",
  totals: { pending: 0, processing: 0, uploaded: 0, dead: 4 }, value_totals: null, stalled: 0, truncated: false,
  rows: [
    deadRow("l1", "platform_error", "CLICK_CONVERSION_ALREADY_EXISTS"),
    deadRow("l2", "platform_error", "one conversion per click"),
    deadRow("l3", "upload_failed", "Command failed: adkit upload"),
    deadRow("l4", "no_click_id", null),
  ],
};

// Today's paid clicks and funnel clicks for cg. 170 paid and 141 reached the site raise no click loss row.
const spendReport = (clicks: number) => ({
  period: "today", from: "2026-10-22", to: "2026-10-22", totals: { cost_by_currency: { THB: 100, USD: 0 }, clicks, impressions: 1000 },
  brands: [{ brand_id: "cg", currency: "THB", cost: 100, clicks, impressions: 1000, updated_at: "2026-10-22T09:00:00.000Z", cost_usd: 3 }], total_cost_usd: 3, fx: { thbPerUsd: 33 },
});
const funnelReport = (clicks: number) => ({
  from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z",
  rows: [{ brand: "cg", keyword: null, variant: null, clicks, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: null, sold_rate: null }],
});

let replies: Record<string, () => Response | Promise<Response>>;
let requests: string[];

beforeEach(() => {
  requests = [];
  replies = {
    "/api/alerts": () => json(ALERTS),
    "/api/alerts/state": () => json({ rows: [], next_cursor: null }),
    "/api/lifecycle/brands": () => json({ brands: BRANDS }),
    "/api/brands": () => json({ brands: [{ brand_id: "cg", status: "live", hostnames: ["creditgenie.test"] }], generated_at: "2026-10-22T10:00:00.000Z" }),
    "/api/brands/checklists": () => json(CHECKLISTS),
    "/api/templates": () => json({ templates: TEMPLATES, categories: [] }),
    "/api/conversions": () => json(DEAD),
    "/api/spend": () => json(spendReport(170)),
    "/api/funnel": () => json(funnelReport(141)),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const reply = replies[new URL(input, "http://panel.test").pathname];
    if (!reply) throw new Error(`Unexpected test HTTP request: ${input}`);
    return reply();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetAlertSession();
  window.history.replaceState(null, "", "/");
});

const rows = () => [...document.querySelectorAll<HTMLLIElement>(".task-row")];
const rowOf = (where: string) => rows().find((row) => row.querySelector(".task-where")?.textContent === where)!;
const button = (row: HTMLElement) => row.querySelector<HTMLAnchorElement>(".task-act a")!;
const loaded = () => waitFor(() => expect(screen.queryByText("…")).toBeNull());

describe("งานรอทำ (FUS-393)", () => {
  it("lists every task most urgent first, with the level tag, where, title, cause and one button", async () => {
    render(<HomeScreen me={owner} />);
    await loaded();
    expect(rows().map((row) => [row.querySelector(".chip")!.textContent, row.querySelector(".task-where")!.textContent, row.querySelector(".task-title")!.textContent])).toEqual([
      ["ด่วน", "creditgenie.test", "ยังไม่ได้ผลจากผู้ซื้อ"],
      // A 38% reject rate is past alert_at, so it sorts before the stalled warning.
      ["ด่วน", "sixpack.test", "ลีดโดนปฏิเสธ 38%"],
      ["ด่วน", "ทุกแบรนด์", "คอนเวอร์ชันค้าง"],
      ["ด่วน", "sevenco.test", "Google Ads ยังไม่รู้ว่าขายได้"],
      ["รอทำ", "2 แบรนด์", "ยังไม่ได้ทดสอบการขาย"],
      ["รอทำ", "เทมเพลต tv_ok v7", "รออนุมัติ"],
      ["รอทำ", "เทมเพลต tv_iriswell v7", "รออนุมัติ แต่หน้าตาซ้ำกับแบรนด์อื่น"],
      ["รอทำ", "แบรนด์ที่สร้างค้างไว้ 1 แบรนด์", "สร้างแบรนด์ยังไม่เสร็จ"],
      ["ระบบ", "ส่งยอดขายให้ Google Ads", "ส่งยอดขายไม่สำเร็จ 4 รายการ"],
    ]);
    // The dead row's cause is one line of counts per class.
    expect(rowOf("ส่งยอดขายให้ Google Ads").querySelector(".task-cause")!.textContent).toBe("ส่งซ้ำ 2 · AdKit ขัดข้อง 1 · ไม่มีรหัสคลิก 1");
    expect(screen.getByText("มี 9 เรื่อง ด่วน 4 เรื่อง เรื่องที่เสียเงินมากสุดอยู่บนสุด กดปุ่มในแถวเพื่อแก้ได้เลย")).toBeTruthy();
    expect(screen.getByText('เลข 9 บนเมนู "งานรอทำ" นับจากรายการในหน้านี้ ทุกหน้าจะเห็นเลขเดียวกัน')).toBeTruthy();
    expect(within(rowOf("แบรนด์ที่สร้างค้างไว้ 1 แบรนด์")).getByText("Draftco")).toBeTruthy();
    // Every row has exactly one button, except the blocked template, whose disabled button sits beside its side link.
    for (const row of rows()) expect(row.querySelectorAll(".task-act a").length).toBe(1);
  });

  it("gives each row the button that opens its fix", async () => {
    render(<HomeScreen me={owner} />);
    await loaded();
    expect(button(rowOf("creditgenie.test")).getAttribute("href")).toBe("/leads?brand=cg&status=pending");
    // FUS-392 carry-over: the stalled row uses the alert's own cutoff (generated_at minus max_hours), so rows older than 30 days stay listed.
    expect(button(rowOf("ทุกแบรนด์")).getAttribute("href")).toBe(`/conversions?${new URLSearchParams({ status: "pending", created_before: "2026-10-22T04:00:00.000Z" })}`);
    expect(button(rowOf("sixpack.test")).getAttribute("href")).toMatch(/^\/leads\?brand=d6&status=rejected&time=decided&from=/);
    expect(button(rowOf("sevenco.test"))).toMatchObject({ textContent: "ตั้งค่า 1 แบรนด์" });
    expect(button(rowOf("sevenco.test")).getAttribute("href")).toBe(brandsPath("drain-route"));
    expect(button(rowOf("2 แบรนด์")).getAttribute("href")).toBe(brandsPath("test-sold"));
    expect(button(rowOf("เทมเพลต tv_ok v7")).getAttribute("href")).toBe(templatesPath("awaiting_approval"));
    expect(button(rowOf("แบรนด์ที่สร้างค้างไว้ 1 แบรนด์"))).toMatchObject({ textContent: "สร้างต่อ" });
    expect(button(rowOf("แบรนด์ที่สร้างค้างไว้ 1 แบรนด์")).getAttribute("href")).toBe(brandsPath("drafts"));
    const dead = button(rowOf("ส่งยอดขายให้ Google Ads"));
    expect(dead.textContent).toBe("ดูทั้ง 4 รายการ");
    expect(dead.getAttribute("href")).toBe(conversionsPath({ period: "30d", status: "dead", brand: null }));
    fireEvent.click(dead);
    expect(window.location.pathname + window.location.search).toBe("/conversions?period=30d&status=dead");
  });

  it("shows a template that fails the similarity check as ยังอนุมัติไม่ได้ with a link to the failed checks of that version", async () => {
    render(<HomeScreen me={owner} />);
    await loaded();
    const row = within(rowOf("เทมเพลต tv_iriswell v7"));
    expect((row.getByRole("button", { name: "ยังอนุมัติไม่ได้" }) as HTMLButtonElement).disabled).toBe(true);
    // The link opens the version drawer, not the list.
    expect(row.getByRole("link", { name: "ดูข้อที่ไม่ผ่าน" }).getAttribute("href")).toBe(routePath({ view: "templates", templateId: "tv_iriswell" }));
    expect(row.getByText("เช็กความซ้ำไม่ผ่าน 5 ข้อ ต้องแก้ให้ผ่านก่อนถึงจะอนุมัติได้")).toBeTruthy();
  });

  it("filters by chip and shows each chip's count", async () => {
    render(<HomeScreen me={owner} />);
    await loaded();
    const chips = within(screen.getByRole("group", { name: "กรองงาน" }));
    expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual(["ทั้งหมด 9", "ด่วน 4", "แบรนด์ 5", "เทมเพลต 2", "ระบบ 2"]);
    fireEvent.click(chips.getByRole("button", { name: "ด่วน 4" }));
    expect(rows().map((row) => row.dataset.level)).toEqual(["urgent", "urgent", "urgent", "urgent"]);
    fireEvent.click(chips.getByRole("button", { name: "ระบบ 2" }));
    expect(rows().map((row) => row.querySelector(".task-title")!.textContent)).toEqual(["คอนเวอร์ชันค้าง", "ส่งยอดขายไม่สำเร็จ 4 รายการ"]);
    // The header and footer keep the total: the sidebar badge counts every row.
    expect(screen.getByText(/^เลข 9 บนเมนู/)).toBeTruthy();
  });

  it("drops an alert that was closed, like the Alerts screen", async () => {
    replies["/api/alerts/state"] = () => json({ rows: [{ alert_key: "brands_without_postbacks:cg", state: "alert", first_seen: "2026-10-22T00:00:00.000Z", last_sent: null, acknowledged_by: null, acknowledged_at: null, closed_at: "2026-10-22T09:00:00.000Z", updated_at: "2026-10-22T09:00:00.000Z" }], next_cursor: null });
    render(<HomeScreen me={owner} />);
    await loaded();
    expect(rowOf("creditgenie.test")).toBeUndefined();
    expect(rows()).toHaveLength(8);
  });

  it("the sidebar badge count equals the rendered rows: the server-shaped inputs give the same count", async () => {
    render(<HomeScreen me={owner} />);
    await loaded();
    const shown = rows().length;
    // GET /api/nav/counts runs taskRows with no similarity count and one dead row (limit=1). Neither changes the count.
    const domains = new Map(BRANDS.map((b) => [b.brand_id, b.hostnames[0]!] as const));
    const server = taskRows({
      owner: true,
      alerts: { report: ALERTS, states: new Map(), brandOfHostname: hostnameBrand(domains) },
      brands: BRANDS.filter((b) => b.brand_id !== "demo01"),
      checklists: CHECKLISTS.brands,
      templates: TEMPLATES.map(({ similarity_fail_count: _, ...t }) => t) as never,
      dead: { totals: DEAD.totals, rows: DEAD.rows.slice(0, 1) },
      clicks: clickTotals(spendReport(170), funnelReport(141), () => true),
      domains,
    });
    expect(server).toHaveLength(shown);
    expect(shown).toBe(9);
  });

  it("raises an owner-only ด่วน row when Google bills clicks that never reach the site", async () => {
    replies["/api/funnel"] = () => json(funnelReport(4));
    render(<HomeScreen me={owner} />);
    await loaded();
    const row = rowOf("Google Ads");
    expect(row.dataset.level).toBe("urgent");
    expect(row.querySelector(".task-title")!.textContent).toBe("Google คิดเงิน 170 คลิก มาถึงเว็บ 4 คน");
    expect(row.querySelector(".task-cause")!.textContent).toBe("คลิกที่จ่ายเงินหายก่อนถึงเว็บ ตรวจลิงก์ปลายทางและ gclid");
    expect(button(row)).toMatchObject({ textContent: "ตรวจทราฟฟิก" });
    expect(button(row).getAttribute("href")).toBe("/traffic");
    // Today's spend and today's UTC funnel window, the same reads GET /api/nav/counts makes.
    const range = clickRange(new Date());
    expect(requests).toContain("/api/spend?period=today");
    expect(requests.some((r) => r.startsWith("/api/funnel?") && r.includes(`from=${encodeURIComponent(range.from)}`) && r.includes(`to=${encodeURIComponent(range.to)}`))).toBe(true);
    // The server-shaped inputs give the same row count.
    const domains = new Map(BRANDS.map((b) => [b.brand_id, b.hostnames[0]!] as const));
    const server = taskRows({
      owner: true,
      alerts: { report: ALERTS, states: new Map(), brandOfHostname: hostnameBrand(domains) },
      brands: BRANDS.filter((b) => b.brand_id !== "demo01"),
      checklists: CHECKLISTS.brands,
      templates: TEMPLATES.map(({ similarity_fail_count: _, ...t }) => t) as never,
      dead: { totals: DEAD.totals, rows: DEAD.rows.slice(0, 1) },
      clicks: clickTotals(spendReport(170), funnelReport(4), () => true),
      domains,
    });
    expect(server).toHaveLength(rows().length);
    expect(rows()).toHaveLength(10);
  });

  it("names the classes read without counts and titles the total when the dead rows pass the read limit", async () => {
    replies["/api/conversions"] = () => json({ ...DEAD, totals: { ...DEAD.totals, dead: 900 }, truncated: true });
    render(<HomeScreen me={owner} />);
    await loaded();
    const row = rowOf("ส่งยอดขายให้ Google Ads");
    expect(row.querySelector(".task-title")!.textContent).toBe("ส่งยอดขายไม่สำเร็จ 900 รายการ");
    // 896 rows were not read, so no class gets a count and no อื่นๆ count is made up.
    expect(row.querySelector(".task-cause")!.textContent).toBe("ส่งซ้ำ · AdKit ขัดข้อง · ไม่มีรหัสคลิก");
    expect(button(row)).toMatchObject({ textContent: "ดูทั้ง 900 รายการ" });
  });

  it("reports the row count once every source answered, and shows the menu footer only then", async () => {
    let answer!: (response: Response) => void;
    replies["/api/conversions"] = () => new Promise<Response>((resolve) => { answer = resolve; });
    const counted = vi.fn();
    render(<HomeScreen me={owner} onCounted={counted} />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.queryByText(/บนเมนู/)).toBeNull();
    expect(counted).not.toHaveBeenCalled();
    answer(json(DEAD));
    await loaded();
    expect(screen.getByText(/^เลข 9 บนเมนู/)).toBeTruthy();
    await waitFor(() => expect(counted).toHaveBeenLastCalledWith(9));
  });

  it("reports no count and shows no footer when a source failed", async () => {
    replies["/api/funnel"] = () => json({ error: "core_unavailable" }, 502);
    const counted = vi.fn();
    render(<HomeScreen me={owner} onCounted={counted} />);
    expect(await screen.findByText("— โหลดยอดคลิกโฆษณาวันนี้ไม่สำเร็จ")).toBeTruthy();
    await loaded();
    expect(screen.queryByText(/บนเมนู/)).toBeNull();
    expect(counted).not.toHaveBeenCalled();
  });

  it("waits for the brand status read: no count and no footer while it is pending, both once it answers", async () => {
    let answer!: (response: Response) => void;
    replies["/api/brands"] = () => new Promise<Response>((resolve) => { answer = resolve; });
    const counted = vi.fn();
    render(<HomeScreen me={owner} onCounted={counted} />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    // Every other source answered, so only the status read holds the footer back.
    await waitFor(() => expect(requests).toContain("/api/brands"));
    expect(screen.getByText("…")).toBeTruthy();
    expect(screen.queryByText(/บนเมนู/)).toBeNull();
    expect(counted).not.toHaveBeenCalled();
    answer(json({ brands: [{ brand_id: "cg", status: "live", hostnames: ["creditgenie.test"] }], generated_at: "2026-10-22T10:00:00.000Z" }));
    await loaded();
    expect(screen.getByText(/^เลข 9 บนเมนู/)).toBeTruthy();
    await waitFor(() => expect(counted).toHaveBeenLastCalledWith(9));
  });

  it("names a failed brand status read on its own line, with no count and no footer", async () => {
    replies["/api/brands"] = () => json({ error: "core_unavailable" }, 502);
    const counted = vi.fn();
    render(<HomeScreen me={owner} onCounted={counted} />);
    expect(await screen.findByText("— โหลดสถานะแบรนด์ไม่สำเร็จ")).toBeTruthy();
    await loaded();
    expect(screen.queryByText(/บนเมนู/)).toBeNull();
    expect(screen.queryByText("ไม่มีงานค้าง ระบบทำที่เหลือให้เองแล้ว")).toBeNull();
    expect(counted).not.toHaveBeenCalled();
  });

  it("drops the rows of a paused brand once the status read answers, and counts the rows shown", async () => {
    // A screen outside the app shell keeps paused brands, so the default scope of the panel comes from the link.
    window.history.replaceState(null, "", "/?scope=active");
    replies["/api/brands"] = () => json({
      brands: [{ brand_id: "cg", status: "live", hostnames: ["creditgenie.test"] }, { brand_id: "e7", status: "paused", hostnames: ["sevenco.test"] }],
      generated_at: "2026-10-22T10:00:00.000Z",
    });
    const counted = vi.fn();
    render(<HomeScreen me={owner} onCounted={counted} />);
    await loaded();
    // e7 lost its sale route row, and the test sale row now names d6 only.
    expect(rowOf("sevenco.test")).toBeUndefined();
    expect(rowOf("2 แบรนด์")).toBeUndefined();
    expect(rows()).toHaveLength(8);
    expect(screen.getByText(/^เลข 8 บนเมนู/)).toBeTruthy();
    await waitFor(() => expect(counted).toHaveBeenLastCalledWith(rows().length));
    expect(counted).not.toHaveBeenCalledWith(9);
  });

  it("gives an employee no sale route, template or click loss rows, and never asks for templates, spend or funnel", async () => {
    replies["/api/funnel"] = () => json(funnelReport(0));
    render(<HomeScreen me={employee} />);
    await loaded();
    expect(rows().map((row) => row.querySelector(".task-title")!.textContent)).toEqual([
      "ยังไม่ได้ผลจากผู้ซื้อ", "ลีดโดนปฏิเสธ 38%", "คอนเวอร์ชันค้าง", "ยังไม่ได้ทดสอบการขาย", "สร้างแบรนด์ยังไม่เสร็จ", "ส่งยอดขายไม่สำเร็จ 4 รายการ",
    ]);
    // No template, spend or funnel read: those rows are the owner's.
    expect(requests.some((r) => r.startsWith("/api/templates") || r.startsWith("/api/spend") || r.startsWith("/api/funnel"))).toBe(false);
  });

  it("shows the empty state only when every source answered and nothing is open", async () => {
    replies["/api/alerts"] = () => json(HEALTHY);
    replies["/api/lifecycle/brands"] = () => json({ brands: [BRANDS[0]] });
    replies["/api/templates"] = () => json({ templates: [], categories: [] });
    replies["/api/conversions"] = () => json({ ...DEAD, totals: { ...DEAD.totals, dead: 0 }, rows: [] });
    render(<HomeScreen me={owner} />);
    expect(await screen.findByText("ไม่มีงานค้าง ระบบทำที่เหลือให้เองแล้ว")).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });

  it("names a failed source on its own line and never claims there is nothing to do", async () => {
    replies["/api/alerts"] = () => json(HEALTHY);
    replies["/api/lifecycle/brands"] = () => json({ brands: [BRANDS[0]] });
    replies["/api/templates"] = () => json({ templates: [], categories: [] });
    replies["/api/conversions"] = () => json({ error: "core_unavailable" }, 502);
    render(<HomeScreen me={owner} />);
    expect(await screen.findByText("— โหลดรายการส่งยอดขายไม่สำเร็จ")).toBeTruthy();
    await loaded();
    expect(screen.queryByText("ไม่มีงานค้าง ระบบทำที่เหลือให้เองแล้ว")).toBeNull();
  });
});
