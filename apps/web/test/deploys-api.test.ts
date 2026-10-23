import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeployHistoryResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let ownerId: string;
let employeeId: string;

beforeAll(async () => {
  await setupDatabases();
});

const userId = async (cookie: string): Promise<string> => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  ownerId = await userId(owner);
  employeeId = await userId(employee);
  const rev = (id: string, brand: string, n: number) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,?3,'tv-1','fa-1','{}','owner','2026-10-01T00:00:00Z')").bind(id, brand, n);
  const install = (id: string, brand: string, kind: string, status: string, from: string | null, to: string | null, canary: number, startedAt: string, finishedAt: string | null, error: string | null) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO installs (install_id,brand_id,kind,from_revision_id,to_revision_id,is_canary,status,error,started_by,started_role,started_at,finished_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'seed-owner','owner',?9,?10)").bind(id, brand, kind, from, to, canary, status, error, startedAt, finishedAt);
  const audit = (id: number, actor: string, role: string, action: string, entityType: string, entityId: string, at: string) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO audit_log (id,actor_id,actor_role,action,entity_type,entity_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(id, actor, role, action, entityType, entityId, at);
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-a','Brand A','test-account','a.test','live','brand-a_rev_1','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-b','Brand B','test-account','b.test','live','brand-b_rev_1','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
  ]);
  await env.FACTORY.batch([
    rev("brand-a_rev_1", "brand-a", 1),
    rev("brand-b_rev_1", "brand-b", 1),
    rev("brand-b_redeploy_inst-b2", "brand-b", 2),
  ]);
  await env.FACTORY.batch([
    install("inst-a1", "brand-a", "install", "ready", null, "brand-a_rev_1", 0, "2026-10-21T01:00:00.000Z", "2026-10-21T01:04:00.000Z", null),
    // 07:00+07:00 is 00:00Z: earlier than inst-a1 as an instant, later as text.
    install("inst-b1", "brand-b", "install", "ready", null, "brand-b_rev_1", 1, "2026-10-21T07:00:00+07:00", "2026-10-21T07:05:00+07:00", null),
    // 23:30-05:00 on the 20th is 04:30Z on the 21st: the newest instant, but the smallest text.
    install("inst-b2", "brand-b", "upgrade", "failed", "brand-b_rev_1", "brand-b_redeploy_inst-b2", 0, "2026-10-20T23:30:00-05:00", null, "smoke check failed"),
    install("inst-a2", "brand-a", "rollback", "ready", null, "brand-a_rev_1", 0, "2026-10-19T10:00:00.000Z", "2026-10-19T10:02:00.000Z", null),
  ]);
  await env.FACTORY.batch([
    audit(101, ownerId, "owner", "brand.profile.update", "brand", "brand-a", "2026-10-21T03:00:00.000Z"),
    audit(102, ownerId, "owner", "install.start", "brand", "brand-a", "2026-10-21T01:00:00.000Z"),
    audit(103, ownerId, "owner", "redeploy.start", "brand", "brand-b", "2026-10-21T04:30:00.000Z"),
    audit(104, employeeId, "employee", "brand.create", "brand", "brand-b", "2026-10-20T12:00:00.000Z"),
    audit(105, employeeId, "employee", "checklist.attest", "brand", "brand-a", "2026-10-18T09:00:00.000Z"),
    audit(106, ownerId, "owner", "brand.create", "template", "tpl-1", "2026-10-21T06:00:00.000Z"),
  ]);
});

const coreEntry = (id: number, action: string, brand: string, actor = "core-owner", at = "2026-10-21T05:00:00.000Z") =>
  ({ id, actor_id: actor, actor_role: "owner", action, target: { type: "brand", id: brand }, old: null, new: null, at });

/** A CORE binding that answers listAudit with fixed entries and records each request URL. */
function coreEnv(entries: unknown[], seen: URL[] = []) {
  const core = { fetch: async (request: Request) => {
    seen.push(new URL(request.url));
    return Response.json({ entries, next_cursor: null });
  } } as unknown as Fetcher;
  return makeEnv({ MOCK_CORE: undefined, CORE: core });
}

