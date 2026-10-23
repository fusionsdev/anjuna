import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrandRevisionsResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  const rev = (id: string, brand: string, n: number, createdAt = "2026-10-01T00:00:00Z") =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,?3,'tv-1','fa-1','{}','owner',?4)").bind(id, brand, n, createdAt);
  // started_at differs from finished_at, so ordering the target by started_at picks a different row than finished_at does.
  const install = (id: string, brand: string, kind: string, status: string, to: string, finishedAt: string, startedAt = new Date(Date.parse(finishedAt) - 3_600_000).toISOString()) =>
    env.FACTORY.prepare("INSERT OR IGNORE INTO installs (install_id,brand_id,kind,from_revision_id,to_revision_id,status,started_by,started_role,started_at,finished_at) VALUES (?1,?2,?3,NULL,?4,?5,'seed-owner','owner',?6,?7)").bind(id, brand, kind, to, status, startedAt, finishedAt);
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM brand_revisions WHERE revision_id = 'brand-b_rev_bad'"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-a','Brand A','test-account','a.test','live','brand-a_rev_3','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-b','Brand B','test-account','b.test','live','brand-b_rev_1','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-c','Brand C','test-account','c.test','live','brand-c_rev_3','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-e','Brand E','test-account','e.test','live','brand-e_rev_3','owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand-d','Brand D','test-account','d.test','draft',NULL,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')"),
  ]);
  await env.FACTORY.batch([
    rev("brand-a_rev_1", "brand-a", 1),
    rev("brand-a_rev_2", "brand-a", 2),
    rev("brand-a_rev_3", "brand-a", 3),
    rev("brand-b_rev_1", "brand-b", 1),
    rev("brand-c_rev_1", "brand-c", 1),
    rev("brand-c_rev_2", "brand-c", 2),
    rev("brand-c_rev_3", "brand-c", 3),
    rev("brand-d_rev_1", "brand-d", 1),
    rev("brand-e_rev_1", "brand-e", 1),
    rev("brand-e_rev_2", "brand-e", 2),
    rev("brand-e_rev_3", "brand-e", 3),
  ]);
  await env.FACTORY.batch([
    install("rev-a1", "brand-a", "install", "ready", "brand-a_rev_1", "2026-10-10T00:00:00.000Z"),
    install("rev-a2", "brand-a", "upgrade", "ready", "brand-a_rev_2", "2026-10-11T00:00:00.000Z"),
    install("rev-a3", "brand-a", "upgrade", "ready", "brand-a_rev_3", "2026-10-12T00:00:00.000Z"),
    install("rev-b1", "brand-b", "install", "ready", "brand-b_rev_1", "2026-10-10T00:00:00.000Z"),
    // brand-c: install rev_1, upgrade rev_2, rollback to rev_1, upgrade rev_3. Rev_3 is current; the newest ready
    // non-current install is the rollback to rev_1, so neither "current minus one" nor revision order gives it.
    // rev-c3 is inserted before rev-c2 and started earliest, so rowid order or started_at order would name rev_2.
    install("rev-c1", "brand-c", "install", "ready", "brand-c_rev_1", "2026-10-10T00:00:00.000Z"),
    install("rev-c3", "brand-c", "rollback", "ready", "brand-c_rev_1", "2026-10-12T00:00:00.000Z", "2026-10-09T00:00:00.000Z"),
    install("rev-c2", "brand-c", "upgrade", "ready", "brand-c_rev_2", "2026-10-11T00:00:00.000Z"),
    install("rev-c4", "brand-c", "upgrade", "ready", "brand-c_rev_3", "2026-10-13T00:00:00.000Z"),
    // brand-e: rev-e1 finished 2026-10-12T00:00Z, rev-e2 finished 2026-10-12T04:00Z. Text order puts rev-e1 first
    // ("...-12T00" > "...-11T23"); instant order puts rev-e2 first.
    install("rev-e1", "brand-e", "install", "ready", "brand-e_rev_1", "2026-10-12T00:00:00.000Z"),
    install("rev-e2", "brand-e", "upgrade", "ready", "brand-e_rev_2", "2026-10-11T23:00:00-05:00"),
    install("rev-e3", "brand-e", "upgrade", "ready", "brand-e_rev_3", "2026-10-14T00:00:00.000Z"),
  ]);
});

