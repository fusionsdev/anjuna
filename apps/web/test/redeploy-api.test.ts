import { env } from "cloudflare:workers";
import { LatestUpgradeResponse, upgradeInstallId, type UpgradeAllCommand } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let sequence = 0;
let workerStatus: number;
let dispatches: Array<{ path: string; body: Record<string, unknown> }>;

const factory = { fetch: async (request: Request) => {
  dispatches.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
  return workerStatus === 200 ? Response.json({ ok: true, instance_id: "wf" }) : Response.json({ message: "factory down" }, { status: workerStatus });
} } as unknown as Fetcher;
const testEnv = () => makeEnv({ FACTORY_WORKER: factory });
const redeploy = (cookie: string, brandId: string) => call(`/api/brands/${brandId}/redeploy`, { cookie, method: "POST", body: {}, env: testEnv() });

beforeAll(async () => {
  await setupDatabases();
});

beforeEach(async () => {
  resetState();
  workerStatus = 200;
  dispatches = [];
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

/** A brand that finished its first install: live on revision 1 with a deployed Worker version. */
async function liveBrand(status = "live"): Promise<{ brandId: string; revisionId: string }> {
  const brandId = `redeploy-${++sequence}`;
  const revisionId = `${brandId}-rev-1`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?1,?1,'test-account',?2,'Quick Loan',?3,?4,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").bind(brandId, `${brandId}.test`, status, revisionId),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?1,?2,1,'tv-1','fa-1','{\"keyword_default\":\"Quick Loan\"}','worker-old','owner','2026-10-01T00:00:00Z')").bind(revisionId, brandId),
    env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at,finished_at) VALUES (?1,?2,'install','ready',NULL,?3,'owner','owner','2026-10-01T00:00:00Z','2026-10-01T00:01:00Z')").bind(`${brandId}-first`, brandId, revisionId),
  ]);
  return { brandId, revisionId };
}

