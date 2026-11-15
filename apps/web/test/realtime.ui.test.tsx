import type { TrafficRealtimeResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeTab } from "../src/client/traffic/RealtimeTab";
import { EVENT_FILTERS, STAGE, csvText, deltaText, groupSessions, matchesFilter } from "../src/client/traffic/live";
import { MockEventSource, realtimeReport, tailEvent } from "./traffic-helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let report: TrafficRealtimeResponse;
let reportStatus: number;
let requests: string[];
let audio: { constructed: number; resumed: number; started: number };
/** What the server holds for GET/PUT /api/me/prefs, and every body a PUT sent. */
let prefs: { brand_scope: { hide_inactive: boolean; show_demo: boolean; brand_ids: string[] | null }; saved_views: Record<string, unknown> };
let prefsWrites: Array<typeof prefs>;

beforeEach(() => {
  report = realtimeReport();
  reportStatus = 200;
  requests = [];
  audio = { constructed: 0, resumed: 0, started: 0 };
  prefs = { brand_scope: { hide_inactive: false, show_demo: true, brand_ids: ["brand-a"] }, saved_views: { traffic: { period: "7d" } } };
  prefsWrites = [];
  MockEventSource.reset();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("AudioContext", class {
    currentTime = 0;
    destination = {};
    constructor() { audio.constructed += 1; }
    resume() { audio.resumed += 1; return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() { audio.started += 1; }, stop() {} }; }
  });
  window.localStorage.clear();
  window.history.replaceState(null, "", "/realtime");
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push(input);
    const url = new URL(input, window.location.origin);
    if (url.pathname === "/api/me/prefs") {
      if (init?.method === "PUT") { prefs = JSON.parse(String(init.body)); prefsWrites.push(prefs); }
      return json(prefs);
    }
    if (url.pathname === "/api/traffic/realtime") return reportStatus === 200 ? json({ ...report, period: url.searchParams.get("period") ?? "24h" }) : json({ error: "upstream" }, reportStatus);
    if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }, { brand_id: "brand-b", hostnames: ["b.example"] }] });
    if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-11-10T00:00:00.000Z" });
    throw new Error(`Unexpected test HTTP request: ${input}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const reportCalls = () => requests.filter((r) => r.startsWith("/api/traffic/realtime"));
const open = async () => {
  render(<RealtimeTab />);
  await screen.findByRole("region", { name: "ตัวเลขสำคัญ" });
  act(() => MockEventSource.last().open());
};
const emit = (over: Parameters<typeof tailEvent>[0] = {}) => act(() => MockEventSource.last().emit("event", tailEvent(over)));
const sessionRows = () => [...document.querySelectorAll<HTMLElement>(".rt-session")];
const chain = (row: HTMLElement) => [...row.querySelectorAll("[data-event]")].map((li) => li.getAttribute("data-event"));
const kpi = (id: string) => document.querySelector(`[data-kpi="${id}"]`)!;

describe("Realtime tab report", () => {
  it("renders the six KPIs, the three extra ones and their deltas from the report", async () => {
    await open();
    expect(kpi("landing_views").querySelector(".v")!.textContent).toBe("1,234");
    expect(kpi("landing_views").textContent).toContain("+12%");
    // The delta figure sits in a .num span (the number font); the words next to it do not.
    const delta = kpi("landing_views").querySelector(".rt-delta")!;
    expect(delta.querySelector("span.num")!.textContent).toBe("+12%");
    expect(delta.querySelector(".hint")!.className).not.toContain("num");
    expect(kpi("redirect_errors").querySelector(".rt-delta span.num")!.textContent).toBe("—");
    expect(kpi("form_starts").querySelector(".v")!.textContent).toBe("456");
    expect(kpi("form_starts").textContent).toContain("-8%");
    expect(kpi("leads").querySelector(".v")!.textContent).toBe("78");
    expect(kpi("validation_errors").querySelector(".v")!.textContent).toBe("9");
    expect(kpi("redirect_errors").querySelector(".v")!.textContent).toBe("2");
    expect(kpi("suspicious_sessions").querySelector(".v")!.textContent).toBe("5");
    expect(kpi("no_gclid_landings").querySelector(".v")!.textContent).toBe("40 · 3.2%");
    expect(kpi("gate_drops").querySelector(".v")!.textContent).toBe("11");
    expect(kpi("non_us_pct").querySelector(".v")!.textContent).toBe("6.5%");
    // A rise in errors is shown as bad, a rise in landings is not; no earlier value reads as a dash.
    expect(kpi("validation_errors").querySelector(".rt-delta")!.className).toContain("rt-bad");
    expect(kpi("landing_views").querySelector(".rt-delta")!.className).not.toContain("rt-bad");
    expect(kpi("redirect_errors").textContent).toContain("—");
  });

  it("rounds fractional percentages in KPI and breakdowns without losing the full row label", async () => {
    const base = realtimeReport();
    const longKey = "extremely-long-campaign-source-that-should-not-break-character-by-character.example";
    report = {
      ...base,
      kpis: {
        ...base.kpis,
        no_gclid_landings: { ...base.kpis.no_gclid_landings, pct: 8.51063829787234 },
        non_us_pct: 2.37467018469657,
      },
      breakdowns: {
        ...base.breakdowns,
        source: [{ key: longKey, count: 8, pct: 8.51063829787234 }],
      },
    };
    await open();
    expect(kpi("no_gclid_landings").querySelector(".v")!.textContent).toBe("40 · 8.5%");
    expect(kpi("non_us_pct").querySelector(".v")!.textContent).toBe("2.4%");
    const row = document.querySelector('[data-breakdown="source"] .rt-rows li')!;
    expect(row.querySelector(".rt-row-key")!.getAttribute("title")).toBe(longKey);
    expect(row.querySelector(".rt-row-percent")!.textContent).toBe("8 · 8.5%");
    expect(row.querySelector(".rt-row-bar span")!.getAttribute("style")).toContain("8.510638");
  });

  it("shows a dash for a null suspicious count and a null non-US share, never a zero", async () => {
    report = realtimeReport({ kpis: { ...realtimeReport().kpis, suspicious_sessions: null, non_us_pct: null } });
    await open();
    expect(kpi("suspicious_sessions").querySelector(".v")!.textContent).toBe("—");
    expect(kpi("non_us_pct").querySelector(".v")!.textContent).toBe("—");
  });

  it("shows the bots of this hour and of 24 hours, the trend, five breakdowns and the recent rows", async () => {
    report = realtimeReport({ adsbot_last: [{ brand: "brand-a", url: "https://a.example/", http_status: 200, response_ms: 85.4, gate_passed: true, at: "2026-11-10T09:30:00.000Z" }] });
    await open();
    const now = screen.getByRole("region", { name: "บอท Google ตอนนี้" });
    expect(within(now).getByText("Googlebot ชั่วโมงนี้").parentElement!.querySelector(".v")!.textContent).toBe("14");
    const day = screen.getByRole("region", { name: "บอทของ Google 24 ชม." });
    expect(within(day).getByText("a.example", { selector: "td" })).toBeTruthy();
    expect(within(day).getByText("85 ms")).toBeTruthy();
    expect(screen.getByRole("img", { name: "แนวโน้มทราฟฟิก" }).querySelectorAll(".rt-trend-col")).toHaveLength(2);
    expect([...document.querySelectorAll("[data-breakdown]")].map((el) => el.getAttribute("data-breakdown"))).toEqual(["source", "hostname", "device", "browser", "brand"]);
    expect(within(document.querySelector('[data-breakdown="brand"]') as HTMLElement).getByText("a.example")).toBeTruthy();
    const recent = screen.getByRole("region", { name: "ทราฟฟิกล่าสุด" });
    expect(within(recent).getAllByRole("columnheader")).toHaveLength(12);
    expect(within(recent).getByText("lead_submitted")).toBeTruthy();
  });

  it("reloads the report when the period changes and writes it into the URL", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "7 วัน" }));
    await waitFor(() => expect(reportCalls()).toContain("/api/traffic/realtime?period=7d"));
    expect(window.location.search).toBe("?period=7d");
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reloads the report 500 ms after the stream connects and keeps the numbers on screen meanwhile", async () => {
    await open();
    const before = reportCalls().length;
    await waitFor(() => expect(reportCalls().length).toBe(before + 1));
    expect(kpi("landing_views").querySelector(".v")!.textContent).toBe("1,234");
  });

  it("shows the error with a retry button when the first load fails", async () => {
    reportStatus = 500;
    render(<RealtimeTab />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    reportStatus = 200;
    fireEvent.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    expect(await screen.findByRole("region", { name: "ตัวเลขสำคัญ" })).toBeTruthy();
  });

  it("exports the recent rows as CSV from the button", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return "blob:test"; }, revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await open();
    fireEvent.click(screen.getByRole("button", { name: "ดาวน์โหลด CSV" }));
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("text/csv;charset=utf-8");
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("Realtime tab live stream", () => {
  it("opens the stream for every brand and shows the connection strip", async () => {
    await open();
    expect(MockEventSource.last().url).toBe("/api/traffic/tail");
    const strip = screen.getByRole("group", { name: "สถานะการเชื่อมต่อ" });
    expect(within(strip).getByRole("status").textContent).toContain("เชื่อมต่อแล้ว");
    expect(strip.textContent).toContain("เหตุการณ์ล่าสุด —");
    emit();
    expect(strip.textContent).toMatch(/เหตุการณ์ล่าสุด \d\d:\d\d:\d\d UTC/);
    expect(strip.textContent).toContain("1 เหตุการณ์ต่อนาที");
  });

  it("groups events by session_ref, oldest step first inside a session and newest session first", async () => {
    await open();
    emit({ event_id: "a1", session_ref: "1111111111111111", event_type: "landing_viewed", ts: 1_800_000_000_000 });
    emit({ event_id: "b1", session_ref: "2222222222222222", event_type: "gate_viewed", domain: "b.example", brand: "brand-b", ts: 1_800_000_001_000 });
    emit({ event_id: "a2", session_ref: "1111111111111111", event_type: "form_started", ts: 1_800_000_002_000 });
    emit({ event_id: "a3", session_ref: "1111111111111111", event_type: "lead_submitted", ts: 1_800_000_003_000 });
    const rows = sessionRows();
    expect(rows).toHaveLength(2);
    // Session 1 had the newest event, so it comes first.
    expect(rows[0]!.getAttribute("data-session")).toBe("1111111111111111");
    expect(chain(rows[0]!)).toEqual(["landing_viewed", "form_started", "lead_submitted"]);
    expect(rows[1]!.getAttribute("data-session")).toBe("2222222222222222");
    expect(chain(rows[1]!)).toEqual(["gate_viewed"]);
    expect(within(rows[0]!).getByText("หน้าแรก")).toBeTruthy();
    expect(within(rows[0]!).getByText("ส่งลีดแล้ว")).toBeTruthy();
  });

  it("drops an event that arrives twice", async () => {
    await open();
    const event = tailEvent({ event_id: "dup", session_ref: "3333333333333333" });
    act(() => { MockEventSource.last().emit("event", event); MockEventSource.last().emit("event", event); });
    expect(chain(sessionRows()[0]!)).toEqual(["landing_viewed"]);
  });

  it("shows only the 40 newest sessions", async () => {
    await open();
    act(() => {
      for (let i = 0; i < 45; i++) MockEventSource.last().emit("event", tailEvent({ event_id: `s${i}`, session_ref: i.toString(16).padStart(16, "0") }));
    });
    expect(sessionRows()).toHaveLength(40);
  });

  it("marks an error step and a failing page, and filters to errors only", async () => {
    await open();
    emit({ event_id: "ok1", session_ref: "4444444444444444", event_type: "landing_viewed" });
    emit({ event_id: "bad1", session_ref: "5555555555555555", event_type: "redirect_failed", http_status: 502 });
    expect(sessionRows()).toHaveLength(2);
    const failing = sessionRows().find((row) => row.getAttribute("data-session") === "5555555555555555")!;
    expect(within(failing).getByText("ส่งต่อไม่สำเร็จ")).toBeTruthy();
    expect(within(failing).getByText("HTTP 502")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "เฉพาะที่ผิดพลาด" }));
    expect(sessionRows().map((row) => row.getAttribute("data-session"))).toEqual(["5555555555555555"]);
  });

  it("filters by brand and by event group", async () => {
    await open();
    emit({ event_id: "f1", session_ref: "6666666666666666", brand: "brand-a", event_type: "landing_viewed" });
    emit({ event_id: "f2", session_ref: "7777777777777777", brand: "brand-b", domain: "b.example", event_type: "form_started" });
    fireEvent.change(screen.getByRole("combobox", { name: "กรองตามแบรนด์" }), { target: { value: "brand-b" } });
    expect(sessionRows().map((row) => row.getAttribute("data-session"))).toEqual(["7777777777777777"]);
    fireEvent.change(screen.getByRole("combobox", { name: "กรองตามแบรนด์" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "กรองตามเหตุการณ์" }), { target: { value: "form" } });
    expect(sessionRows().map((row) => row.getAttribute("data-session"))).toEqual(["7777777777777777"]);
  });

  it("freezes the feed while paused, counts what waits and shows it again on resume", async () => {
    await open();
    emit({ event_id: "p1", session_ref: "8888888888888888" });
    fireEvent.click(screen.getByRole("button", { name: "หยุดชั่วคราว" }));
    emit({ event_id: "p2", session_ref: "9999999999999999" });
    expect(sessionRows()).toHaveLength(1);
    expect(document.body.textContent).toContain("มีเหตุการณ์ใหม่ 1 รายการรออยู่");
    fireEvent.click(screen.getByRole("button", { name: "เล่นต่อ" }));
    expect(sessionRows()).toHaveLength(2);
  });

  it("asks the stream for the 24 hour report only once per burst, not once per event", async () => {
    await open();
    await waitFor(() => expect(reportCalls().length).toBe(2));
    for (let i = 0; i < 5; i++) emit({ event_id: `burst${i}` });
    await waitFor(() => expect(reportCalls().length).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(reportCalls().length).toBe(3);
  });

  it("schedules a new stream 3 seconds after an error and says the connection dropped", async () => {
    await open();
    vi.useFakeTimers();
    act(() => MockEventSource.last().error());
    expect(screen.getByRole("group", { name: "สถานะการเชื่อมต่อ" }).textContent).toContain("หลุดการเชื่อมต่อ กำลังต่อใหม่");
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(MockEventSource.instances).toHaveLength(2);
  });
});

describe("Realtime tab AdsBot banner and sound", () => {
  it("shows a warning banner for an AdsBot visit that got 200 and plays no sound while the switch is off", async () => {
    await open();
    expect(screen.queryByRole("alert")).toBeNull();
    emit({ event_id: "ab1", user_agent_family: "adsbot", session_ref: "abababababababab", http_status: 200, response_ms: 91 });
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-tone")).toBe("warning");
    expect(banner.textContent).toContain("AdsBot เข้าตรวจหน้า brand-a.example");
    expect(banner.textContent).toContain("หน้าตอบกลับปกติ");
    expect(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }).getAttribute("aria-pressed")).toBe("false");
    expect(audio.constructed).toBe(0);
    expect(audio.started).toBe(0);
  });

  it("turns the banner to danger when the page did not answer 200", async () => {
    await open();
    emit({ event_id: "ab2", user_agent_family: "adsbot", session_ref: "cdcdcdcdcdcdcdcd", http_status: 503 });
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-tone")).toBe("danger");
    expect(banner.textContent).toContain("HTTP 503");
  });

  it("opens the page in Google Ads and scrolls to the session from the banner buttons", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await open();
    emit({ event_id: "ab3", user_agent_family: "adsbot", session_ref: "efefefefefefefef", url: "https://brand-a.example/" });
    const link = screen.getByRole("link", { name: "ดูหน้าใน Google Ads" });
    expect(link.getAttribute("href")).toBe("https://brand-a.example/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "ดูเซสชัน" }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe("session-efefefefefefefef");
  });

  it("beeps once per AdsBot event when the switch is on and never for a browser event", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }));
    expect(audio.constructed).toBe(1);
    emit({ event_id: "h1" });
    expect(audio.started).toBe(0);
    emit({ event_id: "ab4", user_agent_family: "adsbot", session_ref: "0a0a0a0a0a0a0a0a" });
    expect(audio.started).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot เปิด/ }));
    emit({ event_id: "ab5", user_agent_family: "adsbot", session_ref: "0b0b0b0b0b0b0b0b" });
    expect(audio.started).toBe(1);
  });

  it("saves the switch in the user prefs, keeps the brand scope and the other saved views, and never touches localStorage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await open();
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }));
    await waitFor(() => expect(prefsWrites).toHaveLength(1));
    expect(prefsWrites[0]).toEqual({
      brand_scope: { hide_inactive: false, show_demo: true, brand_ids: ["brand-a"] },
      saved_views: { traffic: { period: "7d" }, realtime_sound: true },
    });
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot เปิด/ }));
    await waitFor(() => expect(prefsWrites).toHaveLength(2));
    expect(prefsWrites[1]!.saved_views).toEqual({ traffic: { period: "7d" }, realtime_sound: false });
    expect(prefsWrites[1]!.brand_scope).toEqual(prefs.brand_scope);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("loads the saved switch back after a fresh page, also on a device that never set it", async () => {
    prefs.saved_views = { traffic: { period: "7d" }, realtime_sound: true };
    await open();
    await waitFor(() => expect(screen.getByRole("button", { name: /เสียงเตือน AdsBot เปิด/ }).getAttribute("aria-pressed")).toBe("true"));
    emit({ event_id: "ab6", user_agent_family: "adsbot", session_ref: "0c0c0c0c0c0c0c0c" });
    expect(audio.started).toBe(1);
    expect(prefsWrites).toHaveLength(0);
  });

  it("keeps a scope saved by another writer while the switch saves", async () => {
    await open();
    // The scope changes on the server after this page loaded. The switch save reads the prefs fresh and keeps that scope.
    prefs = { ...prefs, brand_scope: { hide_inactive: true, show_demo: false, brand_ids: ["brand-b"] } };
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }));
    await waitFor(() => expect(prefsWrites).toHaveLength(1));
    expect(prefsWrites[0]!.brand_scope).toEqual({ hide_inactive: true, show_demo: false, brand_ids: ["brand-b"] });
  });

  it("starts silent and says so when the prefs cannot be read or saved", async () => {
    vi.mocked(fetch).mockImplementation((async (input: string) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/me/prefs") return json({ error: "down" }, 502);
      if (path === "/api/traffic/realtime") return json(report);
      if (path === "/api/lifecycle/brands") return json({ brands: [] });
      if (path === "/api/brands") return json({ brands: [], generated_at: "2026-11-10T00:00:00.000Z" });
      throw new Error("Unexpected test HTTP request: " + String(input));
    }) as typeof fetch);
    await open();
    expect(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /เสียงเตือน AdsBot ปิด/ }));
    // The switch works on this page and the failed save is reported.
    expect(screen.getByRole("button", { name: /เสียงเตือน AdsBot เปิด/ })).toBeTruthy();
    expect(await screen.findByText(/บันทึกการตั้งค่าเสียงเตือนไม่สำเร็จ/)).toBeTruthy();
  });

  it("shows the latest AdsBot visit of the report before any live event arrives", async () => {
    report = realtimeReport({ adsbot_last: [
      { brand: "brand-a", url: "https://a.example/", http_status: 200, response_ms: 70, gate_passed: true, at: "2026-11-10T08:00:00.000Z" },
      { brand: "brand-b", url: "https://b.example/", http_status: 404, response_ms: 90, gate_passed: false, at: "2026-11-10T09:00:00.000Z" },
    ] });
    await open();
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-tone")).toBe("danger");
    expect(banner.textContent).toContain("b.example");
    // A visit from the report has no session in the feed to scroll to.
    expect(screen.queryByRole("button", { name: "ดูเซสชัน" })).toBeNull();
  });
});

describe("traffic live helpers", () => {
  it("writes CSV with a byte order mark, quotes commas, quotes and line breaks, and leaves null empty", () => {
    expect(csvText(["a", "b"], [["x,y", 'say "hi"'], [null, 3], ["l1\nl2", "ก"]])).toBe('\uFEFFa,b\r\n"x,y","say ""hi"""\r\n,3\r\n"l1\nl2",ก\r\n');
  });
  it("reads a delta as a signed whole percent and a missing one as a dash", () => {
    expect([deltaText(12.4), deltaText(-7.6), deltaText(0), deltaText(null)]).toEqual(["+12%", "-8%", "0%", "—"]);
  });
  it("keeps a session chain and lastTs in event time when an older event arrives after a newer one", () => {
    const ref = "bbbbbbbbbbbbbbbb";
    const landing = tailEvent({ event_id: "o1", session_ref: ref, event_type: "landing_viewed", ts: 1_800_000_000_000 });
    const started = tailEvent({ event_id: "o2", session_ref: ref, event_type: "form_started", ts: 1_800_000_010_000 });
    const other = tailEvent({ event_id: "o3", session_ref: "cccccccccccccccc", ts: 1_800_000_005_000 });
    // The stream keeps arrival order, newest arrival first: form_started came first, landing_viewed arrived late, then another session.
    const sessions = groupSessions([other, landing, started]);
    const mine = sessions.find((s) => s.sessionRef === ref)!;
    expect(mine.events.map((e) => e.event_id)).toEqual(["o1", "o2"]);
    expect(mine.lastTs).toBe(1_800_000_010_000);
    // The session with the later event time is first, although its late event arrived after the other session's event.
    expect(sessions.map((s) => s.sessionRef)).toEqual([ref, "cccccccccccccccc"]);
  });
  it("labels a postback as its own stage and filters it on its own", () => {
    expect(STAGE.postback_received).toEqual({ label: "ผลจากผู้ซื้อ", kind: "postback" });
    expect(EVENT_FILTERS.map((f) => f.id)).toEqual(["all", "landing", "form", "lead", "redirect", "postback", "bot"]);
    const postback = tailEvent({ event_type: "postback_received", device_type: null, browser: null, user_agent_family: "unknown" });
    const others = (["gate_viewed", "landing_viewed", "form_started", "lead_submitted", "redirect_started"] as const).map((event_type) => tailEvent({ event_type }));
    expect([postback, ...others].filter((e) => matchesFilter(e, "postback"))).toEqual([postback]);
    expect(matchesFilter(postback, "lead")).toBe(false);
    expect(matchesFilter(postback, "all")).toBe(true);
  });
  it("puts a postback last in the visitor's session and keeps the visitor's device, browser and family", () => {
    const ref = "dddddddddddddddd";
    // Landing and lead differ in every visitor field, so the test shows which event the session reads them from.
    const landing = tailEvent({ event_id: "v1", session_ref: ref, event_type: "landing_viewed", ts: 1_800_000_000_000, device_type: "desktop", browser: "firefox", user_agent_family: "browser" });
    const lead = tailEvent({ event_id: "v2", session_ref: ref, event_type: "lead_submitted", ts: 1_800_000_060_000, device_type: "mobile", browser: "safari", user_agent_family: "googlebot" });
    const postback = tailEvent({ event_id: "pb-1", session_ref: ref, event_type: "postback_received", ts: 1_800_000_900_000, device_type: null, browser: null, user_agent_family: "unknown" });
    // Newest arrival first. [postback, lead, landing]: the postback arrived last. [lead, landing, postback]: it arrived first.
    for (const arrival of [[postback, lead, landing], [lead, landing, postback]]) {
      const [session, ...rest] = groupSessions(arrival);
      expect(rest).toEqual([]);
      expect(session!.events.map((e) => e.event_id)).toEqual(["v1", "v2", "pb-1"]);
      expect([session!.device, session!.browser, session!.family]).toEqual(["desktop", "firefox", "browser"]);
      expect(session!.lastTs).toBe(1_800_000_900_000);
    }
    // A postback alone keeps its own empty values until a visitor event of the session arrives.
    const [alone] = groupSessions([postback]);
    expect([alone!.device, alone!.browser, alone!.family]).toEqual([null, null, "unknown"]);
  });
  it("gives an event with no session ref a row of its own", () => {
    const sessions = groupSessions([tailEvent({ event_id: "n1", session_ref: null }), tailEvent({ event_id: "n2", session_ref: null })]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.sessionRef === null)).toBe(true);
  });
});