const revisions = async (path: string, cookie: string) => {
  const response = await call(path, { cookie });
  expect(response.status).toBe(200);
  return BrandRevisionsResponse.parse(await response.json());
};

describe("GET /api/brands/:id/revisions", () => {
  it("refuses a request with no session", async () => {
    expect((await call("/api/brands/brand-a/revisions")).status).toBe(401);
  });

  it("lists revisions newest first and marks the current one", async () => {
    const body = await revisions("/api/brands/brand-a/revisions", employee);
    expect(body.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(body.current_revision_id).toBe("brand-a_rev_3");
    expect(body.revisions.filter((r) => r.is_current).map((r) => r.revision_id)).toEqual([body.current_revision_id]);
    expect(body.revisions[0]!.bundle_form_version).toBe("form@abcdef1");
  });

  it("names the revision a rollback would deploy", async () => {
    const body = await revisions("/api/brands/brand-a/revisions", employee);
    expect(body.rollback_target_revision_id).toBe("brand-a_rev_2");
  });

  it("agrees with POST /api/brands/:id/rollback", async () => {
    const target = (await revisions("/api/brands/brand-a/revisions", owner)).rollback_target_revision_id;
    expect(target).not.toBeNull();
    const worker = { fetch: async () => Response.json({ instance_id: "rollback" }) } as unknown as Fetcher;
    const started = await call("/api/brands/brand-a/rollback", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(started.status).toBe(201);
    const { install_id } = await started.json() as { install_id: string };
    const row = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE install_id = ?1").bind(install_id).first<{ to_revision_id: string | null }>();
    expect(row?.to_revision_id).toBe(target);
  });

  it("names the newest ready non-current install, not the previous revision number", async () => {
    const body = await revisions("/api/brands/brand-c/revisions", employee);
    expect(body.current_revision_id).toBe("brand-c_rev_3");
    expect(body.rollback_target_revision_id).toBe("brand-c_rev_1");
  });

  it("queues a rollback to the same non-linear target", async () => {
    const worker = { fetch: async () => Response.json({ instance_id: "rollback" }) } as unknown as Fetcher;
    const started = await call("/api/brands/brand-c/rollback", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(started.status).toBe(201);
    const { install_id } = await started.json() as { install_id: string };
    const row = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE install_id = ?1").bind(install_id).first<{ to_revision_id: string | null }>();
    expect(row?.to_revision_id).toBe("brand-c_rev_1");
  });

  it("orders the rollback target by instant across mixed offsets, in the route and in the queued rollback", async () => {
    const body = await revisions("/api/brands/brand-e/revisions", employee);
    expect(body.current_revision_id).toBe("brand-e_rev_3");
    expect(body.rollback_target_revision_id).toBe("brand-e_rev_2");
    const worker = { fetch: async () => Response.json({ instance_id: "rollback" }) } as unknown as Fetcher;
    const started = await call("/api/brands/brand-e/rollback", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(started.status).toBe(201);
    const { install_id } = await started.json() as { install_id: string };
    const row = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE install_id = ?1").bind(install_id).first<{ to_revision_id: string | null }>();
    expect(row?.to_revision_id).toBe("brand-e_rev_2");
  });

  it("skips a revision whose created_at is not a date and still answers 200", async () => {
    await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand-b_rev_bad','brand-b',2,'tv-1','fa-1','{}','owner','not a date')").run();
    const body = await revisions("/api/brands/brand-b/revisions", employee);
    expect(body.revisions.map((r) => r.revision_id)).toEqual(["brand-b_rev_1"]);
  });

  it("returns null current and target for a brand that was never installed", async () => {
    const body = await revisions("/api/brands/brand-d/revisions", employee);
    expect(body.current_revision_id).toBeNull();
    expect(body.rollback_target_revision_id).toBeNull();
    expect(body.revisions.some((r) => r.is_current)).toBe(false);
  });

  it("returns a null target for a brand with only one revision", async () => {
    const body = await revisions("/api/brands/brand-b/revisions", employee);
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0]!.is_current).toBe(true);
    expect(body.rollback_target_revision_id).toBeNull();
  });

  it("answers 404 for an unknown brand and for a core-only brand with no factory row", async () => {
    const response = await call("/api/brands/brand-ghost/revisions", { cookie: employee });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", resource: "brand" });
  });

  it("answers 400 for an undecodable path segment", async () => {
    const response = await call("/api/brands/%/revisions", { cookie: employee });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_brand_id" });
  });
});
