// spec traffic
import { createHash } from "node:crypto";
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
    VALUES (?1, ?2, 'clk-secret-1', ?3, 'forged-brand', ?4, ?5, ?6, ?7, ?8, ?10, ?9)`)
    .bind(e.type, e.session, e.host ?? "brand-a.example", e.source ?? null, e.device ?? "mobile", e.browser ?? "safari",
      e.step ?? null, e.code ?? null, e.at, skewed(e.at));
}
// occurred_at is client time and never drives the report; it sits a day before created_at so any read of it shows.
const skewed = (at: string) => new Date(Date.parse(at) - 86_400_000).toISOString();
const expectedRef = (host: string, id: string) =>
  createHash("sha256").update(`session:${host}:${id}`).digest("hex").slice(0, 12);
const reseed = async () => { await h.reset(); await h.seedBrand("brand-a"); };
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
    expect(day.trend[5]).toEqual({ at: "2026-11-01T00:00:00.000Z", ...metrics(3, 2, 1, 1, 1) });
    expect(day.trend[6]).toEqual({ at: "2026-11-02T00:00:00.000Z", ...metrics(1, 0, 0, 0, 0) });
    for (const { at, ...rest } of day.trend.slice(0, 5)) {
      expect(at).toMatch(/T00:00:00\.000Z$/);
      expect(rest).toEqual(metrics(0, 0, 0, 0, 0));
    }

    const hour = await load("24h");
    expect(hour.bucket).toBe("hour");
    expect(hour.from).toBe("2026-11-01T13:00:00.000Z");
    expect(hour.trend).toHaveLength(24);
    expect(hour.trend[20]).toEqual({ at: "2026-11-02T09:00:00.000Z", ...metrics(1, 0, 0, 0, 0) });
    for (const [index, { at, ...rest }] of hour.trend.entries()) {
      if (index === 20) continue;
      expect(at).toBe(new Date(Date.parse(hour.from) + index * 3_600_000).toISOString());
      expect(rest).toEqual(metrics(0, 0, 0, 0, 0));
    }
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
    await reseed();
    await seed(Array.from({ length: 101 }, (_, i) => ({
      session: `s${i}`, type: "landing_viewed", at: "2026-11-02T08:00:00.000Z", source: `src-${String(i).padStart(3, "0")}`,
    })));
    const report = await load("24h");
    const keys = report.breakdowns.source.map((row) => row.key);
    expect(keys).toHaveLength(100);
    expect(keys[0]).toBe("src-000");
    expect(keys[99]).toBe("src-099");
    expect(keys).not.toContain("src-100");
    expect(report.totals.landing_views).toBe(101);
  });

  it("recent holds at most 200 events, newest first, with a 12-hex session_ref", async () => {
    await reseed();
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
    expect(recent[0]!.session_ref).toBe(expectedRef("brand-a.example", "one"));
    expect(recent[0]).toMatchObject({ hostname: "brand-a.example", brand_id: "brand-a", form_step: 2, device: "mobile", browser: "safari", source: null });
    expect(Object.keys(recent[0]!)).not.toContain("session_id");
  });

  it("recent returns created_at, never the skewed occurred_at, and orders equal times by id descending", async () => {
    await reseed();
    const at = "2026-11-02T08:00:00.000Z";
    await seed([
      { session: "tie-a", type: "form_step_viewed", at, step: 1 },
      { session: "tie-b", type: "form_step_viewed", at, step: 2 },
      { session: "tie-c", type: "form_step_viewed", at: "2026-11-02T07:00:00.000Z", step: 3 },
    ]);
    const { recent } = await load("24h");
    expect(recent.map((row) => [row.at, row.form_step])).toEqual([[at, 2], [at, 1], ["2026-11-02T07:00:00.000Z", 3]]);
  });

  it("recent keeps the higher id when equal times straddle the 200 row cut", async () => {
    await reseed();
    const oldest = "2026-11-02T01:00:00.000Z";
    const base = Date.parse("2026-11-02T02:00:00.000Z");
    await seed([
      { session: "cut-low", type: "form_step_viewed", at: oldest, step: 1 },
      { session: "cut-high", type: "form_step_viewed", at: oldest, step: 2 },
      ...Array.from({ length: 199 }, (_, i) => ({
        session: `n${i}`, type: "form_step_viewed", step: 3, at: new Date(base + i * 60_000).toISOString(),
      })),
    ]);
    const { recent } = await load("24h");
    expect(recent).toHaveLength(200);
    expect(recent[199]).toMatchObject({ at: oldest, form_step: 2 });
    expect(recent.filter((row) => row.form_step === 1)).toHaveLength(0);
  });
});

describe("traffic report sessions", () => {
  it("takes entry attributes from the first event by created_at, not the landing view", async () => {
    await reseed();
    await seed([
      { session: "s1", type: "landing_viewed", at: "2026-11-02T08:05:00.000Z", source: "second", device: "mobile", browser: "safari" },
      { session: "s1", type: "form_started", at: "2026-11-02T08:00:00.000Z", source: "first", device: "desktop", browser: "chrome" },
    ]);
    const report = await load("24h");
    expect(report.breakdowns.source).toEqual([{ key: "first", ...metrics(1, 1, 0, 0, 0) }]);
    expect(report.breakdowns.device).toEqual([{ key: "desktop", ...metrics(1, 1, 0, 0, 0) }]);
    expect(report.breakdowns.browser).toEqual([{ key: "chrome", ...metrics(1, 1, 0, 0, 0) }]);
  });

  it("breaks a created_at tie by the lower id", async () => {
    await reseed();
    const at = "2026-11-02T08:00:00.000Z";
    await seed([
      { session: "s1", type: "landing_viewed", at, source: "low-id" },
      { session: "s1", type: "form_started", at, source: "high-id" },
    ]);
    const report = await load("24h");
    expect(report.breakdowns.source).toEqual([{ key: "low-id", ...metrics(1, 1, 0, 0, 0) }]);
  });

  it("counts an event exactly at from and skips one just before it", async () => {
    await reseed();
    const { from } = await load("7d");
    await seed([
      { session: "at-from", type: "landing_viewed", at: from, source: "at-from" },
      { session: "before", type: "landing_viewed", at: new Date(Date.parse(from) - 1).toISOString(), source: "before-from" },
    ]);
    const report = await load("7d");
    expect(report.breakdowns.source).toEqual([{ key: "at-from", ...metrics(1, 0, 0, 0, 0) }]);
    expect(report.trend[0]).toEqual({ at: from, ...metrics(1, 0, 0, 0, 0) });
    expect(report.recent.map((row) => row.at)).toEqual([from]);
  });

  it("puts a session that crosses midnight wholly in its entry day", async () => {
    await reseed();
    await seed([
      { session: "s1", type: "landing_viewed", at: "2026-11-01T23:50:00.000Z" },
      { session: "s1", type: "lead_submitted", at: "2026-11-02T00:10:00.000Z" },
    ]);
    const { trend } = await load("7d");
    expect(trend[5]).toEqual({ at: "2026-11-01T00:00:00.000Z", ...metrics(1, 0, 1, 0, 0) });
    expect(trend[6]).toEqual({ at: "2026-11-02T00:00:00.000Z", ...metrics(0, 0, 0, 0, 0) });
  });

  it("puts a session that crosses an hour wholly in its entry hour", async () => {
    await reseed();
    await seed([
      { session: "s1", type: "landing_viewed", at: "2026-11-02T08:50:00.000Z" },
      { session: "s1", type: "lead_submitted", at: "2026-11-02T09:10:00.000Z" },
    ]);
    const { trend } = await load("24h");
    expect(trend[19]).toEqual({ at: "2026-11-02T08:00:00.000Z", ...metrics(1, 0, 1, 0, 0) });
    expect(trend[20]).toEqual({ at: "2026-11-02T09:00:00.000Z", ...metrics(0, 0, 0, 0, 0) });
  });
});

describe("traffic report session_ref", () => {
  it("matches an independent SHA-256 and ignores hostname case and a www. prefix", async () => {
    await reseed();
    await seed([
      { session: "ref-1", type: "landing_viewed", at: "2026-11-02T08:00:00.000Z", host: "brand-a.example" },
      { session: "ref-1", type: "form_started", at: "2026-11-02T08:01:00.000Z", host: "WWW.Brand-A.example" },
    ]);
    const { recent } = await load("24h");
    const expected = createHash("sha256").update("session:brand-a.example:ref-1").digest("hex").slice(0, 12);
    expect(recent.map((row) => row.event_type)).toEqual(["form_started", "landing_viewed"]);
    expect(recent.map((row) => row.session_ref)).toEqual([expected, expected]);
    expect(await sessionRef("WWW.Brand-A.example", "ref-1")).toBe(expected);
    expect(recent[0]!.hostname).toBe("www.brand-a.example");
  });
});
