import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_FORWARD_PATHS,
  AdminError,
  AlertsReportResponse,
  RISK_HOURS_TIMEZONE,
  TrafficRiskExportResponse,
  TrafficRiskResponse,
  type AdminRequestContext,
  type AnalyticsForwardRequest,
  type AnalyticsVisitor,
} from "@anjuna/contracts";
import { riskWindow } from "../src/admin/traffic-risk.js";
import { createHarness, fixtureText, hash, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_risk_owner_01" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_risk_emp_01" };

const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const IP_HASH_A = hash("203.0.113.9:brand-a");
const IP_HASH_B = hash("198.51.100.7:brand-a");
const CLICK = "click-session-token-0123456789abcdef";

let h: Harness;
beforeAll(async () => { h = await createHarness({ brand: true }); });
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => {
  await h.reset();
  await h.seedAccount();
  await h.seedBrand();
});

const golden = JSON.parse(fixtureText("analytics/forward.telemetry.request.json")) as AnalyticsForwardRequest;
const telemetryBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event_type: "landing_viewed", session_id: "session-1", ...extra });

function forward(visitor?: AnalyticsVisitor, body = telemetryBody()) {
  return h.request(ANALYTICS_FORWARD_PATHS.telemetry, {
    method: "POST",
    headers: { authorization: "Bearer account-a-token", "content-type": "application/json" },
    body: JSON.stringify({ ...golden, body, ...(visitor ? { visitor } : {}) }),
  });
}
const rows = async () => (await h.db.prepare(
  "SELECT session_id, click_session_id, risk_score, risk_signals FROM traffic_events ORDER BY id",
).all<{ session_id: string; click_session_id: string | null; risk_score: number; risk_signals: string }>()).results;
const snapshot = async (response: Response) => [response.status, Object.fromEntries(response.headers), await response.text()];

