import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeFactoryAudit } from "../src/server/audit";
import { AdsAccountEvent } from "../src/shared/timeline";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
// audit_log is append-only, so each test reads only the rows added after its own start.
let auditFloor = 0;

beforeAll(async () => {
  await setupDatabases();
});

const userId = async (cookie: string): Promise<string> => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM ads_account_events"),
    // brand-a and brand-b are known to the mock core; only brand-b has a factory row, so brand-a is the unmanaged case.
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-b','Brand B','test-account','b.test','live',NULL,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
  ]);
  auditFloor = (await env.FACTORY.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM audit_log").first<{ m: number }>())!.m;
});

const post = (brand: string, body: unknown, cookie = owner, testEnv = makeEnv()) =>
  call(`/api/brands/${brand}/ads-events`, { method: "POST", cookie, body, env: testEnv });
const del = (brand: string, eventId: string, cookie = owner) =>
  call(`/api/brands/${brand}/ads-events/${eventId}`, { method: "DELETE", cookie });

const goodBody = () => ({ type: "ad_disapproved", occurred_at: new Date(Date.now() - 3600_000).toISOString(), note: "Ad 12 rejected" });

interface EventRow { event_id: string; brand_id: string; type: string; occurred_at: string; note: string; created_by: string; created_role: string }
const eventRows = async () =>
  (await env.FACTORY.prepare("SELECT * FROM ads_account_events ORDER BY created_at").all<EventRow>()).results;
interface AuditRow { actor_id: string; actor_role: string; action: string; entity_type: string; entity_id: string; before_json: string | null; after_json: string | null }
const adsAuditRows = async () =>
  (await env.FACTORY.prepare("SELECT * FROM audit_log WHERE action LIKE 'ads_event.%' AND id > ?1 ORDER BY id").bind(auditFloor).all<AuditRow>()).results;

