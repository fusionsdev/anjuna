import { env } from "cloudflare:workers";
import { LatestUpgradeResponse, LifecycleBrandSummary, upgradeInstallId, type UpgradeAllCommand } from "@anjuna/contracts";
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
const redeployWith = (cookie: string, brandId: string, body: unknown, over: Parameters<typeof makeEnv>[0] = {}) =>
  call(`/api/brands/${brandId}/redeploy`, { cookie, method: "POST", body, env: makeEnv({ FACTORY_WORKER: factory, ...over }) });

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
    // A newer registered release, then newer rows the tenant cannot use: another payload version, none, and no bundle id (the table allows only form@... or NULL).
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-2','abcdef2','forms/fa-2','manifest','2026-01','form@abcdef2','2026-10-05T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-other-payload','abcdef3','forms/fa-other-payload','manifest','2025-12','form@abcdef3','2026-10-06T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-no-payload','abcdef4','forms/fa-no-payload','manifest',NULL,'form@abcdef4','2026-10-06T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-no-bundle','abcdef5','forms/fa-no-bundle','manifest','2026-01',NULL,'2026-10-06T00:00:00Z')"),
  ]);
});

/** A brand that finished its first install: live on revision 1 with a deployed Worker version. */
async function liveBrand(status = "live", artifact = "fa-1"): Promise<{ brandId: string; revisionId: string }> {
  const brandId = `redeploy-${++sequence}`;
  const revisionId = `${brandId}-rev-1`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?1,?1,'test-account',?2,'Quick Loan',?3,?4,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").bind(brandId, `${brandId}.test`, status, revisionId),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?1,?2,1,'tv-1',?3,'{\"keyword_default\":\"Quick Loan\"}','worker-old','owner','2026-10-01T00:00:00Z')").bind(revisionId, brandId, artifact),
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

  it("answers 201 for a brand that core reports as paused: pause lives in core and the factory status stays live", async () => {
    const { brandId } = await liveBrand();
    const core = { fetch: async () => Response.json({ brands: [
      { brand_id: brandId, account: "test-account", hostnames: [`${brandId}.test`], applied_revision_id: `${brandId}-rev-1`, paused: true, bundle_form_version: "form@abcdef1" },
    ] }) } as unknown as Fetcher;
    const coreEnv = makeEnv({ FACTORY_WORKER: factory, CORE_LIFECYCLE: core });
    // The lifecycle list, which the panel reads, carries the factory status: live.
    const list = await call("/api/lifecycle/brands", { cookie: owner, env: coreEnv });
    expect((await list.json() as { brands: Array<{ brand_id: string; status: string }> }).brands.find((brand) => brand.brand_id === brandId)).toMatchObject({ status: "live" });
    const response = await call(`/api/brands/${brandId}/redeploy`, { cookie: owner, method: "POST", body: {}, env: coreEnv });
    expect(response.status).toBe(201);
    expect(dispatches).toHaveLength(1);
    expect(await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id=?").bind(brandId).first()).toEqual({ status: "live" });
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

  describe("redeploy onto a newer registered form", () => {
    const newRevision = (brandId: string) => env.FACTORY.prepare("SELECT revision_id,template_version_id,form_artifact_id,config_json,worker_version_id FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<Record<string, unknown>>();

    it("lets an Owner choose the artifact: revision 2 carries it, everything else is copied, one dispatch", async () => {
      const { brandId, revisionId } = await liveBrand();
      const response = await redeployWith(owner, brandId, { form_artifact_id: "fa-2" });
      expect(response.status).toBe(201);
      const { install_id } = await response.json() as { install_id: string };
      const next = await newRevision(brandId);
      expect(next).toMatchObject({ template_version_id: "tv-1", form_artifact_id: "fa-2", config_json: "{\"keyword_default\":\"Quick Loan\"}", worker_version_id: null });
      expect(await env.FACTORY.prepare("SELECT kind,status,from_revision_id,to_revision_id FROM installs WHERE install_id=?").bind(install_id).first())
        .toEqual({ kind: "upgrade", status: "running", from_revision_id: revisionId, to_revision_id: next!.revision_id });
      expect(dispatches).toEqual([{ path: "/install", body: { install_id, brand_id: brandId, revision_id: next!.revision_id, started_by: expect.any(String), started_role: "owner" } }]);
      // The current revision keeps its form: this is what a rollback returns to.
      expect(await env.FACTORY.prepare("SELECT form_artifact_id FROM brand_revisions WHERE revision_id=?").bind(revisionId).first()).toEqual({ form_artifact_id: "fa-1" });
      expect(await env.FACTORY.prepare("SELECT current_revision_id FROM brands WHERE brand_id=?").bind(brandId).first()).toEqual({ current_revision_id: revisionId });
    });

    it("audits the chosen artifact in redeploy.start", async () => {
      const { brandId, revisionId } = await liveBrand();
      const { install_id } = await (await redeployWith(owner, brandId, { form_artifact_id: "fa-2" })).json() as { install_id: string };
      const row = await env.FACTORY.prepare("SELECT action,after_json FROM audit_log WHERE entity_id=?").bind(install_id).first<{ action: string; after_json: string }>();
      expect(row!.action).toBe("redeploy.start");
      expect(JSON.parse(row!.after_json)).toEqual({ brand_id: brandId, from_revision_id: revisionId, revision_id: `${brandId}_redeploy_${install_id}`, form_artifact_id: "fa-2" });
    });

    it("keeps the current form when the field is absent, even though a newer artifact exists", async () => {
      const { brandId } = await liveBrand();
      expect((await redeploy(owner, brandId)).status).toBe(201);
      expect(await newRevision(brandId)).toMatchObject({ form_artifact_id: "fa-1" });
    });

    it("accepts the artifact the brand already runs, and an older compatible one", async () => {
      const current = await liveBrand("live", "fa-2");
      expect((await redeployWith(owner, current.brandId, { form_artifact_id: "fa-2" })).status).toBe(201);
      expect(await newRevision(current.brandId)).toMatchObject({ form_artifact_id: "fa-2" });
      const older = await liveBrand("live", "fa-2");
      expect((await redeployWith(owner, older.brandId, { form_artifact_id: "fa-1" })).status).toBe(201);
      expect(await newRevision(older.brandId)).toMatchObject({ form_artifact_id: "fa-1" });
    });

    it("answers 422 for an unknown artifact before any revision, install, audit row or dispatch", async () => {
      const { brandId } = await liveBrand();
      const before = await counts(brandId);
      const response = await redeployWith(owner, brandId, { form_artifact_id: "fa-missing" });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "form_artifact_not_found" });
      expect(await counts(brandId)).toEqual(before);
      expect(dispatches).toHaveLength(0);
    });

    it.each([["another payload version", "fa-other-payload"], ["no payload version", "fa-no-payload"], ["no bundle form version", "fa-no-bundle"]])(
      "answers 422 for an artifact with %s, with no side effects",
      async (_name, artifact) => {
        const { brandId } = await liveBrand();
        const before = await counts(brandId);
        const response = await redeployWith(owner, brandId, { form_artifact_id: artifact });
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: "form_artifact_incompatible" });
        expect(await counts(brandId)).toEqual(before);
        expect(dispatches).toHaveLength(0);
      },
    );

    it("takes the payload version from the tenant configuration, not from a constant", async () => {
      const { brandId } = await liveBrand();
      const response = await redeployWith(owner, brandId, { form_artifact_id: "fa-2" }, { DEFAULT_PAYLOAD_VERSION: "2026-02" });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "form_artifact_incompatible" });
      expect(dispatches).toHaveLength(0);
    });

    it("answers 503 when the tenant defaults are missing, without side effects", async () => {
      const { brandId } = await liveBrand();
      const before = await counts(brandId);
      const response = await redeployWith(owner, brandId, { form_artifact_id: "fa-2" }, { DEFAULT_PAYLOAD_VERSION: undefined });
      expect(response.status).toBe(503);
      expect(await counts(brandId)).toEqual(before);
      expect(dispatches).toHaveLength(0);
    });

    it.each([[{ form_artifact_id: 7 }], [{ form_artifact_id: "" }], [{ form_artifact_id: "fa-2", template_version_id: "tv-9" }]])("answers 422 for a malformed body %j", async (body) => {
      const { brandId } = await liveBrand();
      const before = await counts(brandId);
      expect((await redeployWith(owner, brandId, body)).status).toBe(422);
      expect(await counts(brandId)).toEqual(before);
      expect(dispatches).toHaveLength(0);
    });

    it("refuses an Employee before reading the artifact", async () => {
      const { brandId } = await liveBrand();
      const before = await counts(brandId);
      const response = await redeployWith(employee, brandId, { form_artifact_id: "fa-2" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
      expect(await counts(brandId)).toEqual(before);
      expect(dispatches).toHaveLength(0);
    });

    it("still answers 404 and 409 for the brand first", async () => {
      expect((await redeployWith(owner, "no-such-brand", { form_artifact_id: "fa-2" })).status).toBe(404);
      const draft = await liveBrand("draft");
      expect((await redeployWith(owner, draft.brandId, { form_artifact_id: "fa-2" })).status).toBe(409);
      const busy = await liveBrand();
      await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES ('busy-op',?1,'upgrade','running','owner','owner','2026-10-02T00:00:00Z')").bind(busy.brandId).run();
      expect((await redeployWith(owner, busy.brandId, { form_artifact_id: "fa-2" })).status).toBe(409);
      expect(await newRevision(busy.brandId)).toBeNull();
      await env.FACTORY.prepare("DELETE FROM installs WHERE install_id='busy-op'").run();
    });

    it("Rollback after the form change targets the previous revision, which still names the previous artifact", async () => {
      const { brandId, revisionId } = await liveBrand();
      const { install_id } = await (await redeployWith(owner, brandId, { form_artifact_id: "fa-2" })).json() as { install_id: string };
      const next = (await newRevision(brandId))!.revision_id as string;
      // What the Workflow's receipt step does on success.
      await env.FACTORY.batch([
        env.FACTORY.prepare("UPDATE installs SET status='ready', finished_at='2026-10-02T00:01:00Z' WHERE install_id=?").bind(install_id),
        env.FACTORY.prepare("UPDATE brands SET current_revision_id=? WHERE brand_id=?").bind(next, brandId),
      ]);
      dispatches = [];
      const response = await call(`/api/brands/${brandId}/rollback`, { cookie: owner, method: "POST", body: {}, env: testEnv() });
      expect(response.status).toBe(201);
      expect(dispatches).toEqual([{ path: "/rollback", body: expect.objectContaining({ brand_id: brandId, to_revision_id: revisionId }) }]);
      expect(await env.FACTORY.prepare("SELECT form_artifact_id FROM brand_revisions WHERE revision_id=?").bind(revisionId).first()).toEqual({ form_artifact_id: "fa-1" });
    });

    it("a retry of a failed form-changing redeploy dispatches the same revision and keeps the chosen artifact", async () => {
      const { brandId } = await liveBrand();
      workerStatus = 500;
      const failed = await redeployWith(owner, brandId, { form_artifact_id: "fa-2" });
      expect(failed.status).toBe(502);
      const { install_id } = await failed.json() as { install_id: string };
      workerStatus = 200;
      dispatches = [];
      expect((await call(`/api/installs/${install_id}/retry`, { cookie: owner, method: "POST", body: {}, env: testEnv() })).status).toBe(201);
      expect(dispatches).toEqual([{ path: "/install", body: expect.objectContaining({ install_id, revision_id: `${brandId}_redeploy_${install_id}` }) }]);
      expect(await newRevision(brandId)).toMatchObject({ form_artifact_id: "fa-2" });
    });
  });

  describe("newer_form on the lifecycle brand list", () => {
    const listed = async (brandId: string, over: Parameters<typeof makeEnv>[0] = {}) => {
      const response = await call("/api/lifecycle/brands", { cookie: owner, env: makeEnv(over) });
      expect(response.status).toBe(200);
      const row = ((await response.json()) as { brands: unknown[] }).brands.map((brand) => LifecycleBrandSummary.parse(brand)).find((brand) => brand.brand_id === brandId);
      expect(row).toBeDefined();
      return row!;
    };

    it("offers the newest compatible artifact to a brand on an older one", async () => {
      const { brandId } = await liveBrand();
      // fa-other-payload, fa-no-payload and fa-no-bundle are newer but unusable, so fa-2 is the offer.
      expect((await listed(brandId)).newer_form).toEqual({ form_artifact_id: "fa-2", bundle_form_version: "form@abcdef2" });
    });

    it("offers nothing to a brand already on the newest compatible artifact", async () => {
      const { brandId } = await liveBrand("live", "fa-2");
      expect((await listed(brandId)).newer_form).toBeUndefined();
    });

    it("offers nothing when the tenant payload version matches no artifact or is not configured", async () => {
      const { brandId } = await liveBrand();
      expect((await listed(brandId, { DEFAULT_PAYLOAD_VERSION: "2026-02" })).newer_form).toBeUndefined();
      expect((await listed(brandId, { DEFAULT_PAYLOAD_VERSION: undefined })).newer_form).toBeUndefined();
    });

    it("never offers an artifact older than the one the brand runs", async () => {
      const { brandId } = await liveBrand("live", "fa-2");
      await env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-0','abcdef0','forms/fa-0','manifest','2026-01','form@abcdef0','2026-09-01T00:00:00Z')").run();
      expect((await listed(brandId)).newer_form).toBeUndefined();
    });
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