const counts = async (brandId: string) => ({
  revisions: (await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id=?").bind(brandId).first<{ n: number }>())!.n,
  installs: (await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=?").bind(brandId).first<{ n: number }>())!.n,
  audit: (await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log WHERE after_json LIKE ?").bind(`%${brandId}%`).first<{ n: number }>())!.n,
});

describe("redeploy a live brand", () => {
  it("lets an Owner redeploy: revision N+1 at the same template and artifact, an upgrade install, one dispatch", async () => {
    const { brandId, revisionId } = await liveBrand();
    const response = await redeploy(owner, brandId);
    expect(response.status).toBe(201);
    const body = await response.json() as { install_id: string; brand_id: string; status: string };
    expect(body).toMatchObject({ brand_id: brandId, status: "running" });
    const next = await env.FACTORY.prepare("SELECT * FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<Record<string, unknown>>();
    expect(next).toMatchObject({ template_version_id: "tv-1", form_artifact_id: "fa-1", config_json: "{\"keyword_default\":\"Quick Loan\"}", worker_version_id: null });
    expect(await env.FACTORY.prepare("SELECT kind,status,from_revision_id,to_revision_id,started_role,is_canary FROM installs WHERE install_id=?").bind(body.install_id).first())
      .toEqual({ kind: "upgrade", status: "running", from_revision_id: revisionId, to_revision_id: next!.revision_id, started_role: "owner", is_canary: 0 });
    expect(dispatches).toEqual([{ path: "/install", body: { install_id: body.install_id, brand_id: brandId, revision_id: next!.revision_id, started_by: expect.any(String), started_role: "owner" } }]);
    // The Workflow, not the route, moves the brand pointer.
    expect(await env.FACTORY.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id=?").bind(brandId).first()).toEqual({ status: "live", current_revision_id: revisionId });
  });

  it("audits redeploy.start under the install ID and not as install.start", async () => {
    const { brandId, revisionId } = await liveBrand();
    const { install_id } = await (await redeploy(owner, brandId)).json() as { install_id: string };
    const rows = await env.FACTORY.prepare("SELECT actor_role,action,entity_type,after_json FROM audit_log WHERE entity_id=?").bind(install_id).all<{ actor_role: string; action: string; entity_type: string; after_json: string }>();
    expect(rows.results.map((row) => [row.actor_role, row.action, row.entity_type])).toEqual([["owner", "redeploy.start", "install"]]);
    expect(JSON.parse(rows.results[0]!.after_json)).toEqual({ brand_id: brandId, from_revision_id: revisionId, revision_id: `${brandId}_redeploy_${install_id}` });
  });

  it("refuses an Employee before any revision, install, audit row or dispatch", async () => {
    const { brandId } = await liveBrand();
    const before = await counts(brandId);
    const response = await redeploy(employee, brandId);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(await counts(brandId)).toEqual(before);
    expect(dispatches).toHaveLength(0);
  });

  it("answers 404 for an unknown brand", async () => {
    expect((await redeploy(owner, "no-such-brand")).status).toBe(404);
  });

  it.each(["draft", "failed", "installing", "paused", "retired"])("answers 409 for a %s brand without side effects", async (status) => {
    const { brandId } = await liveBrand(status);
    const before = await counts(brandId);
    const response = await redeploy(owner, brandId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict", message: "Only live brands can be redeployed" });
    expect(await counts(brandId)).toEqual(before);
    expect(dispatches).toHaveLength(0);
  });

  it("answers 409 for a live brand without a deployed revision", async () => {
    const { brandId } = await liveBrand();
    await env.FACTORY.prepare("UPDATE brands SET current_revision_id=NULL WHERE brand_id=?").bind(brandId).run();
    expect((await redeploy(owner, brandId)).status).toBe(409);
    expect(dispatches).toHaveLength(0);
  });

  it.each([["install", "queued"], ["install", "running"], ["rollback", "queued"], ["rollback", "running"], ["upgrade", "queued"], ["upgrade", "running"]])(
    "answers 409 while a %s is %s for the brand",
    async (kind, status) => {
      const { brandId } = await liveBrand();
      await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES ('active-op',?1,?2,?3,'owner','owner','2026-10-02T00:00:00Z')")
        .bind(brandId, kind, status).run();
      const before = await counts(brandId);
      const response = await redeploy(owner, brandId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "lifecycle_operation_active", active_install_id: "active-op", active_kind: kind, active_status: status });
      expect(await counts(brandId)).toEqual(before);
      expect(dispatches).toHaveLength(0);
      await env.FACTORY.prepare("DELETE FROM installs WHERE install_id='active-op'").run();
    },
  );

  it("starts one install for concurrent and repeated requests", async () => {
    const { brandId } = await liveBrand();
    const statuses = (await Promise.all([redeploy(owner, brandId), redeploy(owner, brandId), redeploy(owner, brandId)])).map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect((await redeploy(owner, brandId)).status).toBe(409);
    expect(await counts(brandId)).toEqual({ revisions: 2, installs: 2, audit: 1 });
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=? AND kind='upgrade'").bind(brandId).first()).toEqual({ n: 1 });
    expect(dispatches).toHaveLength(1);
  });

  describe("failure and retry", () => {
    it("marks the install failed on a dispatch failure, leaves the brand live, then retries through the retry route as Owner", async () => {
      const { brandId, revisionId } = await liveBrand();
      workerStatus = 500;
      const failed = await redeploy(owner, brandId);
      expect(failed.status).toBe(502);
      const { install_id } = await failed.json() as { install_id: string };
      const target = `${brandId}_redeploy_${install_id}`;
      expect(await env.FACTORY.prepare("SELECT kind,status,to_revision_id FROM installs WHERE install_id=?").bind(install_id).first()).toEqual({ kind: "upgrade", status: "failed", to_revision_id: target });
      expect(await env.FACTORY.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id=?").bind(brandId).first()).toEqual({ status: "live", current_revision_id: revisionId });

      workerStatus = 200;
      dispatches = [];
      const denied = await call(`/api/installs/${install_id}/retry`, { cookie: employee, method: "POST", body: {}, env: testEnv() });
      expect(denied.status).toBe(403);
      expect(dispatches).toHaveLength(0);
      const retried = await call(`/api/installs/${install_id}/retry`, { cookie: owner, method: "POST", body: {}, env: testEnv() });
      expect(retried.status).toBe(201);
      expect(dispatches).toEqual([{ path: "/install", body: { install_id, brand_id: brandId, revision_id: target, started_by: expect.any(String), started_role: "owner" } }]);
      expect(await env.FACTORY.prepare("SELECT kind,status,to_revision_id FROM installs WHERE install_id=?").bind(install_id).first()).toEqual({ kind: "upgrade", status: "running", to_revision_id: target });
      expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id=?").bind(brandId).first()).toEqual({ n: 2 });
    });

    it("accepts a fresh redeploy after the previous one failed, as revision 3", async () => {
      const { brandId } = await liveBrand();
      workerStatus = 500;
      expect((await redeploy(owner, brandId)).status).toBe(502);
      workerStatus = 200;
      expect((await redeploy(owner, brandId)).status).toBe(201);
      expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id=? AND revision=3").bind(brandId).first()).toEqual({ n: 1 });
    });
  });

  describe("upgrade-all outcomes", () => {
    const command: UpgradeAllCommand = { from_template_version_id: "tv-0", to_template_version_id: "tv-1", form_artifact_id: "fa-1", canary_brand_id: "", started_by: "owner", started_role: "owner" };

    it("never counts a redeploy as part of an upgrade-all command", async () => {
      const { brandId } = await liveBrand();
      const accepted = { ...command, canary_brand_id: brandId };
      const upgradeId = await upgradeInstallId(accepted, brandId);
      await env.FACTORY.batch([
        env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,is_canary,status,started_by,started_role,started_at) VALUES (?1,?2,'upgrade',1,'ready','owner','owner','2026-10-09T00:00:00Z')").bind(upgradeId, brandId),
        env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES ('owner','owner','upgrade.start','upgrade','command',?1,?2)")
          .bind(JSON.stringify(accepted), new Date().toISOString()),
      ]);
      const latest = async () => LatestUpgradeResponse.parse(await (await call("/api/upgrade-all/latest", { cookie: owner })).json());
      const before = (await latest()).upgrade!.outcomes.find((row) => row.brand_id === brandId);
      expect(before).toMatchObject({ install_id: upgradeId, status: "ready", retry_of: null });

      workerStatus = 500;
      const failed = await redeploy(owner, brandId);
      const { install_id } = await failed.json() as { install_id: string };
      workerStatus = 200;
      expect((await call(`/api/installs/${install_id}/retry`, { cookie: owner, method: "POST", body: {}, env: testEnv() })).status).toBe(201);
      expect((await redeploy(owner, brandId)).status).toBe(409);

      const after = await latest();
      expect(after.upgrade!.outcomes.filter((row) => row.brand_id === brandId)).toEqual([before]);
      expect(JSON.stringify(after)).not.toContain(install_id);
    });
  });
});
