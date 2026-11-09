import { afterAll, beforeAll, expect, it } from "vitest";
import { TrafficRealtimeResponse } from "@anjuna/contracts";
import { loadTrafficRealtime } from "../src/admin/traffic-realtime.js";
import { createHarness, hash, type Harness } from "./helpers.js";

let h: Harness;
const now = new Date("2026-11-10T12:30:00.000Z");
const currentTypes = ["gate_viewed", "gate_viewed", ...Array<string>(8).fill("landing_viewed"), ...Array<string>(4).fill("form_started"),
  ...Array<string>(3).fill("lead_submitted"), ...Array<string>(2).fill("form_validation_failed"), "redirect_failed"];
const previousTypes = ["gate_viewed", "gate_viewed", ...Array<string>(4).fill("landing_viewed"), ...Array<string>(4).fill("form_started"),
  ...Array<string>(4).fill("lead_submitted"), ...Array<string>(4).fill("form_validation_failed"), ...Array<string>(2).fill("redirect_failed")];
const at = (day: number, i: number) => `2026-11-${String(day).padStart(2, "0")}T12:00:${String(i).padStart(2, "0")}.000Z`;
beforeAll(async () => {
  h = await createHarness({ brand: true });
  await h.seedBrand(); await h.seedBrand("brand-b");
  await h.db.prepare(`INSERT INTO click_sessions (click_session_id,gclid,click_seen_at,first_seen_at,last_seen_at,created_at,hostname)
    VALUES ('paid','click-private',?1,?1,?1,?1,'brand-a.example')`).bind(at(10, 0)).run();
  for (const [day, types] of [[10, currentTypes], [9, previousTypes]] as const) {
    await h.db.batch(types.map((type, i) => h.db.prepare(`INSERT INTO traffic_events
      (event_type,session_id,click_session_id,hostname,brand,source,campaign,device_class,browser_family,form_step,error_code,
       occurred_at,created_at,risk_score,user_agent_family,country) VALUES (?1,?2,?3,'brand-a.example','Untrusted display',?4,'campaign','desktop','chrome',NULL,NULL,?5,?5,?6,?7,?8)`)
      .bind(type, day === 10 && i === 2 ? "10-0" : `${day}-${i}`, day === 10 && i === 2 ? "paid" : null,
        i === 0 ? null : "google", at(day, i), day === 10 && (i === 2 || i === 3) ? 50 : 0,
        day === 10 && i === 2 ? "adsbot" : "browser", i < 10 ? "US" : "CA")));
  }
  await h.db.prepare(`INSERT INTO bot_hits VALUES
    ('brand-a','2026-11-10T12:00:00Z','adsbot',2),('brand-a','2026-11-10T11:00:00Z','adsbot',3),
    ('brand-a','2026-11-09T13:00:00Z','adsbot',4),('brand-a','2026-11-10T12:00:00Z','googlebot',7),
    ('brand-a','2026-11-09T13:00:00Z','other-bot',8),('brand-b','2026-11-10T12:00:00Z','adsbot',99)`).run();
});
afterAll(async () => { await h?.mf.dispose(); });

it("40 events produce exact KPIs, deltas, bots, AdsBot rows, five breakdowns, trend and 12-column recent rows in eleven SELECTs", async () => {
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM traffic_events").first("n")).toBe(40);
  let queries = 0;
  const db = { prepare: (sql: string) => { queries++; return h.db.prepare(sql); }, batch: h.db.batch.bind(h.db) } as unknown as D1Database;
  const report = await loadTrafficRealtime({ LEADS: db }, { period: "24h", brand: "brand-a" }, now);
  expect(queries).toBe(11);
  expect(TrafficRealtimeResponse.parse(report)).toEqual(report);
  expect(report.period).toBe("24h"); expect(report.from).toBe("2026-11-09T13:00:00.000Z"); expect(report.to).toBe(now.toISOString());
  expect(report.kpis).toEqual({ landing_views: 8, form_starts: 4, leads: 3, validation_errors: 2, redirect_errors: 1,
    suspicious_sessions: 2, no_gclid_landings: { count: 7, pct: 87.5 }, gate_drops: 1, non_us_pct: 50 });
  expect(report.deltas).toEqual({ landing_views: 100, form_starts: 0, leads: -25, validation_errors: -50, redirect_errors: -50,
    suspicious_sessions: null, no_gclid_landings: 75, gate_drops: -50, non_us_pct: 0 });
  expect(report.bots_now).toEqual({ adsbot: { current_hour: 2, "24h": 9 }, googlebot: { current_hour: 7, "24h": 7 }, "other-bot": { current_hour: 0, "24h": 8 } });
  expect(report.adsbot_last).toEqual([{ brand: "brand-a", url: "https://brand-a.example/", at: at(10, 2), http_status: null, response_ms: null, gate_passed: null }]);
  expect(report.breakdowns).toEqual({ source: [{ key: "google", count: 19, pct: 95 }, { key: "unknown", count: 1, pct: 5 }],
    hostname: [{ key: "brand-a.example", count: 20, pct: 100 }], device: [{ key: "desktop", count: 20, pct: 100 }],
    browser: [{ key: "chrome", count: 20, pct: 100 }], brand: [{ key: "brand-a", count: 20, pct: 100 }] });
  expect(report.trend).toEqual([{ at: "2026-11-10T12:00:00.000Z", landing_views: 8, form_starts: 4, leads: 3 }]);
  expect(report.recent).toEqual(currentTypes.map((type, i) => ({ at: at(10, i), event_type: type, hostname: "brand-a.example", brand: "brand-a",
    source: i === 0 ? null : "google", campaign: "campaign", device: "desktop", browser: "chrome", form_step: null, error_code: null,
    session_ref: hash(i === 2 ? "10-0" : `10-${i}`).slice(0, 16), user_agent_family: i === 2 ? "adsbot" : "browser" })).reverse());
  expect(Object.keys(report.recent[0]!)).toHaveLength(12);
  expect(JSON.stringify(report)).not.toContain("click-private");
});
it("filters every field and uses daily buckets for 7d and 30d", async () => {
  const env = { LEADS: h.db as unknown as D1Database };
  const empty = await loadTrafficRealtime(env, { period: "24h", brand: "brand-b" }, now);
  expect(empty.kpis.landing_views).toBe(0); expect(empty.kpis.non_us_pct).toBeNull();
  expect(empty.recent).toEqual([]); expect(empty.adsbot_last).toEqual([]); expect(empty.trend).toEqual([]);
  expect(Object.values(empty.breakdowns)).toEqual([[], [], [], [], []]);
  expect(empty.bots_now.adsbot).toEqual({ current_hour: 99, "24h": 99 });
  for (const period of ["7d", "30d"] as const) {
    const report = await loadTrafficRealtime(env, { period, brand: "brand-a" }, now);
    expect(report.recent).toHaveLength(40);
    expect(report.trend).toEqual([{ at: "2026-11-09T00:00:00.000Z", landing_views: 4, form_starts: 4, leads: 4 },
      { at: "2026-11-10T00:00:00.000Z", landing_views: 8, form_starts: 4, leads: 3 }]);
  }
});