describe("POST /api/brands/:id/ads-events", () => {
  it("an employee creates an event: 201, one row, one ads_event.create audit row with the event in after_json", async () => {
    const employeeId = await userId(employee);
    const response = await post("brand-b", goodBody(), employee);
    expect(response.status).toBe(201);
    const { event } = (await response.json()) as { event: unknown };
    const stored = AdsAccountEvent.parse(event);
    expect(stored).toMatchObject({ brand_id: "brand-b", type: "ad_disapproved", note: "Ad 12 rejected", created_by: employeeId, created_role: "employee" });
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: stored.event_id, brand_id: "brand-b", created_by: employeeId });
    const audit = await adsAuditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: employeeId, actor_role: "employee", action: "ads_event.create", entity_type: "ads_event", entity_id: stored.event_id, before_json: null });
    expect(JSON.parse(audit[0]!.after_json!)).toEqual(stored);
  });

  it("an owner creates an event on a core-only brand", async () => {
    expect((await env.FACTORY.prepare("SELECT 1 FROM brands WHERE brand_id = 'brand-a'").first())).toBeNull();
    const response = await post("brand-a", goodBody());
    expect(response.status).toBe(201);
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect((await adsAuditRows())[0]).toMatchObject({ entity_type: "ads_event", entity_id: rows[0]!.event_id });
    expect(JSON.parse((await adsAuditRows())[0]!.after_json!)).toMatchObject({ brand_id: "brand-a" });
  });

  it("an unknown brand gives 404 not_found brand and writes nothing", async () => {
    const response = await post("no-such-brand", goodBody());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", resource: "brand" });
    expect(await eventRows()).toHaveLength(0);
    expect(await adsAuditRows()).toHaveLength(0);
  });

  it("answers 502 bad_gateway when core fails during the brand check", async () => {
    const core = { fetch: async () => new Response("down", { status: 500 }) } as unknown as Fetcher;
    const response = await post("no-such-brand", goodBody(), owner, makeEnv({ MOCK_CORE: undefined, CORE: core }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "bad_gateway" });
    expect(await eventRows()).toHaveLength(0);
  });

  const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  it.each([
    ["an unknown type", { ...goodBody(), type: "bogus" }, "type"],
    ["a time before 2020", { ...goodBody(), occurred_at: "2019-12-31T23:59:59.000Z" }, "occurred_at"],
    ["a time 10 minutes ahead", { ...goodBody(), occurred_at: minutesFromNow(10) }, "occurred_at"],
    ["a 501-character note after trim", { ...goodBody(), note: `  ${"x".repeat(501)}  ` }, "note"],
    ["an empty note for other", { ...goodBody(), type: "other", note: "   " }, "note"],
  ])("422 for %s", async (_name, body, path) => {
    const response = await post("brand-b", body);
    expect(response.status).toBe(422);
    const json = (await response.json()) as { error: string; request_id: string; issues: { path: string; message: string }[] };
    expect(json.error).toBe("invalid");
    expect(json.request_id).toMatch(/^req_/);
    expect(json.issues.map((i) => i.path)).toContain(path);
    expect(await eventRows()).toHaveLength(0);
    expect(await adsAuditRows()).toHaveLength(0);
  });

  it("422 for a body that is not JSON", async () => {
    const response = await call("/api/brands/brand-b/ads-events", { method: "POST", cookie: owner, headers: { "content-type": "application/json" }, body: undefined });
    expect(response.status).toBe(422);
  });

  it("accepts a 500-character note and a time 4 minutes ahead", async () => {
    const response = await post("brand-b", { ...goodBody(), note: "y".repeat(500), occurred_at: new Date(Date.now() + 4 * 60_000).toISOString() });
    expect(response.status).toBe(201);
  });

  it("the note is stored trimmed", async () => {
    const response = await post("brand-b", { ...goodBody(), note: "  padded note \n" });
    expect(response.status).toBe(201);
    expect((await eventRows())[0]!.note).toBe("padded note");
    expect(JSON.parse((await adsAuditRows())[0]!.after_json!).note).toBe("padded note");
  });

  it("a failed audit insert leaves no event row", async () => {
    await env.FACTORY.exec("CREATE TRIGGER fail_ads_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'ads_event.create' BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      const response = await post("brand-b", goodBody());
      expect(response.status).toBe(500);
      expect(await eventRows()).toHaveLength(0);
    } finally {
      await env.FACTORY.exec("DROP TRIGGER IF EXISTS fail_ads_audit");
    }
  });

  it("400 invalid_brand_id for a malformed brand id", async () => {
    const response = await post("Bad%20Brand", goodBody());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_brand_id" });
  });

  it("refuses a request with no session and answers 405 on other methods", async () => {
    expect((await call("/api/brands/brand-b/ads-events", { method: "POST", body: goodBody() })).status).toBe(401);
    const put = await call("/api/brands/brand-b/ads-events", { method: "PUT", cookie: owner, body: goodBody() });
    expect(put.status).toBe(405);
    expect(await put.json()).toEqual({ error: "method_not_allowed" });
    expect((await call("/api/brands/brand-b/ads-events/abc", { method: "POST", cookie: owner, body: {} })).status).toBe(405);
  });
});

describe("factory audit allowlist", () => {
  it("writeFactoryAudit throws for an action outside FACTORY_AUDIT_PREFIXES and writes nothing", async () => {
    await expect(writeFactoryAudit(env.FACTORY, {
      actor_id: "u1", actor_role: "owner", action: "lead.delete", entity_type: "lead", entity_id: "l1",
    })).rejects.toThrow(/Not a factory audit action: lead\.delete/);
    const row = await env.FACTORY.prepare("SELECT 1 FROM audit_log WHERE action = 'lead.delete' AND id > ?1").bind(auditFloor).first();
    expect(row).toBeNull();
  });
});

