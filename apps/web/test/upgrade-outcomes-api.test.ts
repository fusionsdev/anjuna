import { env } from "cloudflare:workers";
import { LatestUpgradeResponse, upgradeInstallId, upgradeRevisionId, type CoreListError, type UpgradeAllCommand } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { latestUpgrade } from "../src/server/upgrade-outcomes";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
const command: UpgradeAllCommand = { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "canary", started_by: "owner", started_role: "owner" };
// Derived from the shared contract identity so this test cannot drift from the web recompute.
const brands = ["canary", "ready", "failed", "rolled"] as const;
let ids: Record<(typeof brands)[number], string>;

beforeAll(async () => {
  await setupDatabases();
  ids = Object.fromEntries(await Promise.all(brands.map(async (brand) => [brand, await upgradeInstallId(command, brand)]))) as Record<(typeof brands)[number], string>;
});

beforeEach(async () => {
  resetState();
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM installs WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM brand_revisions WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM brands WHERE brand_id IN ('canary','ready','failed','rolled','skipped','waiting')"),
    env.FACTORY.prepare("DELETE FROM brand_revisions WHERE revision_id LIKE 'upgrade-revision-%'"),
    env.FACTORY.prepare("DELETE FROM template_versions WHERE template_id='tpl'"),
    env.FACTORY.prepare("DELETE FROM templates WHERE template_id='tpl'"),
    env.FACTORY.prepare("DELETE FROM form_artifacts WHERE form_artifact_id='fa-1'"),
  ]);
  owner = await sessions.owner(); employee = await sessions.employee();
});

// Route tests accept "now" so the 15 minute no-install cap never trips; cap tests pin ACCEPTED_AT and inject a clock.
const ACCEPTED_AT = "2026-10-09T00:00:00Z";
const minutesAfter = (minutes: number) => new Date(Date.parse(ACCEPTED_AT) + minutes * 60_000);

async function accepted(actor = "owner", payload = command, createdAt = new Date().toISOString()) {
  await env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES (?1,'owner','upgrade.start','upgrade','command',?2,?3)")
    .bind(actor, JSON.stringify(payload), createdAt).run();
}

async function seed(acceptedAt?: string) {
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-1','tpl',1,'sha','template','draft','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-2','tpl',2,'sha2','template2','draft','owner','2026-10-01T00:00:00Z')"),
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
  await accepted("owner", command, acceptedAt);
}

// What the workflow's create_revisions step persists for every selected brand before the canary starts.
async function selectBrands(...selected: string[]) {
  for (const brand of selected) {
    await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,2,'tv-2','fa-1','{}','owner','2026-10-09T00:00:00Z')")
      .bind(await upgradeRevisionId(command, brand), brand).run();
  }
}

async function latest(cookie = owner) {
  const response = await call("/api/upgrade-all/latest", { cookie });
  expect(response.status).toBe(200);
  return LatestUpgradeResponse.parse(await response.json());
}