it("private admin endpoint allows owner and employee and rejects invalid query", async () => {
  for (const actor_role of ["owner", "employee"] as const) {
    const ctx = { actor_id: "user", actor_role, request_id: "req_realtime" };
    const response = await h.admin("/admin/traffic/realtime?period=24h&brand=brand-a", ctx);
    expect(response.status).toBe(200);
    expect(TrafficRealtimeResponse.safeParse(await response.json()).success).toBe(true);
    expect((await h.admin("/admin/traffic/realtime?period=invalid", ctx)).status).toBe(422);
  }
  expect((await h.request("/admin/traffic/realtime")).status).toBe(404);
});

it("historical traffic from removed brands remains readable without inventing a brand id", async () => {
  await h.db.prepare(`INSERT INTO traffic_events(event_type,session_id,hostname,occurred_at,created_at,user_agent_family)
    VALUES ('landing_viewed','legacy','retired.example',?1,?1,'adsbot'), ('landing_viewed','missing',NULL,?1,?1,'adsbot')`).bind(at(10, 30)).run();
  const report = await loadTrafficRealtime({ LEADS: h.db as unknown as D1Database }, { period: "24h" }, now);
  expect(report.adsbot_last).toContainEqual({ brand: "unknown", url: "https://retired.example/", at: at(10, 30), http_status: null, response_ms: null, gate_passed: null });
  expect(report.recent).toHaveLength(22);
  expect(report.adsbot_last).toHaveLength(2);
});

it("at 12:05Z counts only the current hour and exactly 24 hourly buckets", async () => {
  await h.db.prepare(`INSERT INTO bot_hits VALUES
    ('brand-a','2026-11-09T12:00:00Z','adsbot',1000),
    ('brand-a','2026-11-10T13:00:00Z','adsbot',2000)`).run();
  const report = await loadTrafficRealtime({ LEADS: h.db as unknown as D1Database }, { period: "24h", brand: "brand-a" }, new Date("2026-11-10T12:05:00.000Z"));
  // Includes previous-day 13:00 (4), today 11:00 (3), today 12:00 (2); excludes the 25th and future buckets.
  expect(report.bots_now).toEqual({ adsbot: { current_hour: 2, "24h": 9 }, googlebot: { current_hour: 7, "24h": 7 }, "other-bot": { current_hour: 0, "24h": 8 } });
  expect(Object.keys(report.bots_now.adsbot)).toEqual(["current_hour", "24h"]);
});

it("brand telemetry writes visitor geography and AdsBot classification consumed by the report", async () => {
  await h.reset(); await h.seedAccount(); await h.seedBrand();
  const brand = await h.mf.getWorker("brand");
  for (const [country, userAgent, session] of [["US", "AdsBot-Google", "ads-session"], ["CA", "Mozilla/5.0", "human-session"]]) {
    const response = await brand.fetch("https://brand-a.example/api/telemetry", {
      method: "POST", cf: { country, region: "Test region" }, headers: { "content-type": "application/json", "user-agent": userAgent! },
      body: JSON.stringify({ event_type: "landing_viewed", session_id: session }),
    });
    expect(response.status).toBe(204);
  }
  const report = await loadTrafficRealtime({ LEADS: h.db as unknown as D1Database }, { period: "24h", brand: "brand-a" }, new Date(Date.now() + 1000));
  expect(TrafficRealtimeResponse.parse(report)).toEqual(report);
  expect(report.kpis.landing_views).toBe(2);
  expect(report.kpis.non_us_pct).toBe(50);
  expect(report.adsbot_last).toHaveLength(1);
  expect(report.adsbot_last[0]).toMatchObject({ brand: "brand-a", url: "https://brand-a.example/", http_status: null, response_ms: null, gate_passed: null });
  expect(report.recent.find(row => row.session_ref === hash("ads-session").slice(0, 16))?.user_agent_family).toBe("adsbot");
  expect(report.recent.find(row => row.session_ref === hash("human-session").slice(0, 16))?.user_agent_family).toBe("browser");
});