describe("risk scoring at ingest", () => {
  it.each([
    ["no visitor facts", undefined, {}, 0, []],
    ["a browser user agent", { user_agent: PHONE_UA }, {}, 0, []],
    ["a known bot user agent", { user_agent: BOT_UA }, {}, 50, ["known_bot_ua"]],
    ["a headless browser", { user_agent: "Mozilla/5.0 HeadlessChrome/129.0" }, {}, 50, ["known_bot_ua"]],
    ["a browser timezone that differs from the edge", { edge_timezone: "America/Chicago" }, { browser_timezone: "Asia/Bangkok" }, 20, ["timezone_geo_mismatch"]],
    ["a browser timezone equal to the edge", { edge_timezone: "America/Chicago" }, { browser_timezone: "America/Chicago" }, 0, []],
    ["an edge timezone without a browser timezone", { edge_timezone: "America/Chicago" }, {}, 0, []],
    ["a bot with a timezone mismatch", { user_agent: BOT_UA, edge_timezone: "America/Chicago" }, { browser_timezone: "Europe/Berlin" }, 70, ["known_bot_ua", "timezone_geo_mismatch"]],
  ] as const)("scores %s", async (_name, visitor, extra, score, signals) => {
    const response = await forward(visitor as AnalyticsVisitor | undefined, telemetryBody(extra));
    expect(response.status).toBe(204);
    const [row] = await rows();
    expect(row).toMatchObject({ risk_score: score, risk_signals: JSON.stringify(signals) });
  });

  it("fires rapid_repeat_session on the 26th event from one IP hash in an hour, never for another hash", async () => {
    for (let i = 0; i < 26; i++) await forward({ ip_hash: IP_HASH_A }, telemetryBody({ session_id: `a-${i}` }));
    await forward({ ip_hash: IP_HASH_B }, telemetryBody({ session_id: "b-0" }));
    const stored = await rows();
    expect(stored.slice(0, 25).every((row) => row.risk_score === 0)).toBe(true);
    expect(stored[25]).toMatchObject({ session_id: "a-25", risk_score: 30, risk_signals: '["rapid_repeat_session"]' });
    expect(stored[26]).toMatchObject({ session_id: "b-0", risk_score: 0 });
  });

  it("keeps an IP hash for the current hour only and never stores a raw IP", async () => {
    await h.db.prepare("INSERT INTO traffic_velocity (hour, ip_hash, events) VALUES ('2026-01-01T00', ?1, 99)").bind(IP_HASH_A).run();
    await forward({ ip_hash: IP_HASH_A });
    const velocity = await h.db.prepare("SELECT hour, ip_hash, events FROM traffic_velocity").all<{ hour: string; ip_hash: string; events: number }>();
    expect(velocity.results).toEqual([{ hour: new Date().toISOString().slice(0, 13), ip_hash: IP_HASH_A, events: 1 }]);
    const brand = await h.mf.getWorker("brand");
    await brand.fetch("https://brand-a.example/api/telemetry", {
      method: "POST", body: telemetryBody(), headers: { "user-agent": PHONE_UA, "cf-connecting-ip": "203.0.113.9" },
    });
    const dump = JSON.stringify([(await h.db.prepare("SELECT * FROM traffic_events").all()).results, (await h.db.prepare("SELECT * FROM traffic_velocity").all()).results]);
    expect(dump).not.toContain("203.0.113.9");
    expect(dump).toContain(IP_HASH_A);
  });

  it("stores the click session id the brand Worker forwards", async () => {
    await forward({ click_session_id: CLICK });
    expect((await rows())[0]).toMatchObject({ click_session_id: CLICK });
  });

  it("still stores the event when the velocity table is unavailable", async () => {
    await h.db.prepare("ALTER TABLE traffic_velocity RENAME TO traffic_velocity_away").run();
    try {
      expect((await forward({ user_agent: BOT_UA, ip_hash: IP_HASH_A })).status).toBe(204);
      expect((await rows())[0]).toMatchObject({ risk_score: 50, risk_signals: '["known_bot_ua"]' });
    } finally { await h.db.prepare("ALTER TABLE traffic_velocity_away RENAME TO traffic_velocity").run(); }
  });
});

describe("observe-only: the response never depends on the score (AGENTS.md rule 3)", () => {
  it("core answers a bot and a browser identically", async () => {
    const bot = await snapshot(await forward({ user_agent: BOT_UA, edge_timezone: "America/Chicago", ip_hash: IP_HASH_A }, telemetryBody({ browser_timezone: "Europe/Berlin" })));
    const browser = await snapshot(await forward({ user_agent: PHONE_UA, edge_timezone: "America/Chicago", ip_hash: IP_HASH_B }, telemetryBody({ browser_timezone: "America/Chicago" })));
    expect(bot).toEqual(browser);
    expect(bot[0]).toBe(204);
    expect((await rows()).map((row) => row.risk_score)).toEqual([70, 0]);
  });

  it("the brand Worker answers a bot and a browser identically end to end", async () => {
    const brand = await h.mf.getWorker("brand");
    const send = async (userAgent: string) => snapshot(await brand.fetch("https://brand-a.example/api/telemetry", {
      method: "POST", body: telemetryBody(), headers: { "content-type": "application/json", "user-agent": userAgent, "cf-connecting-ip": "203.0.113.9" },
    }) as unknown as Response);
    expect(await send(BOT_UA)).toEqual(await send(PHONE_UA));
    expect((await rows()).map((row) => row.risk_score)).toEqual([50, 0]);
  });
});