describe("DELETE /api/brands/:id/ads-events/:eventId", () => {
  const seed = async (): Promise<AdsAccountEvent> => {
    const { event } = (await (await post("brand-b", goodBody())).json()) as { event: AdsAccountEvent };
    return event;
  };

  it("an employee DELETE answers 403 forbidden_role owner; the row stays; no audit row", async () => {
    const event = await seed();
    const response = await del("brand-b", event.event_id, employee);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(await eventRows()).toHaveLength(1);
    expect((await adsAuditRows()).map((r) => r.action)).toEqual(["ads_event.create"]);
  });

  it("an owner DELETE answers 200 with the event; the row is gone; one ads_event.delete audit row with before_json", async () => {
    const event = await seed();
    const ownerId = await userId(owner);
    const response = await del("brand-b", event.event_id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: event });
    expect(await eventRows()).toHaveLength(0);
    const audit = (await adsAuditRows()).filter((r) => r.action === "ads_event.delete");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: ownerId, actor_role: "owner", entity_type: "ads_event", entity_id: event.event_id, after_json: null });
    expect(JSON.parse(audit[0]!.before_json!)).toEqual(event);
  });

  it("DELETE of an event id that belongs to another brand answers 404 not_found ads_event", async () => {
    const event = await seed();
    const response = await del("brand-a", event.event_id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", resource: "ads_event" });
    expect(await eventRows()).toHaveLength(1);
    expect((await adsAuditRows()).map((r) => r.action)).toEqual(["ads_event.create"]);
  });

  it("DELETE of a missing event answers 404 and 400 for a malformed brand id", async () => {
    expect((await del("brand-b", "missing")).status).toBe(404);
    expect((await del("Bad%20Brand", "missing")).status).toBe(400);
  });

  it("two DELETEs of the same event write exactly one ads_event.delete audit row and the second answers 404", async () => {
    const event = await seed();
    expect((await del("brand-b", event.event_id)).status).toBe(200);
    const second = await del("brand-b", event.event_id);
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "not_found", resource: "ads_event" });
    expect((await adsAuditRows()).filter((r) => r.action === "ads_event.delete")).toHaveLength(1);
  });

  it("two concurrent DELETEs of the same event answer one 200 and one 404 and write one audit row", async () => {
    const event = await seed();
    const statuses = (await Promise.all([del("brand-b", event.event_id), del("brand-b", event.event_id)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 404]);
    expect((await adsAuditRows()).filter((r) => r.action === "ads_event.delete")).toHaveLength(1);
    expect(await eventRows()).toHaveLength(0);
  });

  const insertRaw = (eventId: string, occurredAt: string) => env.FACTORY.prepare(
    "INSERT INTO ads_account_events (event_id,brand_id,type,occurred_at,note,created_by,created_role,created_at) VALUES (?1,'brand-b','other',?2,'raw','u1','owner','2026-10-21T06:00:00.000Z')",
  ).bind(eventId, occurredAt).run();

  it("DELETE of a stored row with a +07:00 occurred_at answers 200 with the normalized time", async () => {
    await insertRaw("ev-offset", "2026-10-21T07:00:00+07:00");
    const response = await del("brand-b", "ev-offset");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: { event_id: "ev-offset", occurred_at: "2026-10-21T00:00:00.000Z" } });
    expect(await eventRows()).toHaveLength(0);
    expect((await adsAuditRows()).filter((r) => r.action === "ads_event.delete")).toMatchObject([{ entity_type: "ads_event", entity_id: "ev-offset" }]);
  });

  it("DELETE of a stored row that fails the schema answers 500 internal, not 404, and keeps the row", async () => {
    await insertRaw("ev-garbled", "not-a-date");
    const response = await del("brand-b", "ev-garbled");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal", request_id: expect.stringMatching(/^req_/) });
    expect(await eventRows()).toHaveLength(1);
    expect(await adsAuditRows()).toHaveLength(0);
  });
});
