import { applyD1Migrations } from "cloudflare:test";
import { env, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApplyRuntimeRequest, type RuntimeStateResponse } from "@anjuna/contracts";
import { InstallBrandWorkflow, type InstallParams } from "../src/workflows/install";
import { RollbackBrandWorkflow, type RollbackParams } from "../src/workflows/rollback";
import factory from "../src/index";
import { setInstallStatus } from "../src/receipt";
import { UpgradeAllWorkflow, type UpgradeAllParams } from "../src/workflows/upgrade-all";
import { zip } from "../src/render";
import type { Env } from "../src/env";

beforeAll(() => applyD1Migrations(env.FACTORY, env.MIGRATIONS));
afterEach(() => vi.unstubAllGlobals());
const now = "2026-10-06T00:00:00.000Z";

// Runs production run() methods against local D1/R2. Every network request is
// intercepted, and the strict core wire schema is checked at the boundary.
function steps() {
  const cache = new Map<string, unknown>();
  let inside = false;
  const hooks = { before: async (_name: string) => {}, sleep: async () => {}, retry: async (_name: string) => {} };
  const configs = new Map<string, WorkflowStepConfig>();
  const step = {
    async do(name: string, configOrWork: WorkflowStepConfig | (() => Promise<unknown>), callback?: () => Promise<unknown>) {
      const config = typeof configOrWork === "function" ? {} : configOrWork;
      const work = typeof configOrWork === "function" ? configOrWork : callback!;
      configs.set(name, config);
      if (inside) throw new Error("nested Workflow step");
      if (cache.has(name)) return cache.get(name);
      await hooks.before(name);
      inside = true;
      try {
        for (let attempt = 0; ; attempt++) {
          try { const value = await work(); cache.set(name, value); return value; }
          catch (err) {
            if (err instanceof NonRetryableError || attempt >= (config.retries?.limit ?? 0)) throw err;
            await hooks.retry(name);
          }
        }
      }
      finally { inside = false; }
    },
    async sleep() {
      if (inside) throw new Error("sleep inside Workflow step");
      await hooks.sleep();
    },
  } as unknown as WorkflowStep;
  return { step, cache, hooks, configs };
}
function event<T>(payload: T) { return { payload } as WorkflowEvent<T>; }

