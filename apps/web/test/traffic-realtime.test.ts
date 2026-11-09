import { beforeAll, expect, it } from "vitest";
import { TrafficRealtimeResponse } from "@anjuna/contracts";
import { call, makeEnv, sessions, setupDatabases } from "./helpers";

beforeAll(setupDatabases);
const zero = { landing_views: 0, form_starts: 0, leads: 0, validation_errors: 0, redirect_errors: 0, suspicious_sessions: 0, no_gclid_landings: { count: 0, pct: 0 }, gate_drops: 0, non_us_pct: null };
const report = TrafficRealtimeResponse.parse({ period: "24h", from: "2026-11-09T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", kpis: zero,
  deltas: Object.fromEntries(Object.keys(zero).map(key => [key, null])),
  bots_now: Object.fromEntries(["adsbot", "googlebot", "other-bot"].map(key => [key, { current_hour: 0, "24h": 0 }])),
  adsbot_last: [], breakdowns: { source: [], hostname: [], device: [], browser: [], brand: [] }, trend: [], recent: [] });

it.each(["owner", "employee"] as const)("%s receives validated report and forwarded brand filter", async role => {
  let query = "";
  const binding = { async fetch(request: Request) { query = new URL(request.url).search; return Response.json(report); } } as unknown as Fetcher;
  const response = await call("/api/traffic/realtime?period=24h&brand=brand-a", { cookie: await sessions[role](), env: makeEnv({ CORE: binding, MOCK_CORE: "0" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(report);
  expect(query).toBe("?period=24h&brand=brand-a");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("rejects invalid query before calling core; malformed core output returns 502", async () => {
  let calls = 0;
  const binding = { async fetch() { calls++; return Response.json({ private: "discard" }); } } as unknown as Fetcher;
  const options = { cookie: await sessions.owner(), env: makeEnv({ CORE: binding, MOCK_CORE: "0" }) };
  expect((await call("/api/traffic/realtime?period=invalid", options)).status).toBe(422);
  expect(calls).toBe(0);
  const response = await call("/api/traffic/realtime", options);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("discard");
});
