import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./helpers.js";
import { onTailEvent } from "../src/traffic-tail/alerts.js";
import { DIGEST_CRON, handleScheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import type { TrafficTailEvent } from "@anjuna/contracts";

let h: Harness;
let forwarded = 0;
const now = Date.parse("2026-11-10T02:00:00.000Z");
const event: TrafficTailEvent = { event_id: "test", ts: now, event_type: "landing_viewed", session_ref: null,
  brand: "brand-a", domain: "brand-a.example", device_type: null, browser: null, user_agent_family: "adsbot",
  url: "https://brand-a.example/", http_status: 200, response_ms: null, gate_passed: null };
const runtime = () => ({ LEADS: h.db, FACTORY: h.factory, TELEGRAM_BOT_TOKEN: "local-test-token" }) as unknown as Env;
beforeAll(async () => { h = await createHarness({ bindings: { TELEGRAM_BOT_TOKEN: "local-test-token" }, outbound: async () => {
  forwarded++; return Response.json({ ok: true });
} }); });
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => {
  vi.restoreAllMocks(); forwarded = 0; await h.reset(); await h.factory.prepare("DELETE FROM panel_settings").run();
  await h.factory.prepare("INSERT INTO panel_settings VALUES ('notify.telegram',?1,'owner',?2)")
    .bind(JSON.stringify({ enabled: true, chat_ids: ["123"] }), new Date(now).toISOString()).run();
});
it("accepted AdsBot telemetry creates a notification log through the production hook", async () => {
  await h.seedAccount(); await h.seedBrand();
  const response = await h.request("/analytics/telemetry", { method: "POST",
    headers: { authorization: "Bearer account-a-token", "content-type": "application/json", "user-agent": "AdsBot-Google" },
    body: JSON.stringify({ brand_id: "brand-a", hostname: "brand-a.example", kind: "telemetry", path: "/", content_type: "application/json",
      body: JSON.stringify({ event_type: "landing_viewed", session_id: "private-session" }) }) });
  expect(response.status).toBe(204);
  const deadline = Date.now() + 2000;
  let row: unknown;
  while (Date.now() < deadline) {
    row = await h.db.prepare("SELECT alert_key,status FROM notification_log").first();
    if (row) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(row).toEqual({ alert_key: "adsbot:brand-a", status: "sent" });
  expect(forwarded).toBe(1);
});
it("AdsBot fast path ignores browsers, enforces ten minutes, and raises non-200 to alert", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
  await onTailEvent({ ...event, user_agent_family: "browser" }, runtime());
  expect(fetcher).not.toHaveBeenCalled();
  await onTailEvent(event, runtime());
  await onTailEvent({ ...event, ts: now + 599_000, http_status: 503 }, runtime());
  expect(fetcher).toHaveBeenCalledTimes(1);
  await onTailEvent({ ...event, ts: now + 600_000, http_status: 503 }, runtime());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await h.db.prepare("SELECT state FROM alert_state WHERE alert_key='adsbot:brand-a'").first("state")).toBe("alert");
  expect(JSON.stringify((await h.db.prepare("SELECT * FROM notification_log").all()).results)).not.toContain("local-test-token");
  vi.restoreAllMocks();
});
it("09:00 Bangkok digest cron sends once, with the completed day's five numbers", async () => {
  await h.seedBrand();
  await h.seedLead("digest-sold", "digest-sold");
  await h.seedLead("digest-unsold", "digest-unsold");
  await h.seedLead("digest-today", "digest-today");
  await h.db.prepare("UPDATE leads SET created_at='2026-11-09T12:00:00.000Z' WHERE lead_id IN ('digest-sold','digest-unsold')").run();
  await h.db.prepare("UPDATE leads SET created_at='2026-11-10T01:00:00.000Z' WHERE lead_id='digest-today'").run();
  await h.db.prepare("INSERT INTO postback_events(lead_id,event_type,payout,created_at) VALUES ('digest-sold','soldLead',50,'2026-11-09T13:00:00.000Z')").run();
  await h.db.prepare(`INSERT INTO ad_spend(brand_id,date,hour,cost,currency,updated_at) VALUES
    ('brand-a','2026-11-09',12,20,'USD','2026-11-09T12:00:00.000Z'),
    ('brand-a','2026-11-09',13,350,'THB','2026-11-09T13:00:00.000Z'),
    ('brand-a','2026-11-10',1,999,'USD','2026-11-10T01:00:00.000Z')`).run();
  await h.factory.prepare("INSERT INTO panel_settings VALUES ('notify.digest',?1,'owner',?2)")
    .bind(JSON.stringify({ enabled: true, time: "09:00" }), new Date(now).toISOString()).run();
  let text = "";
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    text = (JSON.parse(String(init?.body)) as { text: string }).text;
    return Response.json({ ok: true });
  });
  await handleScheduled({ cron: DIGEST_CRON, scheduledTime: now }, runtime(), {});
  await handleScheduled({ cron: DIGEST_CRON, scheduledTime: now }, runtime(), {});
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const label of ["ค่าโฆษณา $30.00", "ลีด 2", "CPL $15.00", "ขายได้ 1", "กำไร $20.00", "ตรวจพบ 09:00"]) expect(text).toContain(label);
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM notification_log").first("n")).toBe(1);
  vi.restoreAllMocks();
});
