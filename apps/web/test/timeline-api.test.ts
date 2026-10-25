import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimelineResponse } from "../src/shared/timeline";
import { mockCoreFetch } from "../src/server/mock-core";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let ownerId: string;
let employeeId: string;

beforeAll(async () => {
  await setupDatabases();
});

const userId = async (cookie: string): Promise<string> => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

// brand-f has a factory row and is unknown to the mock core. brand-a is known to the mock core only (the unmanaged case).
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  ownerId = await userId(owner);
  employeeId = await userId(employee);
  const rev = (id: string, n: number, tv: string, fa: string) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,'brand-f',?2,?3,?4,'{}','owner','2026-10-01T00:00:00Z')").bind(id, n, tv, fa);
  const install = (id: string, kind: string, from: string | null, to: string, startedAt: string) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO installs (install_id,brand_id,kind,from_revision_id,to_revision_id,is_canary,status,error,started_by,started_role,started_at,finished_at) VALUES (?1,'brand-f',?2,?3,?4,0,'ready',NULL,'seed-owner','owner',?5,NULL)").bind(id, kind, from, to, startedAt);
  const audit = (id: number, actor: string, role: string, action: string, entityType: string, entityId: string, at: string) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO audit_log (id,actor_id,actor_role,action,entity_type,entity_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(id, actor, role, action, entityType, entityId, at);
  const adsEvent = (id: string, brand: string, type: string, at: string, note: string, by: string, role: string) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO ads_account_events (event_id,brand_id,type,occurred_at,note,created_by,created_role,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'2026-10-21T06:00:00.000Z')").bind(id, brand, type, at, note, by, role);
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM ads_account_events"),
    env.FACTORY.prepare("DELETE FROM installs WHERE brand_id = 'brand-f'"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-2','tpl-1',2,'sha-2','templates/tv-2','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest-1','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-2','abcdef2','forms/fa-2','manifest-2','2026-01','form@abcdef2','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-f','Brand F','test-account','f.test','live','brand-f_rev_2','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
  ]);
  await env.FACTORY.batch([rev("brand-f_rev_1", 1, "tv-1", "fa-1"), rev("brand-f_rev_2", 2, "tv-2", "fa-2")]);
  await env.FACTORY.batch([
    install("inst-f1", "install", null, "brand-f_rev_1", "2026-10-21T01:00:00.000Z"),
    // 07:00+07:00 is 00:00Z: the same instant as ads-ev-3, later than it as text.
    install("inst-f-off", "upgrade", "brand-f_rev_1", "brand-f_rev_2", "2026-10-21T07:00:00+07:00"),
  ]);
  await env.FACTORY.batch([
    audit(201, ownerId, "owner", "brand.profile.update", "brand", "brand-f", "2026-10-21T03:00:00.000Z"),
    audit(202, employeeId, "employee", "brand.create", "brand", "brand-f", "2026-10-20T19:00:00+07:00"),
    audit(203, ownerId, "owner", "brand.create", "template", "tpl-1", "2026-10-21T06:00:00.000Z"),
    adsEvent("ev-1", "brand-f", "ad_disapproved", "2026-10-21T05:30:00.000Z", "Ad 12 rejected", ownerId, "owner"),
    adsEvent("ev-2", "brand-f", "policy_warning", "2026-10-18T09:00:00.000Z", "", employeeId, "employee"),
    adsEvent("ev-3", "brand-f", "other", "2026-10-21T07:00:00+07:00", "Manual check", ownerId, "owner"),
    adsEvent("ev-other-brand", "brand-b", "ad_disapproved", "2026-10-21T05:45:00.000Z", "", ownerId, "owner"),
  ]);
});

const coreEntry = (id: number, action: string, brand: string, actor: string, at: string) =>
  ({ id, actor_id: actor, actor_role: "owner", action, target: { type: "brand", id: brand }, old: null, new: null, at });

const coreRows = () => [
  coreEntry(301, "brand.update", "brand-f", "core-owner", "2026-10-21T04:00:00.000Z"),
  coreEntry(302, "brand.pause", "brand-f", "core-owner", "2026-10-21T02:00:00.000Z"),
  coreEntry(303, "install.start", "brand-f", "core-owner", "2026-10-21T02:30:00.000Z"),
  coreEntry(304, "brand.update", "brand-f", employeeId, "2026-10-20T11:00:00.000Z"),
];

/** A CORE binding that answers listAudit with fixed entries, records each request URL and sends every other endpoint to the mock core. */
function coreEnv(entries: unknown[] = coreRows(), seen: URL[] = []) {
  const core = { fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/admin/audit") return mockCoreFetch(request);
    seen.push(url);
    return Response.json({ entries, next_cursor: null });
  } } as unknown as Fetcher;
  return makeEnv({ MOCK_CORE: undefined, CORE: core });
}

