import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrafficBreakdownResponse, trafficWindow, type AdminRequestContext } from "@anjuna/contracts";
import { loadTrafficBreakdown } from "../src/admin/traffic.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_01HZX9K2M4N6P8Q1" };
const now = new Date("2026-11-02T12:00:00.000Z");
const load = (by: "source" | "domain" | "device" | "browser" | "hour", period: "today" | "7d" | "30d" = "7d") =>
  loadTrafficBreakdown({ LEADS: h.db as unknown as D1Database }, { by, period }, now);

beforeAll(async () => {
  h = await createHarness();
  await h.seedBrand("brand-a");
  await h.seedBrand("brand-b");
  async function event(session: string, type: string, stamp: string, source: string | null, host = "brand-a.example") {
    await h.db.prepare(`INSERT INTO traffic_events
      (event_type, session_id, hostname, brand, source, device_class, browser_family, occurred_at, created_at)
      VALUES (?1, ?2, ?3, 'forged-brand', ?4, 'mobile', 'safari', ?5, ?5)`)
      .bind(type, session, host, source, stamp).run();
  }
  await event("one", "landing_viewed", "2026-11-01T05:15:00.000Z", "google");
  await event("one", "landing_viewed", "2026-11-01T05:16:00.000Z", "google");
  await event("one", "form_started", "2026-11-01T05:17:00.000Z", null);
  await event("one", "lead_submitted", "2026-11-01T05:20:00.000Z", null);
  await event("one", "lead_submitted", "2026-11-01T05:21:00.000Z", null);
  await event("two", "gate_viewed", "2026-11-01T06:15:00.000Z", null);
  // Session ids are scoped to a hostname; the same id on another brand is another visit.
  await event("one", "landing_viewed", "2026-11-01T06:20:00.000Z", "bing", "brand-b.example");
  await event("old", "landing_viewed", "2026-10-01T12:00:00.000Z", "outside-window");
  await event("future", "landing_viewed", "2026-11-02T12:00:00.000Z", "exclusive-end");
  await event("error-only", "form_validation_failed", "2026-11-01T09:00:00.000Z", "not-a-visit");
});
afterAll(async () => { await h?.mf.dispose(); });

describe("traffic breakdown D1 reads", () => {
  it("deduplicates visits/leads and attributes submissions to their entry source", async () => {
    const data = await load("source");
    expect(data.rows).toEqual([
      { key: "bing", visits: 1, leads: 0 },
      { key: "google", visits: 1, leads: 1 },
      { key: "unknown", visits: 1, leads: 0 },
    ]);
    expect(data.brands).toEqual([
      { brand_id: "brand-a", hostname: "brand-a.example", visits: 2, go_count: null, form_views: 1, leads: 1 },
      { brand_id: "brand-b", hostname: "brand-b.example", visits: 1, go_count: null, form_views: 1, leads: 0 },
    ]);
    expect(JSON.stringify(data)).not.toContain("forged-brand");
  });
  it.each(["domain", "device", "browser"] as const)("groups %s with the same visit and lead totals", async (by) => {
    const data = await load(by);
    expect(data.rows.reduce((sum, r) => sum + r.visits, 0)).toBe(3);
    expect(data.rows.reduce((sum, r) => sum + r.leads, 0)).toBe(1);
    expect(data.rows.map((r) => r.key)).toEqual(by === "domain" ? ["brand-a.example", "brand-b.example"] : by === "device" ? ["mobile"] : ["safari"]);
  });
  it("fills 24 Eastern hours and folds both occurrences of 01:00 across DST", async () => {
    const data = await load("hour");
    expect(data.rows).toHaveLength(24);
    expect(data.rows[1]).toEqual({ key: "01", visits: 3, leads: 1 });
    expect(data.rows[0]).toEqual({ key: "00", visits: 0, leads: 0 });
  });
  it("returns an empty period without NaN or fabricated counts", async () => {
    expect((await load("source", "today")).rows).toEqual([]);
    expect((await load("hour", "today")).rows.every((r) => r.visits === 0 && r.leads === 0)).toBe(true);
  });
  it("uses inclusive UTC calendar days and an exclusive upper bound", () => {
    expect(trafficWindow("7d", now)).toEqual({ from: "2026-10-27T00:00:00.000Z", to: now.toISOString() });
    expect(trafficWindow("30d", now).from).toBe("2026-10-04T00:00:00.000Z");
  });
  it("routes and validates the admin read for an employee", async () => {
    const response = await h.admin("/admin/traffic/breakdown?period=7d&by=hour", employee);
    expect(response.status).toBe(200);
    expect(TrafficBreakdownResponse.parse(await response.json()).rows).toHaveLength(24);
    for (const query of ["period=year&by=source", "period=today&by=host);DROP TABLE leads", "period=today&by=source&sql=1"]) {
      expect((await h.admin(`/admin/traffic/breakdown?${query}`, employee)).status).toBe(422);
    }
  });
});