async function fixture(live = false) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const brand = `brand_${id}`;
  const revision = `rev-${id}`;
  const install = `install-${id}`;
  const template = `template-${id}`;
  const version = `tv-${id}`;
  const artifact = `form-${id}`;
  const db = env.FACTORY;
  await db.prepare("INSERT INTO templates (template_id,name,framework,created_by,created_at) VALUES (?,?,'react_spa','owner',?)").bind(template, template, now).run();
  await db.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at) VALUES (?,?,1,?,?,'sealed',?,'owner',?)").bind(version, template, id, `${id}/site.zip`, now, now).run();
  await db.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,created_at,payload_version,bundle_form_version) VALUES (?,?,?,?,?,'2026-01','form@old')").bind(artifact, id, `${id}/form.zip`, id, now).run();
  await db.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?,?,'test',?,'Quick Loan',?,?,'owner',?,?)").bind(brand, "Example", `${id}.example`, live ? "live" : "draft", live ? revision : null, now, now).run();
  await db.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?,?,1,?,?,'{}',?,'owner',?)").bind(revision, brand, version, artifact, live ? "worker-old" : null, now).run();
  await db.prepare("INSERT INTO installs (install_id,brand_id,kind,from_revision_id,to_revision_id,status,started_by,started_at) VALUES (?,?,'install',?,?,'queued','owner',?)").bind(install, brand, live ? revision : null, revision, now).run();
  const enc = new TextEncoder();
  await env.ARTIFACTS.put(`${id}/site.zip`, zip(new Map([["index.html", enc.encode('<h1 class="brand-logo">Example</h1>')]])));
  await env.ARTIFACTS.put(`${id}/form.zip`, zip(new Map([["/_f/index.html", enc.encode("<p>Form</p>")]])));
  await env.ARTIFACTS.put("runtime/brand-runtime.js", "export default {fetch(){return new Response('local')}}");
  let runtime: RuntimeStateResponse = live ? {
    state: "applied", brand_id: brand, account: "test",
    applied_revision_id: revision, last_lifecycle_install_id: "previous-install", paused: true,
    bundle_form_version: "form@old", credential_account_match: true,
  } : { state: "absent", brand_id: brand, account: "test", credential_account_match: true };
  const applied: Array<ReturnType<typeof ApplyRuntimeRequest.parse>> = [];
  const settings = { smokeFails: false, uploadFails: false, dispatchFails: false, coreFails: false,
    apex: [] as Array<Response | Error>, www: [] as Array<Response | Error> };
  const core = { async fetch(request: Request) {
    const input = await request.json() as Record<string, unknown>;
    if (new URL(request.url).pathname.endsWith("runtime-state")) return Response.json(runtime);
    const parsed = ApplyRuntimeRequest.parse(input);
    if (settings.coreFails) return new Response("core unavailable", { status: 503 });
    applied.push(parsed);
    const current = runtime.state === "applied" ? runtime.applied_revision_id : null;
    if (current !== parsed.expected_revision_id) return new Response("stale", { status: 409 });
    runtime = {
      state: "applied", brand_id: brand, account: "test",
      applied_revision_id: parsed.target_revision_id, last_lifecycle_install_id: parsed.install_id,
      paused: parsed.target_revision_id === null || (runtime.state === "applied" && runtime.paused
        && !(parsed.initial_runtime && runtime.applied_revision_id === null && runtime.last_lifecycle_install_id !== null)),
      bundle_form_version: parsed.bundle_form_version ?? parsed.initial_runtime?.form_version ?? (runtime.state === "applied" ? runtime.bundle_form_version : null),
      credential_account_match: true,
    };
    return Response.json({ state: parsed.target_revision_id ? "applied" : "detached", install_id: parsed.install_id, applied_revision_id: parsed.target_revision_id, paused: runtime.paused });
  } };
  const compensation: RollbackParams[] = [];
  const uploads: Array<{ bindings: Array<Record<string, unknown>>; assets?: { jwt: string; config?: Record<string, unknown> } }> = [];
  const domains = new Set(live ? ["local-domain"] : []);
  const network = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.hostname === `${id}.example` || url.hostname === `www.${id}.example`) {
      const apex = url.hostname === `${id}.example`;
      const response = (apex ? settings.apex : settings.www).shift();
      if (response instanceof Error) throw response;
      return response ?? (apex
        ? new Response('<h1><span data-kw>Quick Loan</span></h1><form data-cta action="/go"></form>', { status: settings.smokeFails ? 500 : runtime.state === "applied" && runtime.paused ? 503 : 200 })
        : new Response(null, { status: 301, headers: { Location: `https://${id}.example/` } }));
    }
    if (url.hostname !== "api.cloudflare.com") throw new Error(`Unexpected external request: ${url}`);
    if (url.pathname.endsWith("/zones")) return ok([{ id: "zone-local", status: "active" }]);
    if (url.pathname.endsWith("/dns_records")) return ok([]);
    if (url.pathname.endsWith(`/scripts/brand-${brand}/assets-upload-session`)) return ok({ jwt: "local-session", buckets: [] });
    if (url.pathname.endsWith(`/scripts/brand-${brand}`)) {
      if (settings.uploadFails) throw new Error("upload failed locally");
      const metadata = (init!.body as FormData).get("metadata") as File;
      uploads.push(JSON.parse(await metadata.text()));
      return ok({ id: "local-script", etag: "local-etag" });
    }
    if (url.pathname.endsWith("/deployments")) {
      const deployment = { id: "local-deploy", versions: [{ version_id: "worker-local", percentage: 100 }] };
      return ok(init?.method === "POST" ? deployment : { deployments: [deployment] });
    }
    if (url.pathname.endsWith("/workers/domains")) {
      if (init?.method === "PUT") { domains.add("local-domain"); return ok({ id: "local-domain" }); }
      return ok([...domains].map((id) => ({ id })));
    }
    if (url.pathname.endsWith("/workers/domains/local-domain") && init?.method === "DELETE") {
      domains.delete("local-domain");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected CF request: ${url}`);
  });
  vi.stubGlobal("fetch", network);
  const bindings = {
    ...env, CORE_LIFECYCLE: core, CORE_TOKEN: "local-token", CORE_ACCOUNT: "test", CORE_SERVICE_NAME: "tenant-core",
    CORE_DOMAIN: "core.example", DEFAULT_FORM_ROUTE: "/apply", DEFAULT_AMOUNT_BUCKETS: "[100,200,500]",
    LEADSGATE_AID: "17244", LEADSGATE_PREPOP_BASE: "https://prepop.example/apply",
    ROLLBACK_WORKFLOW: { async create({ params }: { params: RollbackParams }) {
      if (settings.dispatchFails) throw new Error("compensation dispatch unavailable");
      compensation.push(params); return { id: params.install_id };
    } },
  } as unknown as Env;
  const params: InstallParams = { install_id: install, brand_id: brand, revision_id: revision };
  return { id, brand, revision, install, template, version, artifact, bindings, params, applied, compensation, settings, uploads, network,
    runtime: () => runtime, brandRow: () => db.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id=?").bind(brand).first(),
    installRow: () => db.prepare("SELECT status FROM installs WHERE install_id=?").bind(install).first(),
  };
}
function runInstall(f: Awaited<ReturnType<typeof fixture>>, s = steps()) {
  return InstallBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as InstallBrandWorkflow, event(f.params), s.step);
}

describe("production lifecycle Workflow.run integration (local-only)", () => {
  const smokeCalls = (f: Awaited<ReturnType<typeof fixture>>) => f.network.mock.calls.filter(([url]) => String(url).endsWith(".example/"));
  const smokeReceipt = (f: Awaited<ReturnType<typeof fixture>>) => env.FACTORY.prepare(
    "SELECT status,output_json FROM install_receipts WHERE install_id=? AND step='smoke'",
  ).bind(f.install).first<{ status: string; output_json: string }>();

  it("re-fetches after apex 530, www 525 and DNS propagation without caching a failed receipt", async () => {
    const f = await fixture();
    f.settings.apex.push(new Response("error code: 1016", { status: 530 }));
    f.settings.www.push(new Response(null, { status: 525 }), new TypeError("DNS lookup failed: EAI_AGAIN"));
    const s = steps();
    let retries = 0;
    s.hooks.retry = async (name) => {
      expect(name).toBe("smoke");
      expect(await smokeReceipt(f)).toBeNull();
      expect(f.compensation).toEqual([]);
      retries++;
    };
    await runInstall(f, s);
    expect(retries).toBe(2);
    expect(smokeCalls(f)).toHaveLength(6);
    for (const [, init] of smokeCalls(f)) expect(init).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
    expect(await f.installRow()).toEqual({ status: "ready" });
    expect(await smokeReceipt(f)).toMatchObject({ status: "ok" });
    expect(s.configs.get("smoke")).toEqual({ retries: { limit: 8, delay: "25 seconds", backoff: "constant" }, timeout: "10 seconds" });
    await runInstall(f, s);
    expect(smokeCalls(f)).toHaveLength(6);
  });

  it("exhausts the bounded propagation retries before recording failure and dispatching rollback once", async () => {
    const f = await fixture();
    f.settings.apex.push(...Array.from({ length: 9 }, () => new Response("error code: 1016", { status: 530 })));
    const s = steps();
    await runInstall(f, s);
    expect(smokeCalls(f)).toHaveLength(18);
    expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining("apex returned 530") });
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(1);
    await runInstall(f, s);
    expect(smokeCalls(f)).toHaveLength(18);
    expect(f.compensation).toHaveLength(1);
  });

  it.each([400, 404, 500, 503])("fails immediately for Worker HTTP %s even when the other hostname is propagating", async (status) => {
    const f = await fixture();
    f.settings.apex.push(new Response("error code: 1016", { status: 530 }));
    f.settings.www.push(new Response("Not Found", { status, headers: { server: "cloudflare" } }));
    await runInstall(f);
    expect(smokeCalls(f)).toHaveLength(2);
    expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining(`www returned ${status}`) });
    expect(f.compensation).toHaveLength(1);
  });

  it.each(["content", "temporary redirect", "wrong redirect", "non-DNS exception"])("fails immediately for invalid smoke %s", async (failure) => {
    const f = await fixture();
    if (failure === "content") f.settings.apex.push(new Response("Not Found", { status: 200 }));
    if (failure === "temporary redirect") f.settings.www.push(new Response(null, { status: 302, headers: { Location: `https://${f.id}.example/` } }));
    if (failure === "wrong redirect") f.settings.www.push(new Response(null, { status: 301, headers: { Location: "https://wrong.example/" } }));
    if (failure === "non-DNS exception") f.settings.apex.push(new TypeError("unexpected application failure"));
    await runInstall(f);
    expect(smokeCalls(f)).toHaveLength(2);
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(1);
  });

  it("uploads the brand Worker with run_worker_first and an ASSETS binding (BR-1)", async () => {
    const f = await fixture();
    await runInstall(f);
    expect(f.uploads[0]!.assets).toEqual({ jwt: "local-session", config: { html_handling: "none", run_worker_first: true } });
    expect(f.uploads[0]!.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
  });

  it("provisions before deploy, uses tenant defaults and marks READY only after core verification", async () => {
    const f = await fixture();
    const s = steps();
    s.hooks.before = async (name) => { if (name === "deploy") expect(f.runtime()).toMatchObject({ state: "applied", applied_revision_id: f.revision }); };
    await runInstall(f, s);
    expect(await f.installRow()).toEqual({ status: "ready" });
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
    expect(f.applied[0]!.initial_runtime).toMatchObject({ aid: "17244", amount_buckets: [100, 200, 500], form_route: "/apply", form_version: "form@old" });
    expect(f.uploads[0]!.bindings).toContainEqual({ type: "service", name: "CORE", service: "tenant-core" });
    expect(f.uploads[0]!.bindings).toContainEqual(expect.objectContaining({ name: "BRAND_CONFIG", json: expect.objectContaining({ brand_id: f.brand, brand: "Example" }) }));
    const calls = f.network.mock.calls.length;
    await runInstall(f, s);
    expect(f.network).toHaveBeenCalledTimes(calls);
  });

  it("replays a READY install with a fresh step cache without new installs, versions, domains or receipts", async () => {
    const f = await fixture();
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "ready" });
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
    const snapshot = async () => ({
      installs: (await env.FACTORY.prepare("SELECT * FROM installs WHERE brand_id=? ORDER BY install_id").bind(f.brand).all()).results,
      revisions: (await env.FACTORY.prepare("SELECT * FROM brand_revisions WHERE brand_id=? ORDER BY revision_id").bind(f.brand).all()).results,
      receipts: (await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY step").bind(f.install).all()).results,
    });
    const before = await snapshot();
    expect(before.installs).toHaveLength(1);
    expect(before.revisions).toHaveLength(1);
    expect(before.revisions[0]).toMatchObject({ worker_version_id: "worker-local" });
    expect(f.uploads).toHaveLength(1);
    expect(f.network.mock.calls.filter(([url, init]) => String(url).endsWith("/workers/domains") && init?.method === "PUT")).toHaveLength(2);
    const calls = f.network.mock.calls.length;
    const applied = f.applied.length;

    // Same install ID, but no in-memory Workflow step cache from the first run.
    const replay = steps();
    await runInstall(f, replay);
    expect(replay.configs.size).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(f.uploads).toHaveLength(1);
    expect(f.applied).toHaveLength(applied);
    expect(f.compensation).toEqual([]);
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
  });

  it("preserves an existing live deployment when preflight rejects a foreign account", async () => {
    const f = await fixture(true);
    f.bindings.CORE_ACCOUNT = "other";
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
    expect(f.network).not.toHaveBeenCalled();
    expect(f.compensation).toEqual([]);
  });

  it.each([false, true])("never reports READY when core apply fails (existing=%s)", async (live) => {
    const f = await fixture(live); f.settings.coreFails = true;
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(1);
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    expect(await env.FACTORY.prepare("SELECT step FROM install_receipts WHERE install_id=? AND step='receipt'").bind(f.install).first()).toBeNull();
  });

  it("compensates first-install failure after core provision using the actual core revision", async () => {
    const f = await fixture(); f.settings.smokeFails = true;
    await runInstall(f);
    expect(await smokeReceipt(f)).toMatchObject({ status: "failed" });
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(1);
    const compensationId = `compensate-${f.install}`;
    expect(f.compensation[0]).toMatchObject({
      install_id: compensationId, original_install_id: f.install,
      brand_id: f.brand, to_revision_id: null,
    });
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), steps().step);
    expect(f.applied[1]).toMatchObject({ expected_revision_id: f.revision, target_revision_id: null });
    expect(f.runtime()).toMatchObject({ paused: true, applied_revision_id: null });
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
    expect(await env.FACTORY.prepare("SELECT kind,status FROM installs WHERE install_id=?").bind(compensationId).first()).toEqual({ kind: "rollback", status: "rolled_back" });
    const receipts = await env.FACTORY.prepare("SELECT step,status FROM install_receipts WHERE install_id=? ORDER BY step").bind(compensationId).all();
    expect(receipts.results).toEqual([
      { step: "attach_domains", status: "ok" },
      { step: "receipt", status: "ok" },
      { step: "sync_runtime", status: "ok" },
      { step: "validate", status: "ok" },
    ]);
    expect(await env.FACTORY.prepare("SELECT status FROM install_receipts WHERE install_id=? AND step='rollback'").bind(f.install).first()).toEqual({ status: "ok" });
    f.settings.smokeFails = false;
    const retry = `retry-${f.install}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,to_revision_id,status,started_by,started_at) VALUES (?,?,'install',?,'queued','owner',?)")
      .bind(retry, f.brand, f.revision, now).run();
    f.params.install_id = retry;
    await runInstall(f);
    expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(retry).first()).toEqual({ status: "ready" });
    expect(f.runtime()).toMatchObject({ paused: false, applied_revision_id: f.revision });
  });

  it("still compensates on replay when every mutation step is cached", async () => {
    const f = await fixture(); f.settings.smokeFails = true;
    const s = steps();
    s.hooks.before = async (name) => { if (name === "rollback") throw new Error("isolate restarted before compensation"); };
    await expect(runInstall(f, s)).rejects.toThrow("isolate restarted");
    expect(s.cache.has("deploy")).toBe(true);
    const calls = f.network.mock.calls.length;
    s.hooks.before = async () => {};
    await runInstall(f, s);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(f.compensation).toHaveLength(1);
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
  });

  it("retains the lock and actionable failure when compensation dispatch fails", async () => {
    const f = await fixture(); f.settings.smokeFails = true; f.settings.dispatchFails = true;
    await expect(runInstall(f)).rejects.toThrow("compensation dispatch unavailable");
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    const row = await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first<{ error: string }>();
    expect(JSON.parse(row!.error)).toMatchObject({ recovery_required: true, original_install_id: f.install });
  });

  it("runs a rollback with target bundle identity and preserves an operator pause", async () => {
    const f = await fixture(true);
    await env.FACTORY.prepare("UPDATE installs SET kind='rollback' WHERE install_id=?").bind(f.install).run();
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
      event({ install_id: f.install, brand_id: f.brand, to_revision_id: f.revision }), steps().step);
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(f.applied[0]).toMatchObject({ bundle_form_version: "form@old", expected_revision_id: f.revision });
    expect(f.runtime()).toMatchObject({ paused: true });
  });

  it.each(["failed", "rolled_back", "ready"])("canary %s: polls outside steps and only fans out after verified READY", async (status) => {
    const f = await fixture(true);
    await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?").bind(f.install).run();
    const second = `second-${f.id}`;
    await env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES (?,?,'test',?,'live',?,'owner',?,?)").bind(second, second, `${second}.example`, f.revision, now, now).run();
    await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?,?,1,?,?,'{}','worker-old','owner',?)").bind(`rev-${second}`, second, f.version, f.artifact, now).run();
    await env.FACTORY.prepare("UPDATE brands SET current_revision_id=? WHERE brand_id=?").bind(`rev-${second}`, second).run();
    const target = `target-${f.id}`;
    await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at) VALUES (?,?,2,?,?,'sealed',?,'owner',?)").bind(target, f.template, target, `${f.id}/site.zip`, now, now).run();
    const dispatch = vi.fn(async ({ params }: { params: InstallParams }) => {
      if (params.brand_id === f.brand) {
        await env.FACTORY.prepare("UPDATE installs SET status=? WHERE install_id=?").bind(status, params.install_id).run();
        if (status === "ready") await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'sync_runtime','ok','{}',?)").bind(params.install_id, now).run();
      }
      return { id: params.install_id };
    });
    f.bindings.INSTALL_WORKFLOW = { create: dispatch } as unknown as Workflow;
    const params: UpgradeAllParams = { from_template_version_id: f.version, to_template_version_id: target, form_artifact_id: f.artifact, canary_brand_id: f.brand, started_by: "owner", started_role: "owner" };
    const s = steps();
    const run = () => UpgradeAllWorkflow.prototype.run.call({ env: f.bindings } as unknown as UpgradeAllWorkflow, event(params), s.step);
    if (status === "ready") await run(); else await expect(run()).rejects.toThrow("Canary install failed");
    expect(dispatch).toHaveBeenCalledTimes(status === "ready" ? 2 : 1);
    if (status === "ready") await run(); else await expect(run()).rejects.toThrow("Canary install failed");
    expect(dispatch).toHaveBeenCalledTimes(status === "ready" ? 2 : 1);
  });

  const recover = (f: Awaited<ReturnType<typeof fixture>>, role = "owner") => factory.fetch(new Request("https://factory/recover", {
    method: "POST", body: JSON.stringify({ brand_id: f.brand, started_by: "owner-1", started_role: role }),
  }), f.bindings);

  async function failCompensation(f: Awaited<ReturnType<typeof fixture>>) {
    f.settings.smokeFails = true;
    await runInstall(f);
    f.settings.coreFails = true;
    await expect(RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
      event(f.compensation[0]!), steps().step)).rejects.toThrow("Core lifecycle request failed (503)");
    f.settings.coreFails = false;
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
  }

  it.each([false, true])("recovers retained lock, restores previous state and allows the next install (live=%s)", async (live) => {
    const f = await fixture(live);
    // Keep the old deployed revision separate from the failed new deployment.
    if (live) {
      const next = `next-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      f.params.revision_id = next;
    }
    await failCompensation(f);
    const failedReceipts = await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(f.compensation[0]!.install_id).all();
    const responses = await Promise.all([recover(f), recover(f)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const recovery = f.compensation[1]!;
    expect(recovery).toMatchObject({ original_install_id: f.install, to_revision_id: live ? f.revision : null });
    expect((await recover(f)).status).toBe(409);
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(recovery), steps().step);
    expect(await f.brandRow()).toEqual({ status: live ? "live" : "failed", current_revision_id: live ? f.revision : null });
    expect(f.runtime()).toMatchObject({ applied_revision_id: live ? f.revision : null, paused: true });
    if (live) expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith("/deployments") && String(init?.body).includes("worker-old"))).toBe(true);
    else expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith("/workers/domains/local-domain") && init?.method === "DELETE")).toBe(true);
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    if (!live) {
      const detached = await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step='attach_domains'").bind(recovery.install_id).first<{ output_json: string }>();
      expect(JSON.parse(detached!.output_json)).toEqual({ detached: 0 });
    }
    expect((await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(f.compensation[0]!.install_id).all()).results).toEqual(failedReceipts.results);
    expect(await env.FACTORY.prepare("SELECT actor_id,actor_role FROM audit_log WHERE entity_id=? AND action='install.recover'").bind(recovery.install_id).first()).toEqual({ actor_id: "owner-1", actor_role: "owner" });
    expect(await env.FACTORY.prepare("SELECT status FROM install_receipts WHERE install_id=? AND step='receipt'").bind(recovery.install_id).first()).toEqual({ status: "ok" });
    const calls = f.network.mock.calls.length;
    expect(await (await recover(f)).json()).toMatchObject({ install_id: recovery.install_id, idempotent: true });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(recovery), steps().step);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(f.compensation).toHaveLength(2);
    const nextInstall = `new-${f.id}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'install','queued','owner',?)").bind(nextInstall, f.brand, now).run();
    expect(await setInstallStatus(env.FACTORY, nextInstall, "running", undefined, f.brand)).toBe("claimed");
  });

  it("refuses Employee recovery before any mutation", async () => {
    const f = await fixture();
    await failCompensation(f);
    const calls = f.network.mock.calls.length;
    expect((await recover(f, "employee")).status).toBe(403);
    expect(f.compensation).toHaveLength(1);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
  });

  it("refuses recovery without failed compensation", async () => {
    const f = await fixture();
    expect((await recover(f)).status).toBe(409);
    f.settings.smokeFails = true;
    await runInstall(f);
    expect((await recover(f)).status).toBe(409);
    expect(f.compensation).toHaveLength(1);
  });

  it("retains the lock when recovery fails and permits a fresh Owner attempt", async () => {
    const f = await fixture();
    await failCompensation(f);
    expect((await recover(f)).status).toBe(201);
    f.settings.coreFails = true;
    await expect(RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
      event(f.compensation[1]!), steps().step)).rejects.toThrow();
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    f.settings.coreFails = false;
    expect((await recover(f)).status).toBe(201);
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[2]!), steps().step);
    expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
  });
});