describe("admin risk report and export", () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const nyHour = (iso: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: RISK_HOURS_TIMEZONE, hour: "numeric", hourCycle: "h23" }).format(Date.parse(iso)));

  async function event(session: string, hostname: string, createdAt: string, score: number | null, signals: string[] | null, click: string | null = null) {
    await h.db.prepare(`INSERT INTO traffic_events (event_type, session_id, click_session_id, hostname, occurred_at, created_at, risk_score, risk_signals)
      VALUES ('landing_viewed', ?1, ?2, ?3, ?4, ?4, ?5, ?6)`)
      .bind(session, click, hostname, createdAt, score, signals === null ? null : JSON.stringify(signals)).run();
  }
  async function click(id: string, gclid: string, leadId: string | null = null) {
    await h.db.prepare(`INSERT INTO click_sessions (click_session_id, gclid, click_seen_at, first_seen_at, last_seen_at, lead_id, created_at, hostname)
      VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?3, 'brand-a.example')`).bind(id, gclid, ago(30), leadId).run();
  }

  const t1 = ago(2);
  const t2 = ago(26);
  beforeEach(async () => {
    // brand-a: bot visit via the click cookie (2 events, max 70), repeat visit via its lead, one low visit, one legacy row.
    await event("bot-1", "brand-a.example", t1, 50, ["known_bot_ua"], CLICK);
    await event("bot-1", "brand-a.example", ago(1.9), 70, ["known_bot_ua", "timezone_geo_mismatch"], CLICK);
    await event("lead-visit", "brand-a.example", t2, 50, ["timezone_geo_mismatch", "rapid_repeat_session"]);
    await event("calm", "brand-a.example", t1, 20, ["timezone_geo_mismatch"]);
    await event("legacy", "brand-a.example", t1, null, null);
    // brand-b: one high-risk visit without any known click.
    await event("nobody", "brand-b.example", t1, 50, ["known_bot_ua"]);
    // Outside every period.
    await event("ancient", "brand-a.example", ago(24 * 40), 90, ["known_bot_ua"]);
    await click(CLICK, "gclid-from-cookie");
    await h.seedLead("lead-risk-1", "leadrisk1", "brand-a");
    await h.db.prepare("UPDATE leads SET session_id = 'lead-visit' WHERE lead_id = 'lead-risk-1'").run();
    await click("click-session-of-the-lead-000001", "gclid-from-lead", "lead-risk-1");
  });

  it("returns signals, domains and US Eastern hours per the Risk API contract", async () => {
    const response = await h.admin("/admin/traffic/risk?period=7d", employee);
    expect(response.status).toBe(200);
    const report = TrafficRiskResponse.parse(await response.json());
    expect(report.signals).toEqual([
      { id: "known_bot_ua", label: "เครื่องดูเป็นบอท (user agent)", weight: 50, count: 2 },
      { id: "timezone_geo_mismatch", label: "เขตเวลาไม่ตรงกับประเทศ", weight: 20, count: 3 },
      { id: "rapid_repeat_session", label: "คลิกซ้ำถี่เกิน 25 ครั้ง/ชม.", weight: 30, count: 1 },
    ]);
    expect(report.domains).toEqual([
      { hostname: "brand-a.example", visits: 4, high_risk: 2 },
      { hostname: "brand-b.example", visits: 1, high_risk: 1 },
    ]);
    // A visit lands in the US Eastern clock hour of its first event: four start at t1, one at t2.
    const expected = Array.from({ length: 24 }, (_, hour) => ({ hour, visits: 0, high_risk: 0 }));
    for (const [at, high] of [[t1, 1], [t1, 0], [t1, 0], [t1, 1], [t2, 1]] as const) {
      expected[nyHour(at)]!.visits += 1;
      expected[nyHour(at)]!.high_risk += high;
    }
    expect(report.hours).toEqual(expected);
  });

  it("counts 30 days with period=30d and rejects an unknown period", async () => {
    const month = TrafficRiskResponse.parse(await (await h.admin("/admin/traffic/risk?period=30d", employee)).json());
    expect(month.domains.reduce((sum, d) => sum + d.visits, 0)).toBe(5);
    const invalid = await h.admin("/admin/traffic/risk?period=90d", employee);
    expect(invalid.status).toBe(422);
    expect(AdminError.parse(await invalid.json())).toMatchObject({ error: "invalid" });
  });

  it("exports high-risk visits with their gclid to the owner", async () => {
    const response = await h.admin("/admin/traffic/risk/export?period=7d", owner);
    expect(response.status).toBe(200);
    const body = TrafficRiskExportResponse.parse(await response.json());
    expect(body).toEqual({
      truncated: false,
      rows: [
        { gclid: "gclid-from-cookie", hostname: "brand-a.example", score: 70, signals: ["known_bot_ua", "timezone_geo_mismatch"], created_at: t1 },
        { gclid: null, hostname: "brand-b.example", score: 50, signals: ["known_bot_ua"], created_at: t1 },
        { gclid: "gclid-from-lead", hostname: "brand-a.example", score: 50, signals: ["timezone_geo_mismatch", "rapid_repeat_session"], created_at: t2 },
      ],
    });
    const filtered = TrafficRiskExportResponse.parse(await (await h.admin("/admin/traffic/risk/export?period=7d&hostname=brand-b.example", owner)).json());
    expect(filtered.rows.map((row) => row.hostname)).toEqual(["brand-b.example"]);
  });

  it("refuses the export to an employee", async () => {
    const response = await h.admin("/admin/traffic/risk/export?period=7d", employee);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
  });
});

