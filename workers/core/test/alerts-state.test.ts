import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";
import { AlertStateRow, type AdminRequestContext } from "@anjuna/contracts";
import { ALERTS_CRON } from "../src/cron.js";
import { MultiNotifier } from "@anjuna/insights";

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
it("state lists every acknowledged or closed row, newest first, and none that nobody touched", async () => {
  const at = new Date().toISOString();
  expect(await (await h.admin("/admin/alerts/state", employee)).json()).toEqual({ rows: [], next_cursor: null });
  await h.db.prepare("INSERT INTO alert_state(alert_key,state,first_seen,updated_at) VALUES ('reject_rate:brand-b','warn',?1,?1)").bind(at).run();
  expect((await h.admin("/admin/alerts/adsbot%3Abrand-a/ack", employee, { method: "POST" })).status).toBe(200);
  const response = await h.admin("/admin/alerts/state", employee);
  expect(response.status).toBe(200);
  const rows = ((await response.json()) as { rows: unknown[] }).rows;
  // brand-b was never touched, so it is not listed. The acknowledged brand-a row is.
  expect(rows.map(row => AlertStateRow.parse(row).alert_key)).toEqual(["adsbot:brand-a"]);
  expect(rows[0]).toMatchObject({ acknowledged_by: "employee", closed_at: null });
  expect((await h.admin("/admin/alerts/adsbot%3Abrand-a/close", owner, { method: "POST" })).status).toBe(200);
  const closed = ((await (await h.admin("/admin/alerts/state", owner)).json()) as { rows: Array<{ closed_at: string | null }> }).rows;
  expect(closed).toHaveLength(1);
  expect(closed[0]!.closed_at).not.toBeNull();
});
/** 501 keys from 101 brands x 5 rules. The first key written (the oldest update) is an acknowledge, every other one a close. */
async function seed501() {
  await h.db.prepare("DELETE FROM alert_state").run();
  const rules = ["conversion_stalled", "brands_without_postbacks", "submit_error_rate", "reject_rate", "click_risk"];
  const keys = Array.from({ length: 501 }, (_, i) => `${rules[i % 5]}:brand-${String(Math.floor(i / 5)).padStart(3, "0")}`);
  const stamp = (i: number) => new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + i * 1000).toISOString();
  await h.db.batch(keys.map((key, i) => h.db.prepare("INSERT INTO alert_state(alert_key,state,first_seen,acknowledged_by,acknowledged_at,closed_at,updated_at) VALUES (?1,'alert',?2,?3,?4,?5,?2)")
    .bind(key, stamp(i), i === 0 ? "owner" : null, i === 0 ? stamp(i) : null, i === 0 ? null : stamp(i))));
  // One untouched row never counts, whatever its age.
  await h.db.prepare("INSERT INTO alert_state(alert_key,state,first_seen,updated_at) VALUES ('digest:never-touched','warn','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')").run();
  expect(Number(await h.db.prepare("SELECT COUNT(*) AS n FROM alert_state WHERE acknowledged_at IS NOT NULL OR closed_at IS NOT NULL").first("n"))).toBe(501);
  return keys;
}
type Page = { rows: Array<{ alert_key: string; acknowledged_at: string | null; closed_at: string | null; updated_at: string }>; next_cursor: string | null };
const readPage = async (limit: number, cursor: string | null) => {
  const response = await h.admin(`/admin/alerts/state?limit=${limit}${cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor)}`, employee);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
};
/** What a cron tick does to a state it sees again: MultiNotifier.process keeps the acknowledge and close and writes a new updated_at. */
const cronTick = (key: string) => new MultiNotifier(h.db, { telegram: { enabled: false, chat_ids: [] }, routing: {}, digest: { enabled: false, time: "09:00" } }, null)
  .process({ key, rule: key.split(":")[0]!, brand: key.split(":")[1]!, level: "alert", metric: "tick" }, new Date().toISOString());

it("state pages with a cursor: 501 stored states come back in full, the oldest acknowledge and close included", async () => {
  const keys = await seed501();
  const seen: Page["rows"] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const body: Page = await readPage(200, cursor);
    sizes.push(body.rows.length);
    seen.push(...body.rows);
    cursor = body.next_cursor;
    if (cursor === null) break;
  }
  expect(sizes).toEqual([200, 200, 101]);
  const names = seen.map(row => row.alert_key);
  expect(names).toHaveLength(501);
  expect(new Set(names).size).toBe(501);
  // The pages follow alert_key, which no update moves.
  expect(names).toEqual([...names].sort());
  // The oldest acknowledge and the oldest close are both in the list, with their marks.
  expect(seen.find(row => row.alert_key === keys[0])).toMatchObject({ acknowledged_at: expect.any(String), closed_at: null });
  expect(seen.find(row => row.alert_key === keys[1])).toMatchObject({ acknowledged_at: null, closed_at: expect.any(String) });
  expect(names).not.toContain("digest:never-touched");
  // The default page (200) and the cap (500) are bounded.
  expect((await readPage(200, null)).rows).toHaveLength(200);
  expect((await (await h.admin("/admin/alerts/state", employee)).json() as Page).rows).toHaveLength(200);
  expect((await readPage(500, null)).next_cursor).not.toBeNull();
  for (const bad of ["limit=0", "limit=501", "limit=x", "cursor=", "cursor=" + "k".repeat(201)]) expect((await h.admin("/admin/alerts/state?" + bad, employee)).status).toBe(422);
});

it("state read keeps every acknowledge and close when cron rewrites updated_at on rows that are not read yet", async () => {
  const keys = await seed501();
  const first = await readPage(200, null);
  expect(first.rows).toHaveLength(200);
  // Between the pages a cron tick runs MultiNotifier.process on unread rows: the oldest acknowledge (keys[0]), the oldest close (keys[1]),
  // and the last row in key order. Each keeps its mark and gets a new updated_at that is newer than every row already read.
  const unread = [keys[0]!, keys[1]!, keys.slice().sort().at(-1)!];
  expect(first.rows.map(row => row.alert_key)).not.toEqual(expect.arrayContaining(unread));
  const before = new Map((await h.db.prepare("SELECT alert_key,updated_at FROM alert_state").all<{ alert_key: string; updated_at: string }>()).results.map(row => [row.alert_key, row.updated_at]));
  for (const key of unread) await cronTick(key);
  for (const key of unread) {
    const row = await h.db.prepare("SELECT updated_at,acknowledged_at,closed_at FROM alert_state WHERE alert_key=?1").bind(key).first<{ updated_at: string; acknowledged_at: string | null; closed_at: string | null }>();
    expect(row!.updated_at > before.get(key)!, "cron moved updated_at").toBe(true);
    expect(row!.acknowledged_at !== null || row!.closed_at !== null, "the mark survives the tick").toBe(true);
  }
  // Read on from the cursor of the first page.
  const rows = [...first.rows];
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const body: Page = await readPage(200, cursor);
    rows.push(...body.rows);
    cursor = body.next_cursor;
  }
  expect(rows).toHaveLength(501);
  expect(new Set(rows.map(row => row.alert_key)).size).toBe(501);
  for (const key of unread) expect(rows.some(row => row.alert_key === key), key).toBe(true);
  expect(rows.find(row => row.alert_key === keys[0])!.acknowledged_at).not.toBeNull();
  expect(rows.find(row => row.alert_key === keys[1])!.closed_at).not.toBeNull();
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
