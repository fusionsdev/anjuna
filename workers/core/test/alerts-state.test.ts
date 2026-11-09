import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";
import type { AdminRequestContext } from "@anjuna/contracts";

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
  await h.db.batch([h.db.prepare("DELETE FROM alert_state"), h.db.prepare("DELETE FROM notification_log")]); sends = [];
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