describe("latest upgrade-all API", () => {
  it("requires authentication and returns null before an accepted command", async () => {
    expect((await call("/api/upgrade-all/latest")).status).toBe(401);
    expect(await latest()).toEqual({ upgrade: null });
  });

  it("returns each brand's matching install outcome to Owner", async () => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled", "waiting");
    // A newer unrelated operation must not replace this command's outcome.
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES ('unrelated','ready','upgrade','failed','owner','owner','2026-10-10T00:00:00Z')").run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.map((row) => [row.brand_id, row.status])).toEqual([
      ["canary", "running"], ["failed", "failed"], ["ready", "ready"], ["rolled", "rolled_back"], ["skipped", "skipped"], ["waiting", "queued"],
    ]);
    expect(upgrade!.outcomes[0]).toMatchObject({ is_canary: true, install_id: ids.canary });
    expect(upgrade!.outcomes[1]).toMatchObject({ error: "Smoke check failed" });
    expect(upgrade!.outcomes[4]).toMatchObject({ install_id: null, error: "No install recorded for this command" });
  });

  it("returns 403 to Employee", async () => {
    await seed();
    expect((await call("/api/upgrade-all/latest", { cookie: employee })).status).toBe(403);
  });

  describe("upgrade-all command validation", () => {
    const startRows = async () => (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='upgrade.start'").first<{ n: number }>())!.n;
    const factory = { fetch: async () => Response.json({ instance_id: "wf" }, { status: 201 }) } as unknown as Fetcher;
    const post = (canary: string) => call("/api/upgrade-all", {
      cookie: owner, method: "POST", env: makeEnv({ FACTORY_WORKER: factory }),
      body: { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: canary },
    });

    it.each(["Canary", "has space", "-leading", ""])("rejects canary id %j before dispatch and writes no upgrade.start row", async (canary) => {
      const before = await startRows();
      const response = await post(canary);
      expect(response.status).toBe(422);
      expect(await startRows()).toBe(before);
    });

    it("accepts a canary id that satisfies BrandId and audits upgrade.start", async () => {
      const before = await startRows();
      expect((await post("brand-x")).status).toBe(201);
      expect(await startRows()).toBe(before + 1);
    });

    it("answers 200 with a visible command_error when the persisted command is unreadable", async () => {
      await seed();
      await accepted("owner", { ...command, canary_brand_id: "Canary Brand" });
      const response = await call("/api/upgrade-all/latest", { cookie: owner });
      expect(response.status).toBe(200);
      const body = LatestUpgradeResponse.parse(await response.json());
      expect(body.upgrade).toBeNull();
      expect(body.command_error).toMatchObject({ message: "Latest upgrade command is unreadable" });
      expect(typeof body.command_error!.audit_id).toBe("number");
    });

    it("answers 200 with a command_error when the persisted command is not JSON", async () => {
      await env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES ('owner','owner','upgrade.start','upgrade','command','not json',?1)").bind(new Date().toISOString()).run();
      const response = await call("/api/upgrade-all/latest", { cookie: owner });
      expect(response.status).toBe(200);
      expect(LatestUpgradeResponse.parse(await response.json()).command_error).toBeTruthy();
    });
  });

  describe("15 minute cap on waiting without an install row", () => {
    const outcome = async (minutes: number, brand: string) => {
      const { upgrade } = LatestUpgradeResponse.parse(await latestUpgrade(env.FACTORY, minutesAfter(minutes)));
      return upgrade!.outcomes.find((row) => row.brand_id === brand)!;
    };
    const STOPPED = "No install recorded within 15 minutes; the upgrade workflow stopped or failed";

    it("keeps a selected brand queued under 15 minutes and reads skipped from 15 minutes on", async () => {
      await seed(ACCEPTED_AT);
      await selectBrands("canary", "ready", "failed", "rolled", "waiting");
      await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?1").bind(ids.canary).run();
      expect(await outcome(14.9, "waiting")).toMatchObject({ status: "queued", error: "Waiting for an install record" });
      expect(await outcome(15, "waiting")).toMatchObject({ status: "skipped", install_id: null, error: STOPPED });
      expect(await outcome(60, "waiting")).toMatchObject({ status: "skipped", error: STOPPED });
    });

    it("applies the same cap to the pre-selection fallback and to the canary itself", async () => {
      await seed(ACCEPTED_AT);
      await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?1").bind(ids.canary).run();
      expect(await outcome(14.9, "waiting")).toMatchObject({ status: "queued" });
      expect(await outcome(14.9, "canary")).toMatchObject({ status: "queued" });
      expect(await outcome(15, "waiting")).toMatchObject({ status: "skipped", error: STOPPED });
      expect(await outcome(15, "canary")).toMatchObject({ status: "skipped", install_id: null, error: STOPPED });
    });

    it("keeps the status of a brand that has an install row past 15 minutes", async () => {
      await seed(ACCEPTED_AT);
      await selectBrands("canary", "ready", "failed", "rolled", "waiting");
      expect(await outcome(120, "canary")).toMatchObject({ status: "running", error: null });
      expect(await outcome(120, "ready")).toMatchObject({ status: "ready" });
      expect(await outcome(120, "failed")).toMatchObject({ status: "failed", error: "Smoke check failed" });
    });

    it("keeps its own error when the canary stopped", async () => {
      await seed(ACCEPTED_AT);
      await selectBrands("canary", "ready", "failed", "rolled", "waiting");
      await env.FACTORY.prepare("UPDATE installs SET status='failed' WHERE install_id=?1").bind(ids.canary).run();
      expect(await outcome(5, "waiting")).toMatchObject({ status: "skipped", error: "Canary stopped; no install recorded" });
      expect(await outcome(60, "waiting")).toMatchObject({ status: "skipped", error: "Canary stopped; no install recorded" });
    });
  });

  // The workflow gates the bulk step on the original canary install row only; a retry of a failed
  // canary dispatches one individual install and never resumes the workflow.
  it.each(["running", "ready"])("shows a %s canary retry but keeps selected brands skipped while the original canary stays failed", async (retryStatus) => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled", "waiting");
    await env.FACTORY.prepare("UPDATE installs SET status='failed' WHERE install_id=?1").bind(ids.canary).run();
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,is_canary,status,started_by,started_role,started_at) VALUES ('ins_canary_retry','canary','upgrade',1,?1,'owner','owner','2026-10-09T01:00:00Z')").bind(retryStatus),
      env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES ('owner','owner','install.start','install','ins_canary_retry',?1,'2026-10-09T01:00:00Z')")
        .bind(JSON.stringify({ brand_id: "canary", retry_of: ids.canary, kind: "upgrade" })),
    ]);
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "canary")).toMatchObject({ status: retryStatus, install_id: "ins_canary_retry", retry_of: ids.canary, is_canary: true });
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "skipped", install_id: null, error: "Canary stopped; no install recorded" });
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

  it("keeps the latest accepted outcomes when a newer upgrade submission fails", async () => {
    await seed();
    const previous = await latest();
    await env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES ('owner','owner','upgrade.failed','upgrade','rejected',?1,'2026-10-10T00:00:00Z')")
      .bind(JSON.stringify({ ...command, to_template_version_id: "tv-3", error: "factory_transport_failed" })).run();
    expect(await latest()).toEqual(previous);
  });

  it.each(["failed", "rolled_back"])("marks unstarted source brands skipped when canary is %s", async (status) => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled", "waiting");
    await env.FACTORY.prepare("UPDATE installs SET status=?1 WHERE install_id=?2").bind(status, ids.canary).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "canary")).toMatchObject({ status, is_canary: true });
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "skipped", error: "Canary stopped; no install recorded" });
  });

  it("keeps a selected brand queued after the canary reached ready until its install row exists", async () => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled", "waiting");
    await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?1").bind(ids.canary).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "canary")).toMatchObject({ status: "ready", is_canary: true });
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "queued", install_id: null, error: "Waiting for an install record" });
  });

  it("reads skipped for a live source brand with no revision row once the canary reached ready", async () => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled");
    await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?1").bind(ids.canary).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "skipped", install_id: null, error: "No install recorded for this command" });
  });

  it("reads a selected brand's install row status once the bulk step created it", async () => {
    await seed();
    await selectBrands("canary", "ready", "failed", "rolled", "waiting");
    await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?1").bind(ids.canary).run();
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES (?1,'waiting','upgrade','running','owner','owner','2026-10-09T00:01:00Z')")
      .bind(await upgradeInstallId(command, "waiting")).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "running" });
  });

  it("reads queued before the workflow has persisted any revision while the canary has no install row", async () => {
    await seed();
    await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?1").bind(ids.canary).run();
    const { upgrade } = await latest();
    expect(upgrade!.outcomes.find((row) => row.brand_id === "waiting")).toMatchObject({ status: "queued" });
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
  it.each([
    ["missing binding", "core_binding_missing"],
    ["transport", "core_list_fetch_failed"],
    ["http", "core_list_fetch_failed"],
    ["json", "core_list_response_invalid"],
    ["schema", "core_list_response_invalid"],
  ])("reports %s as a visible partial-list error with a stable code", async (failure, code) => {
    const core = failure === "missing binding" ? undefined : { fetch: async () => {
      if (failure === "transport") throw new Error("private upstream detail");
      if (failure === "http") return new Response("unavailable", { status: 503 });
      if (failure === "json") return new Response("not json");
      return Response.json({ brands: [{}] });
    } } as unknown as Fetcher;
    const response = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { brands: unknown[]; core_error: CoreListError };
    expect(body.brands).toEqual([]);
    expect(body.core_error.code).toBe(code);
    expect(body.core_error.message).not.toContain("private upstream detail");
    const detail = await call("/api/lifecycle/brands/core-only", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect(detail.status).toBe(502);
  });

  it("distinguishes a successful empty core list from failure and preserves factory rows", async () => {
    await seed();
    const core = { fetch: async () => Response.json({ brands: [] }) } as unknown as Fetcher;
    const ok = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    const body = await ok.json() as { brands: unknown[]; core_error: CoreListError | null };
    expect(body.brands).toHaveLength(6);
    expect(body.core_error).toBeNull();
    const failed = await call("/api/lifecycle/brands", { cookie: employee });
    expect(await failed.json()).toMatchObject({ brands: body.brands, core_error: { code: "core_binding_missing", message: "Core lifecycle binding is missing" } });
  });
});