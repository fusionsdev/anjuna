import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { expect, it } from "vitest";
import { AlertsReportResponse, AlertStateRow, TrafficRealtimeResponse, TrafficTailEvent } from "@anjuna/contracts";
import { loadTrafficRealtime } from "../src/admin/traffic-realtime.js";
import { createHarness, hash } from "./helpers.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const text = (name: string) => readFileSync(fixture(name), "utf8");
const json = (name: string): unknown => JSON.parse(text(name));
type Context = { now: string; events: Record<string, { session_id: string; gclid: string | null;
  country: string; risk_score: number; source: string; campaign: string; form_step: number | null; error_code: string | null }> };

it("W03-5 fixtures satisfy contracts, coverage and the real D1 report", async () => {
  const events = text("traffic-events.ndjson").trim().split(/\r?\n/).map(line => TrafficTailEvent.parse(JSON.parse(line)));
  const context = json("traffic-events.context.json") as Context;
  const expected = TrafficRealtimeResponse.parse(json("traffic-events.expected.json"));
  execFileSync(process.execPath, [fileURLToPath(fixture("compute-expected.mjs")), "--check"]);
  expect(events).toHaveLength(40);
  expect(new Set(events.map(e => e.event_id)).size).toBe(40);
  expect(Object.keys(context.events).sort()).toEqual(events.map(e => e.event_id).sort());
  expect(new Set(events.map(e => e.brand)).size).toBe(4);
  expect(new Set(events.map(e => new Date(e.ts).toISOString().slice(0, 13))).size).toBe(24);
  const analytics = readFileSync(new URL("../src/analytics.ts", import.meta.url), "utf8");
  const eventTypes = [...analytics.match(/const TRAFFIC_EVENTS = new Set\(\[([\s\S]*?)\]\)/)![1]!.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  expect([...new Set(events.map(e => e.event_type))].sort()).toEqual(eventTypes.sort());
  expect(events.filter(e => e.user_agent_family === "adsbot")).toHaveLength(3);
  expect(events.filter(e => e.user_agent_family === "adsbot" && e.http_status === 500)).toHaveLength(1);
  expect(events.filter(e => e.user_agent_family === "googlebot")).toHaveLength(2);
  expect(events.filter(e => e.user_agent_family === "other-bot")).toHaveLength(1);
  expect(new Set(Object.values(context.events).map(e => e.country).filter(c => c !== "US"))).toEqual(new Set(["CA", "GB", "DE", "TH"]));
  expect(expected.kpis).toMatchObject({ landing_views: 12, form_starts: 4, leads: 4, validation_errors: 4,
    redirect_errors: 4, suspicious_sessions: 1, no_gclid_landings: { count: 5 }, gate_drops: 3, non_us_pct: 10 });
  expect(Object.values(expected.deltas)).toEqual(Array(9).fill(null));
  expect(expected.breakdowns.source).toHaveLength(10);
  expect(expected.bots_now).toEqual({ adsbot: { current_hour: 1, "24h": 3 }, googlebot: { current_hour: 0, "24h": 2 }, "other-bot": { current_hour: 0, "24h": 1 } });

  const names = readdirSync(fixture("alert-reports")).sort();
  expect(names).toEqual(["acknowledged.json", "all-ok.json", "one-alert.json", "one-warn.json", "warn-to-alert.json"]);
  const reports = Object.fromEntries(names.map(name => [name, AlertsReportResponse.parse(json(`alert-reports/${name}`))]));
  for (const name of names) {
    const { generated_at: _, ...rules } = reports[name]!;
    expect(Object.values(rules).filter(rule => rule.state !== "ok")).toHaveLength(name === "all-ok.json" ? 0 : 1);
  }
  expect(reports["one-warn.json"]!.submit_error_rate.state).toBe("warn");
  for (const name of ["one-alert.json", "warn-to-alert.json", "acknowledged.json"]) {
    expect(reports[name]!.submit_error_rate.state).toBe("alert");
  }
  expect(reports["warn-to-alert.json"]!.generated_at > reports["one-warn.json"]!.generated_at).toBe(true);
  const ack = AlertStateRow.parse(json("acknowledged.state.json"));
  expect(ack.alert_key).toBe("submit_error_rate");
  expect(ack.state).toBe("alert");
  expect(ack.acknowledged_by).toBe("fixture-owner");
  expect(ack.acknowledged_at).toBe(reports["acknowledged.json"]!.generated_at);
  const uaText = readFileSync(new URL("../../../apps/web/test/fixtures/adsbot-user-agents.txt", import.meta.url), "utf8");
  expect(uaText).toContain("https://developers.google.com/crawling/docs/crawlers-fetchers/");
  const uas = uaText.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  expect(uas).toHaveLength(5);
  for (const token of ["AdsBot-Google (", "AdsBot-Google-Mobile;", "Googlebot/2.1", "Googlebot-Image/1.0", "Google-InspectionTool/1.0"]) {
    expect(uas.some(ua => ua.includes(token))).toBe(true);
  }

  // Exercise the independent SQL implementation so a bug shared by the
  // generator and its golden output cannot silently certify wrong numbers.
  const h = await createHarness();
  try {
    for (const brand of new Set(events.map(e => e.brand))) await h.seedBrand(brand);
    for (const e of events) {
      const c = context.events[e.event_id]!;
      expect(e.session_ref).toBe(hash(c.session_id).slice(0, 16));
      const at = new Date(e.ts).toISOString();
      if (c.gclid) await h.db.prepare(`INSERT INTO click_sessions
        (click_session_id,gclid,click_seen_at,first_seen_at,last_seen_at,created_at,hostname)
        VALUES (?1,?2,?3,?3,?3,?3,?4)`).bind(e.event_id, c.gclid, at, e.domain).run();
      await h.db.prepare(`INSERT INTO traffic_events
        (event_type,session_id,click_session_id,hostname,brand,source,campaign,device_class,browser_family,
         form_step,error_code,occurred_at,created_at,risk_score,user_agent_family,country)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13,?14,?15)`)
        .bind(e.event_type, c.session_id, c.gclid ? e.event_id : null, e.domain, e.brand, c.source, c.campaign,
          e.device_type, e.browser, c.form_step, c.error_code, at, c.risk_score, e.user_agent_family, c.country).run();
      if (["adsbot", "googlebot", "other-bot"].includes(e.user_agent_family)) {
        const hour = at.slice(0, 13) + ":00:00Z";
        await h.db.prepare(`INSERT INTO bot_hits (brand_id,hour,kind,hits) VALUES (?1,?2,?3,1)
          ON CONFLICT(brand_id,hour,kind) DO UPDATE SET hits=hits+1`).bind(e.brand, hour, e.user_agent_family).run();
      }
    }
    expect(await loadTrafficRealtime({ LEADS: h.db as unknown as D1Database }, { period: "24h" }, new Date(context.now))).toEqual(expected);
  } finally { await h.mf.dispose(); }
});