const deploys = async (path: string, cookie: string, testEnv = makeEnv()) => {
  const response = await call(path, { cookie, env: testEnv });
  expect(response.status).toBe(200);
  return DeployHistoryResponse.parse(await response.json());
};
const ids = (body: DeployHistoryResponse) => body.events.map((e) => e.event_id);

describe("GET /api/deploys", () => {
  it("refuses a request with no session", async () => {
    expect((await call("/api/deploys")).status).toBe(401);
  });

  it("merges install rows and audit rows newest first", async () => {
    const body = await deploys("/api/deploys", owner);
    expect(ids(body)).toEqual(["inst-b2", "audit-101", "inst-a1", "inst-b1", "audit-104", "inst-a2", "audit-105"]);
    expect(body.unavailable).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.events.find((e) => e.event_id === "inst-b2")).toMatchObject({
      source: "install", operation: "redeploy", action: null, status: "failed", error: "smoke check failed", from_revision_id: "brand-b_rev_1",
    });
    expect(body.events.find((e) => e.event_id === "inst-a2")).toMatchObject({ operation: "rollback" });
    expect(body.events.find((e) => e.event_id === "inst-b1")).toMatchObject({ operation: "install", is_canary: true });
    expect(body.events.find((e) => e.event_id === "audit-101")).toMatchObject({
      source: "audit", operation: null, action: "brand.profile.update", status: "done", brand_id: "brand-a", started_by: ownerId, started_role: "owner", finished_at: null,
    });
  });

  it("sorts by instant, not by timestamp text", async () => {
    const body = await deploys("/api/deploys?source=install", owner);
    // Text order would be inst-b1 (07:00+07:00), inst-a1, inst-a2, inst-b2 (the 20th).
    expect(ids(body)).toEqual(["inst-b2", "inst-a1", "inst-b1", "inst-a2"]);
    expect(body.events.find((e) => e.event_id === "inst-b1")!.started_at).toBe("2026-10-21T00:00:00.000Z");
    expect(body.events.find((e) => e.event_id === "inst-b2")!.started_at).toBe("2026-10-21T04:30:00.000Z");
    const instants = body.events.map((e) => Date.parse(e.started_at));
    expect(instants).toEqual([...instants].sort((a, b) => b - a));
  });

  it("filters by brand, status, source and operation", async () => {
    expect(ids(await deploys("/api/deploys?brand=brand-a", owner))).toEqual(["audit-101", "inst-a1", "inst-a2", "audit-105"]);
    expect(ids(await deploys("/api/deploys?status=failed", owner))).toEqual(["inst-b2"]);
    expect(ids(await deploys("/api/deploys?status=done", owner))).toEqual(["audit-101", "audit-104", "audit-105"]);
    expect(ids(await deploys("/api/deploys?source=audit", owner))).toEqual(["audit-101", "audit-104", "audit-105"]);
    expect(ids(await deploys("/api/deploys?source=install&brand=brand-b", owner))).toEqual(["inst-b2", "inst-b1"]);
    expect(ids(await deploys("/api/deploys?operation=redeploy", owner))).toEqual(["inst-b2"]);
    expect(ids(await deploys("/api/deploys?operation=upgrade", owner))).toEqual([]);
    expect(ids(await deploys("/api/deploys?operation=rollback", owner))).toEqual(["inst-a2"]);
  });

  it("excludes install.start, redeploy and upgrade audit rows, which the install rows already carry", async () => {
    const seen: URL[] = [];
    const testEnv = coreEnv([
      coreEntry(901, "install.start", "brand-a"),
      coreEntry(902, "install.failed", "brand-a"),
      coreEntry(903, "upgrade.start", "brand-b"),
      coreEntry(904, "redeploy.failed", "brand-b"),
      coreEntry(905, "brand.asset.upload", "brand-a"),
    ], seen);
    const body = await deploys("/api/deploys", owner, testEnv);
    const actions = body.events.map((e) => e.action).filter((a) => a !== null);
    expect(actions).not.toContain("install.start");
    expect(actions).not.toContain("redeploy.start");
    expect(actions.filter((a) => /^(install|redeploy|upgrade)\./.test(a))).toEqual([]);
    expect(ids(body)).toContain("audit-905");
    // 102 and 103 are factory install.start and redeploy.start rows, 106 is a template-entity row, 901 to 904 are core rows.
    expect(ids(body).filter((id) => ["audit-102", "audit-103", "audit-106", "audit-901", "audit-902", "audit-903", "audit-904"].includes(id))).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("keeps an event for a brand with no factory row", async () => {
    const body = await deploys("/api/deploys", owner, coreEnv([coreEntry(900, "brand.create", "brand-ghost")]));
    expect(ids(body)[0]).toBe("audit-900");
    expect(body.events[0]).toMatchObject({ source: "audit", brand_id: "brand-ghost", action: "brand.create", status: "done", started_by: "core-owner", started_at: "2026-10-21T05:00:00.000Z" });
    expect(body.unavailable).toEqual([]);
  });

  it("honours limit and reports has_more", async () => {
    const two = await deploys("/api/deploys?limit=2", owner);
    expect(ids(two)).toEqual(["inst-b2", "audit-101"]);
    expect(two.has_more).toBe(true);
    expect((await deploys("/api/deploys?limit=6", owner)).has_more).toBe(true);
    const all = await deploys("/api/deploys?limit=7", owner);
    expect(all.events).toHaveLength(7);
    expect(all.has_more).toBe(false);
    expect((await deploys("/api/deploys?limit=200", owner)).has_more).toBe(false);
  });

  it("answers 422 for a bad query", async () => {
    for (const query of ["limit=0", "limit=201", "status=sideways", "brand_id=brand-a", "source=core"]) {
      const response = await call(`/api/deploys?${query}`, { cookie: owner });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "invalid" });
    }
  });

  it("returns factory rows with unavailable core_audit when core fails or answers with a bad body", async () => {
    const unreachable = makeEnv({ MOCK_CORE: undefined, CORE: undefined });
    const failing = makeEnv({ MOCK_CORE: undefined, CORE: { fetch: async () => Response.json({ error: "internal" }, { status: 500 }) } as unknown as Fetcher });
    const malformed = makeEnv({ MOCK_CORE: undefined, CORE: { fetch: async () => Response.json({ entries: "nope" }) } as unknown as Fetcher });
    for (const testEnv of [unreachable, failing, malformed]) {
      const body = await deploys("/api/deploys", owner, testEnv);
      expect(body.unavailable).toEqual(["core_audit"]);
      expect(ids(body)).toEqual(["inst-b2", "audit-101", "inst-a1", "inst-b1", "audit-104", "inst-a2", "audit-105"]);
    }
  });

  it("shows an employee every install row but only their own audit rows", async () => {
    const employeeSeen: URL[] = [];
    const asEmployee = await deploys("/api/deploys", employee, coreEnv([], employeeSeen));
    expect(ids(asEmployee)).toEqual(["inst-b2", "inst-a1", "inst-b1", "audit-104", "inst-a2", "audit-105"]);
    expect(asEmployee.events.filter((e) => e.source === "audit").every((e) => e.started_by === employeeId)).toBe(true);
    expect(employeeSeen).toHaveLength(1);
    expect(employeeSeen[0]!.searchParams.get("actor_id")).toBe(employeeId);
    expect(employeeSeen[0]!.searchParams.get("target_type")).toBe("brand");

    const ownerSeen: URL[] = [];
    await deploys("/api/deploys?brand=brand-a&limit=10", owner, coreEnv([], ownerSeen));
    expect(ownerSeen[0]!.searchParams.get("actor_id")).toBeNull();
    expect(ownerSeen[0]!.searchParams.get("target_type")).toBe("brand");
    expect(ownerSeen[0]!.searchParams.get("target_id")).toBe("brand-a");
    expect(ownerSeen[0]!.searchParams.get("limit")).toBe("11");
  });
});
