import { expect, it } from "vitest";
import { AlertStateRow, NotificationLogRow, NotifySettings, TrafficRealtimeResponse, TrafficTailEvent, UserPrefs } from "../src/index.js";

const at = "2026-11-10T02:00:00.000Z";
const event = { event_id: "42", ts: Date.parse(at), event_type: "landing_viewed", session_ref: "a".repeat(16),
  brand: "brand-a", domain: "example.com", device_type: "desktop", browser: "chrome", user_agent_family: "adsbot",
  url: "https://example.com/", http_status: null, response_ms: null, gate_passed: null };
it("TrafficTailEvent parses and rejects private fields", () => {
  expect(TrafficTailEvent.parse(event)).toEqual(event);
  for (const key of ["email", "ip", "gclid", "lead_id", "session_id", "payload"]) {
    expect(TrafficTailEvent.safeParse({ ...event, [key]: "private" }).success).toBe(false);
  }
  expect(TrafficTailEvent.safeParse({ ...event, url: "https://example.com/?email=private" }).success).toBe(false);
});
it("TrafficRealtimeResponse parses all report fields", () => {
  const metrics = { landing_views: 0, form_starts: 0, leads: 0, validation_errors: 0, redirect_errors: 0 };
  const bots = { "15m": 0, "1h": 0, "24h": 0 };
  const report = { period: "24h", from: at, to: at,
    kpis: { ...metrics, suspicious_sessions: null, no_gclid_landings: { count: 0, pct: 0 }, gate_drops: 0, non_us_pct: null },
    deltas: { ...metrics, suspicious_sessions: null, no_gclid_landings: null, gate_drops: null, non_us_pct: null },
    bots_now: { googlebot: bots, adsbot: bots, "other-bot": bots }, adsbot_last: [],
    breakdowns: { source: [], hostname: [], device: [], browser: [], brand: [] }, trend: [], recent: [] };
  expect(TrafficRealtimeResponse.parse(report)).toEqual(report);
  expect(TrafficRealtimeResponse.safeParse({ ...report, kpis: { ...report.kpis, email: "private" } }).success).toBe(false);
});
it("AlertStateRow parses", () => {
  expect(AlertStateRow.parse({ alert_key: "adsbot:brand-a", state: "warn", first_seen: at, updated_at: at,
    last_sent: null, acknowledged_by: null, acknowledged_at: null, closed_at: null }).state).toBe("warn");
});
it("NotificationLogRow parses", () => {
  expect(NotificationLogRow.parse({ id: "n1", channel: "telegram", target: "123", alert_key: "adsbot:brand-a",
    status: "sent", response_code: 200, body_hash: "a".repeat(64), sent_at: at }).response_code).toBe(200);
});
it("NotifySettings parses and checks nested values", () => {
  const settings = { telegram: { enabled: true, chat_ids: ["-123"] }, routing: {
    adsbot: { telegram: true, repeat_hours: 6, quiet: { from: "22:00", to: "07:00" } } }, digest: { enabled: true, time: "09:00" } };
  expect(NotifySettings.parse(settings)).toEqual(settings);
  expect(NotifySettings.safeParse({ ...settings, digest: { enabled: true, time: "25:00" } }).success).toBe(false);
});
it("UserPrefs parses", () => {
  const prefs = { brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: { traffic: { period: "24h" } } };
  expect(UserPrefs.parse(prefs)).toEqual(prefs);
  expect(UserPrefs.safeParse({ ...prefs, unexpected: true }).success).toBe(false);
});