const timeline = async (brand: string, query: string, cookie: string, testEnv = coreEnv()) => {
  const response = await call(`/api/brands/${brand}/timeline${query}`, { cookie, env: testEnv });
  expect(response.status).toBe(200);
  return TimelineResponse.parse(await response.json());
};
const ids = (body: TimelineResponse) => body.items.map((i) => i.item_id);

const EVERYTHING = [
  "ads-ev-1", "core-audit-301", "audit-201", "core-audit-302", "inst-f1", "inst-f-off", "ads-ev-3", "audit-202", "core-audit-304", "ads-ev-2",
];

describe("GET /api/brands/:id/timeline", () => {
  it("refuses a request with no session", async () => {
    expect((await call("/api/brands/brand-f/timeline")).status).toBe(401);
  });

  it("an owner gets every source merged newest first by instant", async () => {
    const body = await timeline("brand-f", "", owner);
    // inst-f-off (07:00+07:00) and ads-ev-3 are the same instant, so the larger item_id comes first.
    expect(ids(body)).toEqual(EVERYTHING);
    expect(body).toMatchObject({ brand_id: "brand-f", has_more: false, unavailable: [], actor_scope: "all" });
    expect(body.items.find((i) => i.item_id === "inst-f-off")!.at).toBe("2026-10-21T00:00:00.000Z");
    expect(body.items.find((i) => i.item_id === "ads-ev-1")).toMatchObject({
      kind: "ads_event", at: "2026-10-21T05:30:00.000Z", event: { type: "ad_disapproved", note: "Ad 12 rejected", brand_id: "brand-f" },
    });
    const categories = Object.fromEntries(body.items.flatMap((i) => (i.kind === "change" ? [[i.item_id, i.category]] : [])));
    expect(categories).toEqual({
      "core-audit-301": "config", "core-audit-302": "pause_resume", "audit-201": "factory_edit", "inst-f1": "deploy",
      "inst-f-off": "deploy", "audit-202": "factory_edit", "core-audit-304": "config",
    });
  });

  it("install rows carry from and to revision refs with template and form version", async () => {
    const body = await timeline("brand-f", "?types=deploy", owner);
    expect(ids(body)).toEqual(["inst-f1", "inst-f-off"]);
    const [first, upgrade] = body.items;
    expect(first).toMatchObject({
      kind: "change",
      from_revision: null,
      to_revision: { revision: 1, template_version_id: "tv-1", bundle_form_version: "form@abcdef1" },
    });
    expect(upgrade).toMatchObject({
      kind: "change",
      from_revision: { revision: 1, template_version_id: "tv-1", bundle_form_version: "form@abcdef1" },
      to_revision: { revision: 2, template_version_id: "tv-2", bundle_form_version: "form@abcdef2" },
    });
  });

  it("types=ad_disapproved returns only those events and does not call core listAudit", async () => {
    const seen: URL[] = [];
    const body = await timeline("brand-f", "?types=ad_disapproved", owner, coreEnv(coreRows(), seen));
    expect(ids(body)).toEqual(["ads-ev-1"]);
    expect(seen).toHaveLength(0);
  });

  it("types=config asks core and keeps only brand.update rows", async () => {
    const seen: URL[] = [];
    const body = await timeline("brand-f", "?types=config", owner, coreEnv(coreRows(), seen));
    expect(ids(body)).toEqual(["core-audit-301", "core-audit-304"]);
    expect(seen).toHaveLength(1);
  });

  it("types=factory_edit,policy_warning merges just those two sources", async () => {
    const seen: URL[] = [];
    const body = await timeline("brand-f", "?types=factory_edit,policy_warning", owner, coreEnv(coreRows(), seen));
    expect(ids(body)).toEqual(["audit-201", "audit-202", "ads-ev-2"]);
    expect(seen).toHaveLength(0);
  });

  it("from/to narrow every source by instant", async () => {
    // The +07:00 row is 00:00Z: inside to=00:00:00.000Z by instant, outside it by text.
    const early = await timeline("brand-f", "?from=2026-10-20T00:00:00.000Z&to=2026-10-21T00:00:00.000Z", owner);
    expect(ids(early)).toEqual(["inst-f-off", "ads-ev-3", "audit-202", "core-audit-304"]);
    // ...and inside from=00:00:00.000Z.
    const late = await timeline("brand-f", "?from=2026-10-21T00:00:00.000Z", owner);
    expect(ids(late)).toEqual(EVERYTHING.slice(0, 7));
    const middle = await timeline("brand-f", "?from=2026-10-21T01:00:00.000Z&to=2026-10-21T04:00:00.000Z", owner);
    expect(ids(middle)).toEqual(["core-audit-301", "audit-201", "core-audit-302", "inst-f1"]);
  });

  it("keeps +07:00 factory audit and Ads event rows at a range bound by instant", async () => {
    // audit-202 (19:00+07:00) and ads-ev-3 (07:00+07:00) equal their bound as instants and sort after it as text.
    const auditBound = "2026-10-20T12:00:00.000Z";
    const audit = await timeline("brand-f", `?types=factory_edit&from=${auditBound}&to=${auditBound}`, owner);
    expect(ids(audit)).toEqual(["audit-202"]);
    const adsBound = "2026-10-21T00:00:00.000Z";
    const ads = await timeline("brand-f", `?types=other&from=${adsBound}&to=${adsBound}`, owner);
    expect(ids(ads)).toEqual(["ads-ev-3"]);
  });

  it("sets has_more when the merge cuts rows but no single source exceeds limit", async () => {
    const body = await timeline("brand-f", "?types=deploy,factory_edit&limit=3", owner);
    expect(ids(body)).toEqual(["audit-201", "inst-f1", "inst-f-off"]);
    expect(body.has_more).toBe(true);
    const exact = await timeline("brand-f", "?types=deploy,factory_edit&limit=4", owner);
    expect(exact.items).toHaveLength(4);
    expect(exact.has_more).toBe(false);
  });

  it("limit=2 cuts to 2 and sets has_more", async () => {
    const two = await timeline("brand-f", "?limit=2", owner);
    expect(ids(two)).toEqual(["ads-ev-1", "core-audit-301"]);
    expect(two.has_more).toBe(true);
    const all = await timeline("brand-f", "?limit=10", owner);
    expect(all.items).toHaveLength(10);
    expect(all.has_more).toBe(false);
  });

  it("sets has_more when core reports a next_cursor", async () => {
    const core = { fetch: async (request: Request) => (
      new URL(request.url).pathname === "/admin/audit"
        ? Response.json({ entries: [], next_cursor: "next" })
        : mockCoreFetch(request)
    ) } as unknown as Fetcher;
    const body = await timeline("brand-f", "?types=config", owner, makeEnv({ MOCK_CORE: undefined, CORE: core }));
    expect(body.has_more).toBe(true);
  });

  it("core audit unavailable answers 200 with unavailable core_audit", async () => {
    const failing = makeEnv({ MOCK_CORE: undefined, CORE: { fetch: async () => Response.json({ error: "internal" }, { status: 500 }) } as unknown as Fetcher });
    const body = await timeline("brand-f", "", owner, failing);
    expect(body.unavailable).toEqual(["core_audit"]);
    expect(ids(body)).toEqual(["ads-ev-1", "audit-201", "inst-f1", "inst-f-off", "ads-ev-3", "audit-202", "ads-ev-2"]);
  });

  it("an employee sees all installs and events but only own audit rows, actor_scope own", async () => {
    const seen: URL[] = [];
    const body = await timeline("brand-f", "", employee, coreEnv(coreRows(), seen));
    expect(body.actor_scope).toBe("own");
    expect(ids(body)).toEqual(["ads-ev-1", "inst-f1", "inst-f-off", "ads-ev-3", "audit-202", "core-audit-304", "ads-ev-2"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.searchParams.get("actor_id")).toBe(employeeId);
    const ownerSeen: URL[] = [];
    await timeline("brand-f", "", owner, coreEnv(coreRows(), ownerSeen));
    expect(ownerSeen[0]!.searchParams.get("actor_id")).toBeNull();
  });

  it("a core-only brand gets its core rows and no install rows", async () => {
    const entries = [coreEntry(401, "brand.pause", "brand-a", "core-owner", "2026-10-21T04:00:00.000Z"), coreEntry(402, "brand.update", "brand-f", "core-owner", "2026-10-21T05:00:00.000Z")];
    const body = await timeline("brand-a", "", owner, coreEnv(entries));
    expect(ids(body)).toEqual(["core-audit-401"]);
    expect(body.items[0]).toMatchObject({ kind: "change", category: "pause_resume", from_revision: null, to_revision: null });
  });

  it("an unknown brand gives 404", async () => {
    const response = await call("/api/brands/no-such-brand/timeline", { cookie: owner });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", resource: "brand" });
  });

  it("answers 502 when core fails during the brand check", async () => {
    const failing = makeEnv({ MOCK_CORE: undefined, CORE: { fetch: async () => new Response("down", { status: 500 }) } as unknown as Fetcher });
    expect((await call("/api/brands/no-such-brand/timeline", { cookie: owner, env: failing })).status).toBe(502);
  });

  it("422 for from after to, types=bogus and limit=0, 400 for a malformed brand id", async () => {
    for (const query of ["?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z", "?types=bogus", "?limit=0", "?limit=201", "?extra=1"]) {
      const response = await call(`/api/brands/brand-f/timeline${query}`, { cookie: owner });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "invalid" });
    }
    expect((await call("/api/brands/%E0%A4%A/timeline", { cookie: owner })).status).toBe(400);
  });

  it("answers 405 to a method other than GET", async () => {
    const response = await call("/api/brands/brand-f/timeline", { method: "POST", cookie: owner, body: {} });
    expect(response.status).toBe(405);
  });
});
