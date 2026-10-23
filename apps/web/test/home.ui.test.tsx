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
const template = (id: string, status: string) => ({ template_version_id: id, template_id: id, name: id, version: 1, status, submitted_by_label: null, created_at: "2026-10-20", sealed_at: null, thumbnail_url: null, brands_using: 0 });

let funnel: (from: string) => Response;
let spend: ReturnType<typeof vi.fn>;
const realSpend = api.spend;
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
  requests = [];
  funnel = (from) => json(from.startsWith("2026-09-23") ? FUNNEL_30D : FUNNEL_7D);
  spend = vi.fn(async (period: string) => (period === "30d" ? spendReport(2400, 1200) : spendReport(1780, 402)));
  (api as unknown as { spend: unknown }).spend = spend;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "http://panel.test");
    if (url.pathname === "/api/funnel") return funnel(url.searchParams.get("from") ?? "");
    if (url.pathname === "/api/alerts") return json(alertsReport);
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
});

const ledgerValue = (label: string) => {
  const cell = within(screen.getByRole("group", { name: "สรุปตัวเลข" })).getByText(label).parentElement!;
  return { text: cell.querySelector(".v")!.textContent, className: cell.querySelector(".v")!.className };
};
const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

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
    const funnelQuery = (n: number) => new URL(requests.filter((r) => r.startsWith("/api/funnel"))[n]!, "http://panel.test").searchParams;
    expect(funnelQuery(0).get("from")).toBe("2026-10-16T00:00:00.000Z");
    expect(funnelQuery(0).get("to")).toBe("2026-10-23T00:00:00.000Z");
    expect(spend).toHaveBeenLastCalledWith("7d");

    fireEvent.click(screen.getByRole("button", { name: "30 วัน" }));
    await heading("จ่ายค่าโฆษณา $2,400 ได้ 60 ลีด ต้นทุนลีดละ $40");
    expect(screen.getByRole("button", { name: "30 วัน" }).getAttribute("aria-pressed")).toBe("true");
    expect(funnelQuery(1).get("from")).toBe("2026-09-23T00:00:00.000Z");
    expect(spend).toHaveBeenLastCalledWith("30d");

    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(spend).toHaveBeenLastCalledWith("today"));
    await waitFor(() => expect(requests.filter((r) => r.startsWith("/api/funnel"))).toHaveLength(3));
    expect(funnelQuery(2).get("from")).toBe("2026-10-22T00:00:00.000Z");
    expect(funnelQuery(2).get("to")).toBe("2026-10-23T00:00:00.000Z");
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
});

describe("Home screen, employee", () => {
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
