// spec traffic
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrafficReportResponse, type AdminRequestContext, type TrafficLogPeriod } from "@anjuna/contracts";
import { loadTrafficReport, sessionRef } from "../src/admin/traffic-log.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_01HZX9K2M4N6P8Q1" };
const now = new Date("2026-11-02T12:00:00.000Z");
const load = (period: TrafficLogPeriod = "7d") => loadTrafficReport({ LEADS: h.db as unknown as D1Database }, { period }, now);

interface Seed {
  session: string; type: string; at: string; source?: string | null; host?: string;
  device?: string; browser?: string; step?: number | null; code?: string | null;
}
function event(e: Seed) {
  return h.db.prepare(`INSERT INTO traffic_events
    (event_type, session_id, click_session_id, hostname, brand, source, device_class, browser_family, form_step, error_code, occurred_at, created_at)
    VALUES (?1, ?2, 'clk-secret-1', ?3, 'forged-brand', ?4, ?5, ?6, ?7, ?8, ?9, ?9)`)
    .bind(e.type, e.session, e.host ?? "brand-a.example", e.source ?? null, e.device ?? "mobile", e.browser ?? "safari",
      e.step ?? null, e.code ?? null, e.at);
}
const seed = (events: Seed[]) => h.db.batch(events.map(event));
const metrics = (landing_views: number, form_starts: number, leads: number, validation_errors: number, redirect_errors: number) =>
  ({ landing_views, form_starts, leads, validation_errors, redirect_errors });

beforeAll(async () => {
  h = await createHarness();
  await h.seedBrand("brand-a");
  await h.seedBrand("brand-b");
  await seed([
    { session: "one", type: "landing_viewed", at: "2026-11-01T05:15:00.000Z", source: "google" },
    { session: "one", type: "landing_viewed", at: "2026-11-01T05:16:00.000Z", source: "google" },
    { session: "one", type: "form_started", at: "2026-11-01T05:17:00.000Z" },
    { session: "one", type: "lead_submitted", at: "2026-11-01T05:20:00.000Z" },
    { session: "one", type: "lead_submitted", at: "2026-11-01T05:21:00.000Z" },
    { session: "err-v", type: "form_validation_failed", at: "2026-11-01T09:00:00.000Z", source: "bing", device: "desktop", browser: "chrome" },
    { session: "err-r", type: "redirect_failed", at: "2026-11-01T10:00:00.000Z", host: "brand-b.example", device: "desktop", browser: "chrome" },
    // Session ids are scoped to a hostname; the same id on another host is another session.
    { session: "one", type: "landing_viewed", at: "2026-11-01T06:20:00.000Z", source: "bing", host: "unmapped.example", device: "tablet", browser: "firefox" },
    // The entry event has no source; a later source must not be used.
    { session: "late", type: "landing_viewed", at: "2026-11-01T07:00:00.000Z" },
    { session: "late", type: "form_started", at: "2026-11-01T07:05:00.000Z", source: "later" },
    { session: "sess-raw-123456", type: "landing_viewed", at: "2026-11-02T09:30:00.000Z", source: "direct" },
    { session: "old", type: "landing_viewed", at: "2026-10-01T12:00:00.000Z", source: "outside-window" },
    { session: "future", type: "landing_viewed", at: "2026-11-02T12:00:00.000Z", source: "exclusive-end" },
  ]);
});
afterAll(async () => { await h?.mf.dispose(); });