describe("risk periods", () => {
  it("starts today at midnight US Eastern, across both DST offsets and on the switch day", () => {
    const now = (iso: string) => Date.parse(iso);
    expect(riskWindow("today", now("2026-10-22T15:00:00.000Z"))).toEqual({ from: "2026-10-22T04:00:00.000Z", to: "2026-10-22T15:00:00.000Z" });
    expect(riskWindow("today", now("2026-01-15T03:00:00.000Z")).from).toBe("2026-01-14T05:00:00.000Z");
    expect(riskWindow("today", now("2026-03-08T12:00:00.000Z")).from).toBe("2026-03-08T05:00:00.000Z");
    expect(riskWindow("today", now("2026-11-01T12:00:00.000Z")).from).toBe("2026-11-01T04:00:00.000Z");
  });
  it("ends 7d and 30d now", () => {
    const at = Date.parse("2026-10-22T15:00:00.000Z");
    expect(riskWindow("7d", at)).toEqual({ from: "2026-10-15T15:00:00.000Z", to: "2026-10-22T15:00:00.000Z" });
    expect(riskWindow("30d", at).from).toBe("2026-09-22T15:00:00.000Z");
  });
});

describe("click risk alert", () => {
  const now = "2026-10-02T00:00:00.000Z";
  async function visits(hostname: string, count: number, high: number) {
    const stmt = h.db.prepare(`INSERT INTO traffic_events (event_type, session_id, hostname, occurred_at, created_at, risk_score, risk_signals)
      VALUES ('landing_viewed', ?1, ?2, '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z', ?3, ?4)`);
    await h.db.batch(Array.from({ length: count }, (_, i) =>
      stmt.bind(`${hostname}-${i}`, hostname, i < high ? 50 : 0, i < high ? '["known_bot_ua"]' : "[]")));
  }

  it("alerts a hostname with at least 20% high-risk visits over 24 hours and at least 50 visits", async () => {
    await visits("brand-a.example", 50, 10);
    await visits("brand-b.example", 40, 40);
    const report = AlertsReportResponse.parse(await (await h.admin(`/admin/alerts?now=${now}`, employee)).json());
    expect(report.click_risk).toEqual({
      state: "alert",
      detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [{ hostname: "brand-a.example", visits: 50, high_risk: 10, rate: 0.2 }] },
    });
  });

  it("stays ok at 18% high-risk visits", async () => {
    await visits("brand-a.example", 50, 9);
    const report = AlertsReportResponse.parse(await (await h.admin(`/admin/alerts?now=${now}`, employee)).json());
    expect(report.click_risk.state).toBe("ok");
  });
});
