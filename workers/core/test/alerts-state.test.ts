import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";
import { AlertStateRow, type AdminRequestContext } from "@anjuna/contracts";
import { ALERTS_CRON } from "../src/cron.js";

let h: Harness;
const owner: AdminRequestContext = { actor_id: "owner", actor_role: "owner", request_id: "req_state" };
const employee: AdminRequestContext = { ...owner, actor_id: "employee", actor_role: "employee" };
let sends: unknown[] = [];
beforeAll(async () => {
  h = await createHarness({ bindings: { TELEGRAM_BOT_TOKEN: "not-a-real-token" }, outbound: async request => {
    sends.push(await request.json()); return Response.json({ ok: true });
  } });
});
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => {
  // Audit history is append-only. Reset only the mutable tables used by this fixture.
  await h.db.batch(["notification_log", "alert_state", "conversion_uploads", "postback_events", "leads", "ad_spend", "brand_runtime"]
    .map(table => h.db.prepare(`DELETE FROM ${table}`))); sends = [];
  await h.factory.prepare("DELETE FROM panel_settings").run();
  await h.db.prepare("INSERT INTO alert_state(alert_key,state,first_seen,updated_at) VALUES ('adsbot:brand-a','warn',?1,?1)").bind(new Date().toISOString()).run();
});
const count = async () => (await (await h.admin("/admin/alerts/open-count", employee)).json()) as { alerts_open: number };
async function configure() {
  await h.factory.prepare("INSERT INTO panel_settings(key,value_json,updated_by,updated_at) VALUES ('notify.telegram',?1,'owner',?2)")
    .bind(JSON.stringify({ enabled: true, chat_ids: ["123", "456"] }), new Date().toISOString()).run();
}
it("employee acknowledgement hides an open alert and writes an audit", async () => {
  expect(await count()).toEqual({ alerts_open: 1 });
  const response = await h.admin("/admin/alerts/adsbot%3Abrand-a/ack", employee, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ acknowledged_by: "employee" });
  expect(await count()).toEqual({ alerts_open: 0 });
  expect(await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='alert.ack'").first("n")).toBe(1);
});
it("close hides the alert; unknown keys do not create state", async () => {
  expect((await h.admin("/admin/alerts/adsbot%3Abrand-a/close", employee, { method: "POST" })).status).toBe(200);
  expect(await count()).toEqual({ alerts_open: 0 });
  expect((await h.admin("/admin/alerts/unknown/ack", owner, { method: "POST" })).status).toBe(404);
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM alert_state WHERE alert_key='unknown'").first("n")).toBe(0);
});
it("log lists newest first with a bounded limit", async () => {
  for (const [id, sent] of [["old","2026-11-09T01:00:00.000Z"],["new","2026-11-10T01:00:00.000Z"]]) {
    await h.db.prepare("INSERT INTO notification_log VALUES (?1,'telegram','123','adsbot:brand-a','failed',503,?2,?3)").bind(id, "a".repeat(64), sent).run();
  }
  const response = await h.admin("/admin/alerts/log?limit=1", employee);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ rows: [{ id: "new" }] });
  for (const limit of ["0","101","abc","-1"]) expect((await h.admin("/admin/alerts/log?limit=" + limit, employee)).status).toBe(422);
});
it("owner test sends exactly one configured target, logs and audits the provider status", async () => {
  await configure();
  expect((await h.admin("/admin/notifications/test", employee, { method: "POST" })).status).toBe(403);
  const response = await h.admin("/admin/notifications/test", owner, { method: "POST" });
  expect(await response.json()).toEqual({ status: "sent", response_code: 200 });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ chat_id: "123" });
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM notification_log").first("n")).toBe(1);
  expect(await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='notification.test'").first("n")).toBe(1);
});
it("owner can retry a failed current alert to its still configured target; employee cannot", async () => {
  await configure();
  await h.db.prepare("INSERT INTO notification_log VALUES ('failed','telegram','123','adsbot:brand-a','failed',503,?1,?2)").bind("a".repeat(64), new Date().toISOString()).run();
  expect((await h.admin("/admin/alerts/log/failed/retry", employee, { method: "POST" })).status).toBe(403);
  expect(sends).toHaveLength(0);
  expect(await (await h.admin("/admin/alerts/log/failed/retry", owner, { method: "POST" })).json()).toEqual({ status: "sent", response_code: 200 });
  expect(sends).toHaveLength(1);
  expect(await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='notification.retry'").first("n")).toBe(1);
});

it.each(["ack", "close"])("a recovered incident can recur and be %s'd before cron without resending", async action => {
  await configure();
  await h.seedBrand();
  await h.seedLead("recurred");
  const start = Date.now() - 60_000;
  await h.seedConversion("recurred", { created_at: new Date(start - 8 * 3_600_000).toISOString() });
  const key = "conversion_stalled:brand-a";
  const tick = async (time: number) => { await h.core.scheduled({ cron: ALERTS_CRON, scheduledTime: new Date(time) }); };
  const row = async () => AlertStateRow.parse(await h.db.prepare("SELECT * FROM alert_state WHERE alert_key=?1").bind(key).first());
  await tick(start);
  expect((await row()).state).toBe("alert");
  expect(sends).toHaveLength(2);
  await h.db.prepare("UPDATE conversion_uploads SET status='uploaded' WHERE lead_id='recurred'").run();
  await tick(start + 30_000);
  const recovered = await row();
  expect(recovered.state).toBe("ok");
  await h.db.prepare("UPDATE conversion_uploads SET status='pending' WHERE lead_id='recurred'").run();
  const response = await h.admin(`/admin/alerts/${encodeURIComponent(key)}/${action}`, employee, { method: "POST" });
  expect(response.status).toBe(200);
  const recorded = AlertStateRow.parse(await response.json());
  expect(recorded.state).toBe("alert");
  expect(recorded.first_seen > recovered.first_seen).toBe(true);
  expect(recorded.last_sent).toBeNull();
  expect(recorded.acknowledged_by).toBe(action === "ack" ? "employee" : null);
  expect(recorded.acknowledged_at).toBe(action === "ack" ? recorded.updated_at : null);
  expect(recorded.closed_at).toBe(action === "close" ? recorded.updated_at : null);
  const delivered = sends.length;
  await tick(Date.parse(recorded.updated_at) + 1000);
  const after = await row();
  expect(after.first_seen).toBe(recorded.first_seen);
  expect(after.acknowledged_at).toBe(recorded.acknowledged_at);
  expect(after.closed_at).toBe(recorded.closed_at);
  expect(sends).toHaveLength(delivered);
  expect(await count()).toEqual({ alerts_open: 1 }); // only the separate AdsBot fixture remains open
});

it("owner retries a failed digest for its original summary day; employee cannot", async () => {
  await configure();
  await h.seedBrand();
  for (const id of ["digest-sold", "digest-unsold", "digest-other-day"]) await h.seedLead(id, id);
  await h.db.prepare("UPDATE leads SET created_at='2026-11-09T12:00:00.000Z' WHERE lead_id IN ('digest-sold','digest-unsold')").run();
  await h.db.prepare("UPDATE leads SET created_at='2026-11-10T12:00:00.000Z' WHERE lead_id='digest-other-day'").run();
  await h.db.prepare("INSERT INTO postback_events(lead_id,event_type,payout,created_at) VALUES ('digest-sold','soldLead',50,'2026-11-09T13:00:00.000Z')").run();
  await h.db.prepare(`INSERT INTO ad_spend(brand_id,date,hour,cost,currency,updated_at) VALUES
    ('brand-a','2026-11-09',12,20,'USD','2026-11-09T12:00:00.000Z'),
    ('brand-a','2026-11-09',13,350,'THB','2026-11-09T13:00:00.000Z'),
    ('brand-a','2026-11-10',1,999,'USD','2026-11-10T01:00:00.000Z')`).run();
  for (const [id, sent] of [["digest-original", "2026-11-10T02:00:00.000Z"], ["digest-later-failure", "2026-11-15T02:00:00.000Z"]]) {
    await h.db.prepare("INSERT INTO notification_log VALUES (?1,'telegram','123','digest:2026-11-10','failed',503,?2,?3)").bind(id, "a".repeat(64), sent).run();
  }
  const path = "/admin/alerts/log/digest-later-failure/retry";
  const auditsBefore = await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='notification.retry'").first<number>("n");
  expect((await h.admin(path, employee, { method: "POST" })).status).toBe(403);
  expect(sends).toHaveLength(0);
  const response = await h.admin(path, owner, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "sent", response_code: 200 });
  expect(sends).toHaveLength(1);
  const payload = sends[0] as { chat_id: string; text: string };
  expect(payload.chat_id).toBe("123");
  for (const label of ["ค่าโฆษณา $30.00", "ลีด 2", "CPL $15.00", "ขายได้ 1", "กำไร $20.00", "ตรวจพบ 09:00"]) expect(payload.text).toContain(label);
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM notification_log WHERE alert_key='digest:2026-11-10' AND status='sent'").first("n")).toBe(1);
  expect(await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='notification.retry'").first("n")).toBe((auditsBefore ?? 0) + 1);
});