describe("traffic report D1 reads", () => {
  it("counts each metric once per session", async () => {
    const report = await load();
    expect(report.totals).toEqual(metrics(4, 2, 1, 1, 1));
    const one = (await load()).breakdowns.hostname.find((row) => row.key === "brand-a.example")!;
    expect(one.leads).toBe(1);
  });

  it("counts an error-only session in its error metric", async () => {
    const report = await load();
    expect(report.totals.validation_errors).toBe(1);
    expect(report.totals.redirect_errors).toBe(1);
    expect(report.breakdowns.hostname.find((row) => row.key === "brand-b.example")).toEqual(
      { key: "brand-b.example", ...metrics(0, 0, 0, 0, 1) });
    expect(report.breakdowns.source.find((row) => row.key === "bing")).toEqual(
      { key: "bing", ...metrics(1, 0, 0, 1, 0) });
  });

  it("attributes a session to its entry source, device and browser", async () => {
    const report = await load();
    expect(report.breakdowns.source).toEqual([
      { key: "bing", ...metrics(1, 0, 0, 1, 0) },
      { key: "direct", ...metrics(1, 0, 0, 0, 0) },
      { key: "google", ...metrics(1, 1, 1, 0, 0) },
      { key: "unknown", ...metrics(1, 1, 0, 0, 1) },
    ]);
    expect(report.breakdowns.device).toEqual([
      { key: "mobile", ...metrics(3, 2, 1, 0, 0) },
      { key: "tablet", ...metrics(1, 0, 0, 0, 0) },
      { key: "desktop", ...metrics(0, 0, 0, 1, 1) },
    ]);
    expect(report.breakdowns.browser.map((row) => row.key)).toEqual(["safari", "firefox", "chrome"]);
  });

  it("maps hostnames to brand ids and falls back to the host", async () => {
    const report = await load();
    expect(report.breakdowns.brand.map((row) => row.key)).toEqual(["brand-a", "unmapped.example", "brand-b"]);
    expect(report.breakdowns.brand[0]).toEqual({ key: "brand-a", ...metrics(3, 2, 1, 1, 0) });
    expect(report.breakdowns.hostname.map((row) => row.key)).toEqual(["brand-a.example", "unmapped.example", "brand-b.example"]);
  });

  it("excludes events outside the window", async () => {
    const report = await load("7d");
    const sources = report.breakdowns.source.map((row) => row.key);
    expect(sources).not.toContain("outside-window");
    expect(sources).not.toContain("exclusive-end");
    expect(report.recent.every((row) => row.at >= report.from && row.at < report.to)).toBe(true);
  });

  it("24h trend has 24 hourly buckets and 7d has 7 daily buckets, zero filled", async () => {
    const day = await load("7d");
    expect(day.bucket).toBe("day");
    expect(day.trend).toHaveLength(7);
    expect(day.trend[5]).toEqual({ at: "2026-11-01T00:00:00.000Z", ...day.totals, landing_views: 3, leads: 1 });
    expect(day.trend[6]).toEqual({ at: "2026-11-02T00:00:00.000Z", ...metrics(1, 0, 0, 0, 0) });
    expect(day.trend.filter((_, index) => index < 5).every((b) => b.landing_views + b.form_starts + b.leads + b.validation_errors + b.redirect_errors === 0)).toBe(true);

    const hour = await load("24h");
    expect(hour.bucket).toBe("hour");
    expect(hour.from).toBe("2026-11-01T13:00:00.000Z");
    expect(hour.trend).toHaveLength(24);
    expect(hour.trend[20]).toEqual({ at: "2026-11-02T09:00:00.000Z", ...metrics(1, 0, 0, 0, 0) });
    expect(hour.trend.filter((_, index) => index !== 20).every((b) => b.landing_views === 0 && b.leads === 0)).toBe(true);
    expect(hour.totals).toEqual(metrics(1, 0, 0, 0, 0));
  });

  it("never returns a raw session id, click session id or brand display name", async () => {
    for (const period of ["24h", "7d", "30d"] as const) {
      const text = JSON.stringify(await load(period));
      for (const secret of ["sess-raw-123456", "clk-secret-1", "forged-brand"]) expect(text).not.toContain(secret);
    }
  });

  it("the admin route answers an employee and rejects a bad period", async () => {
    const response = await h.admin("/admin/traffic/report?period=7d", employee);
    expect(response.status).toBe(200);
    expect(TrafficReportResponse.parse(await response.json()).period).toBe("7d");
    expect((await h.admin("/admin/traffic/report?period=today", employee)).status).toBe(422);
    expect((await h.admin("/admin/traffic/report?period=7d&sql=1", employee)).status).toBe(422);
  });
});

describe("traffic report limits", () => {
  it("breakdowns stop at 100 rows", async () => {
    await h.reset();
    await h.seedBrand("brand-a");
    await seed(Array.from({ length: 101 }, (_, i) => ({
      session: `s${i}`, type: "landing_viewed", at: "2026-11-02T08:00:00.000Z", source: `src-${String(i).padStart(3, "0")}`,
    })));
    const report = await load("24h");
    expect(report.breakdowns.source).toHaveLength(100);
    expect(report.totals.landing_views).toBe(101);
  });

  it("recent holds at most 200 events, newest first, with a 12-hex session_ref", async () => {
    await h.reset();
    await h.seedBrand("brand-a");
    const base = Date.parse("2026-11-02T00:00:00.000Z");
    await seed(Array.from({ length: 205 }, (_, i) => ({
      session: i === 204 ? "one" : `s${i}`, type: "form_step_viewed", step: 2,
      at: new Date(base + i * 60_000).toISOString(),
    })));
    const { recent } = await load("24h");
    expect(recent).toHaveLength(200);
    const times = recent.map((row) => row.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(recent[0]!.at).toBe(new Date(base + 204 * 60_000).toISOString());
    expect(recent.every((row) => /^[0-9a-f]{12}$/.test(row.session_ref))).toBe(true);
    expect(recent[0]!.session_ref).toBe(await sessionRef("brand-a.example", "one"));
    expect(recent[0]).toMatchObject({ hostname: "brand-a.example", brand_id: "brand-a", form_step: 2, device: "mobile", browser: "safari", source: null });
    expect(Object.keys(recent[0]!)).not.toContain("session_id");
  });
});
