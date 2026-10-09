import { env } from "cloudflare:workers";
import { LatestUpgradeResponse } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
const command = { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "canary", started_role: "owner" };
// Golden IDs from the factory's SHA-256 command identity, computed independently.
const ids = {
  canary: "upgrade-install-4821f33d87fbe3a926e33d27ce11eb90200c903a3108e86445724af83a4fbe4e",
  ready: "upgrade-install-c13d141f3a9824a0727962834b6b112c09c9dce966053b74539efedfdd4f3def",
  failed: "upgrade-install-82cc1ea38f83da792a9c4e857ae297ac141c889b6be5eb700fe36a13b241ff15",
  rolled: "upgrade-install-10c95474c750a5af1c2b08652ffa67f77a3f39d5e3f508700de510db11533194",
};
beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM installs WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM brand_revisions WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM brands WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM template_versions WHERE template_id='tpl'"),
    env.FACTORY.prepare("DELETE FROM templates WHERE template_id='tpl'"),
    env.FACTORY.prepare("DELETE FROM form_artifacts WHERE form_artifact_id='fa-1'"),
  ]);
  owner = await sessions.owner(); employee = await sessions.employee();
});

async function accepted(actor = "owner", payload = command) {
  await env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES (?1,'owner','upgrade.start','upgrade','command',?2,'2026-10-09T00:00:00Z')")
    .bind(actor, JSON.stringify(payload)).run();
}

async function seed() {
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-1','tpl',1,'sha','template','draft','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,created_at) VALUES ('fa-1','abcdef1','form','sha','2026-10-01T00:00:00Z')"),
  ]);
  for (const brand of ["canary", "ready", "failed", "rolled", "skipped", "waiting"]) {
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES (?1,?1,'test-account',?2,?3,?4,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')")
        .bind(brand, `${brand}.test`, brand === "skipped" ? "paused" : "live", `${brand}-rev`),
      env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,1,'tv-1','fa-1','{}','owner','2026-10-01T00:00:00Z')")
        .bind(`${brand}-rev`, brand),
    ]);
  }
  for (const [brand, status] of [["canary", "running"], ["ready", "ready"], ["failed", "failed"], ["rolled", "rolled_back"]] as const) {
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,is_canary,status,started_by,started_role,started_at,error) VALUES (?1,?2,'upgrade',?3,?4,'owner','owner','2026-10-09T00:00:00Z',?5)")
      .bind(ids[brand], brand, brand === "canary" ? 1 : 0, status, brand === "failed" ? "Smoke check failed" : null).run();
  }
  await accepted();
}

async function latest(cookie = employee) {
  const response = await call("/api/upgrade-all/latest", { cookie });
  expect(response.status).toBe(200);
  return LatestUpgradeResponse.parse(await response.json());
}

describe("latest upgrade-all API", () => {
  it("requires authentication and returns null before an accepted command", async () => {
    expect((await call("/api/upgrade-all/latest")).status).toBe(401);
    expect(await latest()).toEqual({ upgrade: null });
  });

  it("returns each brand's matching install outcome to Owner and Employee", async () => {
    await seed();
    // A newer unrelated operation must not replace this command's outcome.
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES ('unrelated','ready','upgrade','failed','owner','owner','2026-10-10T00:00:00Z')").run();
    for (const cookie of [owner, employee]) {
      const { upgrade } = await latest(cookie);
      expect(upgrade!.outcomes.map((row) => [row.brand_id, row.status])).toEqual([
        ["canary", "running"], ["failed", "failed"], ["ready", "ready"], ["rolled", "rolled_back"], ["skipped", "skipped"], ["waiting", "queued"],
      ]);
      expect(upgrade!.outcomes[0]).toMatchObject({ is_canary: true, install_id: ids.canary });
      expect(upgrade!.outcomes[1]).toMatchObject({ error: "Smoke check failed" });
      expect(upgrade!.outcomes[4]).toMatchObject({ install_id: null, error: "No install recorded for this command" });
    }
  });

  it("follows install retries to the latest attempt for the command row", async () => {
    await seed();
    const retry = (id: string, of: string, status: string) => env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES (?1,'failed','upgrade',?2,'owner','owner','2026-10-09T01:00:00Z')").bind(id, status),
      env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES ('owner','owner','install.start','install',?1,?2,'2026-10-09T01:00:00Z')")
        .bind(id, JSON.stringify({ brand_id: "failed", retry_of: of, kind: "upgrade" })),
    ]);
    await retry("ins_retry1", ids.failed, "failed");
    await retry("ins_retry2", "ins_retry1", "ready");
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "failed")).toMatchObject({ install_id: "ins_retry2", retry_of: ids.failed, status: "ready", error: null });
    expect(upgrade!.outcomes.find((row) => row.brand_id === "ready")).toMatchObject({ install_id: ids.ready, retry_of: null });
  });

  it.each(["failed", "rolled_back"])("marks unstarted source brands skipped when canary is %s", async (status) => {
    await seed();
    await env.FACTORY.prepare("UPDATE installs SET status=?1 WHERE install_id=?2").bind(status, ids.canary).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "canary")).toMatchObject({ status, is_canary: true });
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "skipped", error: "Canary stopped; no install recorded" });
  });

  it.each([
    ["different actor", "other-owner", command],
    ["different target", "owner", { ...command, to_template_version_id: "tv-3" }],
    ["different canary", "owner", { ...command, canary_brand_id: "waiting" }],
  ])("selects the latest accepted command and excludes rows from a %s", async (_, actor, payload) => {
    await seed();
    await accepted(actor as string, payload as typeof command);
    const { upgrade } = await latest();
    expect(upgrade!.command.started_by).toBe(actor);
    expect(upgrade!.outcomes.every((row) => row.install_id === null)).toBe(true);
  });
});

describe("core-list errors", () => {
  it.each(["missing binding", "transport", "http", "json", "schema"])("reports %s as a visible partial-list error", async (failure) => {
    const core = failure === "missing binding" ? undefined : { fetch: async () => {
      if (failure === "transport") throw new Error("private upstream detail");
      if (failure === "http") return new Response("unavailable", { status: 503 });
      if (failure === "json") return new Response("not json");
      return Response.json({ brands: [{}] });
    } } as unknown as Fetcher;
    const response = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { brands: unknown[]; core_error: string };
    expect(body.brands).toEqual([]);
    expect(body.core_error).toMatch(/^Core /);
    expect(body.core_error).not.toContain("private upstream detail");
    const detail = await call("/api/lifecycle/brands/core-only", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect(detail.status).toBe(502);
  });

  it("distinguishes a successful empty core list from failure and preserves factory rows", async () => {
    await seed();
    const core = { fetch: async () => Response.json({ brands: [] }) } as unknown as Fetcher;
    const ok = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    const body = await ok.json() as { brands: unknown[]; core_error: string | null };
    expect(body.brands).toHaveLength(6);
    expect(body.core_error).toBeNull();
    const failed = await call("/api/lifecycle/brands", { cookie: employee });
    expect(await failed.json()).toMatchObject({ brands: body.brands, core_error: "Core lifecycle binding is missing" });
  });
});
