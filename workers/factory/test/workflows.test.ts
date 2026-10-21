import { applyD1Migrations } from "cloudflare:test";
import { env, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ANALYTICS_FORWARD_PATHS, ApplyRuntimeRequest, InstallAdsRoutingRequest, InstallMailingListRequest, type RuntimeStateResponse } from "@anjuna/contracts";
import { InstallBrandWorkflow, type InstallParams } from "../src/workflows/install";
import { RollbackBrandWorkflow, type RollbackParams } from "../src/workflows/rollback";
import factory from "../src/index";
import { setInstallStatus } from "../src/receipt";
import { UpgradeAllWorkflow, upgradeInstallId, type UpgradeAllParams } from "../src/workflows/upgrade-all";
import { REMOTE_STEP_RETRY_CONFIG } from "../src/step-receipt";
import { unzip, zip } from "../src/render";
import type { Env } from "../src/env";

beforeAll(() => applyD1Migrations(env.FACTORY, env.MIGRATIONS));
afterEach(() => vi.unstubAllGlobals());
const now = "2026-10-06T00:00:00.000Z";
const DEC = new TextDecoder();

// Mirror of apps/web/src/server/retry-install.ts#queueInstallRetry. The factory test
// must not reach across package boundaries into the web Worker's server code, so the D1
// claim + successful-prefix copy is reproduced here. The production function is exercised
// end-to-end through the retry route in apps/web/test/lifecycle-api.test.ts.
async function queueInstallRetry(db: D1Database, sourceId: string): Promise<string | null> {
  const terminal = await db.prepare("SELECT 1 FROM install_receipts WHERE install_id=? AND status IN ('failed','ok') LIMIT 1").bind(sourceId).first();
  const at = new Date().toISOString();
  const digest = terminal ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceId)) : null;
  const retryId = digest
    ? `ins_retry_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`
    : sourceId;
  const eligible = `status='failed'
    AND EXISTS (SELECT 1 FROM brands b WHERE b.brand_id=installs.brand_id
      AND b.status IN ('draft','live','failed') AND b.current_revision_id IS installs.from_revision_id)
    AND NOT EXISTS (SELECT 1 FROM installs active WHERE active.brand_id=installs.brand_id AND active.status IN ('queued','running'))`;
  const claim = terminal
    ? db.prepare(`INSERT OR IGNORE INTO installs
        (install_id,brand_id,kind,status,from_revision_id,to_revision_id,rollback_record_json,started_by,started_role,started_at)
        SELECT ?,brand_id,kind,'queued',from_revision_id,to_revision_id,rollback_record_json,started_by,started_role,?
        FROM installs WHERE install_id=? AND ${eligible}`)
      .bind(retryId, at, sourceId)
    : db.prepare(`UPDATE installs SET status='queued',error=NULL,finished_at=NULL WHERE install_id=? AND ${eligible}`)
      .bind(sourceId);
  const statements: D1PreparedStatement[] = [claim];
  if (terminal) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO install_receipts (install_id,step,status,output_json,created_at)
      SELECT ?,step,status,output_json,created_at FROM install_receipts
      WHERE install_id=? AND status='ok' AND step!='rollback'
        AND id < COALESCE((SELECT MIN(id) FROM install_receipts WHERE install_id=? AND status='failed'),9223372036854775807)
        AND EXISTS (SELECT 1 FROM installs WHERE install_id=?)`)
      .bind(retryId, sourceId, sourceId, retryId));
  }
  const [claimed] = await db.batch(statements);
  if (claimed!.meta.changes !== 1) return null;
  return retryId;
}

// The Workflows engine runs a step callback across an RPC boundary. An error whose name is not a built-in one
// comes back to the Workflow code with name "Error" and the message "<name>: <message>"; the engine itself
// tests for `message.startsWith("NonRetryableError")` (miniflare workflows binding.worker.js, lines 13639 and 14956).
const BUILT_IN_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError"]);
function engineRethrow(err: unknown): unknown {
  if (!(err instanceof Error) || BUILT_IN_ERROR_NAMES.has(err.name)) return err;
  return new Error(`${err.name}: ${err.message}`);
}

// Runs production run() methods against local D1/R2. Every network request is
// intercepted, and the strict core wire schema is checked at the boundary.
function steps() {
  const cache = new Map<string, unknown>();
  let inside = false;
  const hooks = { before: async (_name: string) => {}, sleep: async () => {}, retry: async (_name: string) => {} };
  const configs = new Map<string, WorkflowStepConfig>();
  // Callback runs per step, and the error a step finally threw after its configured retries.
  const attempts = new Map<string, number>();
  const failures = new Map<string, unknown>();
  const step = {
    async do(name: string, configOrWork: WorkflowStepConfig | ((ctx?: { attempt: number }) => Promise<unknown>), callback?: (ctx: { attempt: number }) => Promise<unknown>) {
      const config = typeof configOrWork === "function" ? {} : configOrWork;
      const work = typeof configOrWork === "function" ? configOrWork : callback!;
      configs.set(name, config);
      if (inside) throw new Error("nested Workflow step");
      if (cache.has(name)) return cache.get(name);
      await hooks.before(name);
      inside = true;
      try {
        for (let attempt = 0; ; attempt++) {
          attempts.set(name, attempt + 1);
          try { const value = await work({ attempt: attempt + 1 }); cache.set(name, value); return value; }
          catch (err) {
            if (err instanceof NonRetryableError || attempt >= (config.retries?.limit ?? 0)) { failures.set(name, err); throw engineRethrow(err); }
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
  return { step, cache, hooks, configs, attempts, failures };
}
function event<T>(payload: T) { return { payload } as WorkflowEvent<T>; }

async function fixture(live = false, subdomain = false, paused = true) {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const brand = `brand_${id}`;
  const revision = `rev-${id}`;
  const install = `install-${id}`;
  const template = `template-${id}`;
  const version = `tv-${id}`;
  const artifact = `form-${id}`;
  const domain = subdomain ? `${id}.sub.example` : `${id}.example`;
  const db = env.FACTORY;
  await db.prepare("INSERT INTO templates (template_id,name,framework,created_by,created_at) VALUES (?,?,'react_spa','owner',?)").bind(template, template, now).run();
  await db.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at) VALUES (?,?,1,?,?,'sealed',?,'owner',?)").bind(version, template, id, `${id}/site.zip`, now, now).run();
  await db.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,created_at,payload_version,bundle_form_version) VALUES (?,?,?,?,?,'2026-01','form@old')").bind(artifact, id, `${id}/form.zip`, id, now).run();
  await db.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?,?,'test',?,'Quick Loan',?,?,'owner',?,?)").bind(brand, "Example", domain, live ? "live" : "draft", live ? revision : null, now, now).run();
  await db.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?,?,1,?,?,'{}',?,'owner',?)").bind(revision, brand, version, artifact, live ? "worker-old" : null, now).run();
  await db.prepare("INSERT INTO installs (install_id,brand_id,kind,from_revision_id,to_revision_id,status,started_by,started_at) VALUES (?,?,'install',?,?,'queued','owner',?)").bind(install, brand, live ? revision : null, revision, now).run();
  const enc = new TextEncoder();
  await env.ARTIFACTS.put(`${id}/site.zip`, zip(new Map([["index.html", enc.encode('<h1 class="brand-logo">Example</h1>')]])));
  await env.ARTIFACTS.put(`${id}/form.zip`, zip(new Map([["/_f/index.html", enc.encode("<p>Form</p>")]])));
  await env.ARTIFACTS.put("runtime/brand-runtime.js", "export default {fetch(){return new Response('local')}}");
  let runtime: RuntimeStateResponse = live ? {
    state: "applied", brand_id: brand, account: "test",
    applied_revision_id: revision, last_lifecycle_install_id: "previous-install", paused,
    bundle_form_version: "form@old", credential_account_match: true,
  } : { state: "absent", brand_id: brand, account: "test", credential_account_match: true };
  const applied: Array<ReturnType<typeof ApplyRuntimeRequest.parse>> = [];
  const counters = { applyEffects: 0 };
  const settings = { smokeFails: false, uploadFails: false, dispatchFails: false, coreFails: false, stateMode: "ok" as "ok" | "fail" | "absent",
    zoneName: subdomain ? "sub.example" : domain,
    // Zone records that no Custom Domain of this brand explains (a hand-made A or CNAME).
    foreignDns: [] as Array<{ type: string; name: string }>,
    // HTTP statuses answered, one per call, before the zone, Workers Domains list and Core runtime-state calls succeed.
    zoneHttp: [] as number[], domainsHttp: [] as number[], stateHttp: [] as number[], zoneStatus: "active",
    // HTTP statuses Core answers, one per runtime apply, before it accepts one; and how many compensation dispatches fail first.
    applyHttp: [] as number[], dispatchFailures: 0,
    // HTTP statuses Core answers, one per mailing-list call, before it gives the brand a list (502: listmonk failed).
    listHttp: [] as number[],
    apex: [] as Array<Response | Error>, www: [] as Array<Response | Error> };
  // Core's install-routing calls from sync_runtime, and the brand's stored listmonk list id.
  const adsRouted: Array<ReturnType<typeof InstallAdsRoutingRequest.parse>> = [];
  const listCalls: Array<ReturnType<typeof InstallMailingListRequest.parse>> = [];
  let listId: number | null = null;
  const core = { async fetch(request: Request) {
    const input = await request.json() as Record<string, unknown>;
    if (new URL(request.url).pathname.endsWith("runtime-state")) {
      const refused = settings.stateHttp.shift();
      if (refused) return new Response("core refused", { status: refused });
      if (settings.stateMode === "fail") return new Response("core unavailable", { status: 503 });
      if (settings.stateMode === "absent") return Response.json({ state: "absent", brand_id: brand, account: "test", credential_account_match: true });
      return Response.json(runtime);
    }
    if (new URL(request.url).pathname.endsWith("/ads-routing")) {
      const routed = InstallAdsRoutingRequest.parse(input);
      adsRouted.push(routed);
      return Response.json({ copied: Object.keys(routed.ads), kept: [] });
    }
    if (new URL(request.url).pathname.endsWith("/mailing-list")) {
      listCalls.push(InstallMailingListRequest.parse(input));
      const refused = settings.listHttp.shift();
      if (refused) return Response.json({ error: "listmonk_failed", message: "listmonk list was not created: listmonk POST list failed: 502" }, { status: refused });
      const state = listId ? "stored" : "created";
      listId ??= 900;
      return Response.json({ state, list_id: listId });
    }
    const parsed = ApplyRuntimeRequest.parse(input);
    if (settings.coreFails) return new Response("core unavailable", { status: 503 });
    const refused = settings.applyHttp.shift();
    if (refused) return new Response("core refused", { status: refused });
    applied.push(parsed);
    // The same install_id again is a replay: core answers noop and changes nothing (workers/core/src/lifecycle.ts, applyRuntime).
    if (runtime.state === "applied" && runtime.last_lifecycle_install_id === parsed.install_id) {
      return Response.json({ state: "noop", install_id: parsed.install_id, applied_revision_id: runtime.applied_revision_id, paused: runtime.paused });
    }
    const current = runtime.state === "applied" ? runtime.applied_revision_id : null;
    if (current !== parsed.expected_revision_id) return new Response("stale", { status: 409 });
    counters.applyEffects++;
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
  const dispatched = new Set<string>();
  const uploads: Array<{ bindings: Array<Record<string, unknown>>; assets?: { jwt: string; config?: Record<string, unknown> } }> = [];
  // Custom Domains attached in the account: hostname -> script. An installed brand holds the
  // hostnames it serves (apex plus www on its own zone, the bare subdomain otherwise), and a www
  // hostname left behind by an older install stays distinguishable from the bare brand domain.
  const domains = new Map<string, string>((live ? (subdomain ? [domain] : [domain, `www.${domain}`]) : []).map((hostname) => [hostname, `brand-${brand}`]));
  const network = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.hostname === domain || url.hostname === `www.${domain}`) {
      const apex = url.hostname === domain;
      const response = (apex ? settings.apex : settings.www).shift();
      if (response instanceof Error) throw response;
      return response ?? (apex
        ? runtime.state === "applied" && runtime.paused && !settings.smokeFails
          ? new Response("<!doctype html><title>Temporarily unavailable</title><h1>Temporarily unavailable</h1>", { status: 503 })
          : new Response('<h1><span data-kw>Quick Loan</span></h1><form data-cta action="/go"></form>', { status: settings.smokeFails ? 500 : 200 })
        : new Response(null, { status: 301, headers: { Location: `https://${domain}/` } }));
    }
    if (url.hostname !== "api.cloudflare.com") throw new Error(`Unexpected external request: ${url}`);
    if (url.pathname.endsWith("/zones")) {
      const refused = settings.zoneHttp.shift();
      if (refused) return Response.json({ success: false, errors: [{ code: 9999, message: "zone lookup refused" }] }, { status: refused });
      const queried = url.searchParams.get("name");
      return queried === settings.zoneName ? ok([{ id: "zone-local", status: settings.zoneStatus, name: queried ?? "" }]) : ok([]);
    }
    // Cloudflare creates the DNS record of every attached Custom Domain itself, so the zone of an
    // installed brand holds one AAAA record per hostname it serves.
    if (url.pathname.endsWith("/dns_records")) {
      const name = url.searchParams.get("name") ?? "";
      const own = domains.has(name) ? [{ id: `dns-${name}`, type: "AAAA", name }] : [];
      return ok([...own, ...settings.foreignDns.filter((record) => record.name === name).map((record) => ({ id: `dns-foreign-${record.type}-${name}`, ...record }))]);
    }
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
      if (init?.method === "PUT") {
        const { hostname, service } = JSON.parse(String(init.body)) as { hostname: string; service: string };
        domains.set(hostname, service);
        return ok({ id: `local-${hostname}`, hostname, service });
      }
      const refused = settings.domainsHttp.shift();
      if (refused) return Response.json({ success: false, errors: [{ code: 9999, message: "domains list refused" }] }, { status: refused });
      const service = url.searchParams.get("service");
      return ok([...domains].filter(([, script]) => !service || script === service)
        .map(([hostname, script]) => ({ id: `local-${hostname}`, hostname, service: script, zone_id: "zone-local" })));
    }
    const domainId = /\/workers\/domains\/(.+)$/.exec(url.pathname);
    if (domainId && init?.method === "DELETE") {
      domains.delete(domainId[1]!.replace(/^local-/, ""));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected CF request: ${url}`);
  });
  vi.stubGlobal("fetch", network);
  const bindings = {
    ...env, CORE_LIFECYCLE: core, CORE_TOKEN: "local-token", CORE_ACCOUNT: "test", CORE_SERVICE_NAME: "tenant-core",
    CORE_DOMAIN: "core.example", DEFAULT_FORM_ROUTE: "/apply", DEFAULT_AMOUNT_BUCKETS: "[100,200,500]",
    LEADSGATE_AID: "17244", LEADSGATE_PREPOP_BASE: "https://prepop.example/apply",
    // Like the engine: an instance id can be created once, and get() of an id that was never created throws.
    ROLLBACK_WORKFLOW: {
      async create({ params }: { params: RollbackParams }) {
        if (settings.dispatchFails || settings.dispatchFailures-- > 0) throw new Error("compensation dispatch unavailable");
        if (dispatched.has(params.install_id)) throw new Error("instance.already_exists");
        dispatched.add(params.install_id); compensation.push(params); return { id: params.install_id };
      },
      async get(id: string) {
        if (!dispatched.has(id)) throw new Error("instance.not_found");
        return { id };
      },
    },
  } as unknown as Env;
  const params: InstallParams = { install_id: install, brand_id: brand, revision_id: revision };
  return { id, brand, revision, install, template, version, artifact, bindings, params, applied, adsRouted, listCalls, counters, compensation, settings, uploads, network, domains,
    runtime: () => runtime, brandRow: () => db.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id=?").bind(brand).first(),
    installRow: () => db.prepare("SELECT status FROM installs WHERE install_id=?").bind(install).first(),
  };
}
function runInstall(f: Awaited<ReturnType<typeof fixture>>, s = steps()) {
  return InstallBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as InstallBrandWorkflow, event(f.params), s.step);
}

describe("production lifecycle Workflow.run integration (local-only)", () => {
  it("resumes a failed-receipt retry at render, preserving validation and rollback evidence", async () => {
    const f = await fixture();
    const templateKey = `${f.id}/site.zip`;
    const template = await (await env.ARTIFACTS.get(templateKey))!.arrayBuffer();
    await env.ARTIFACTS.delete(templateKey);
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(0);
    const receipts = (await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(f.install).all()).results;
    expect(receipts.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "validate", status: "ok" }, { step: "save_rollback", status: "ok" },
      { step: "render", status: "failed" }, { step: "rollback", status: "ok" },
    ]);
    const retryId = await queueInstallRetry(env.FACTORY, f.install);
    expect(retryId).not.toBeNull();
    await env.ARTIFACTS.put(templateKey, template);
    // Validation would now fail if the retry re-executed the successful prefix.
    f.bindings.CORE_SERVICE_NAME = "";
    f.network.mockClear();
    await runInstall({ ...f, params: { ...f.params, install_id: retryId! } });
    expect(await env.FACTORY.prepare("SELECT status,rollback_record_json FROM installs WHERE install_id=?").bind(retryId).first())
      .toEqual({ status: "ready", rollback_record_json: '{"previous_revision_id":null}' });
    expect(f.network.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/zones"))).toBe(false);
    expect(f.uploads).toHaveLength(1);
    expect(f.compensation).toHaveLength(0);
    expect((await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(f.install).all()).results).toEqual(receipts);
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
  });

  // Receipt D1 I/O belongs to the retried step: one transient D1 error on it must not fail the install.
  function failReceiptD1Once(f: Awaited<ReturnType<typeof fixture>>, step: string, kind: "read" | "write") {
    const real = f.bindings.FACTORY;
    const pattern = kind === "read" ? /^SELECT status, output_json FROM install_receipts/ : /^INSERT INTO install_receipts/;
    let armed = true;
    const prepare = (sql: string) => {
      const statement = real.prepare(sql);
      if (!armed || !pattern.test(sql)) return statement;
      return new Proxy(statement, { get: (target, prop) => prop === "bind"
        ? (...args: unknown[]) => {
          const bound = target.bind(...args);
          if (!(args.includes(step) && (kind === "read" || args.includes("ok")))) return bound;
          armed = false;
          return new Proxy(bound, { get: (b, p) => (p === "first" || p === "run")
            ? async () => { throw new Error("D1_ERROR: transient receipt I/O failure"); }
            : Reflect.get(b, p, b) });
        }
        : Reflect.get(target, prop, target) });
    };
    (f.bindings as unknown as { FACTORY: unknown }).FACTORY = new Proxy(real, { get: (t, p) => p === "prepare" ? prepare : Reflect.get(t, p, t) });
    return () => armed;
  }
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

  const smokeReceiptCount = (f: Awaited<ReturnType<typeof fixture>>, status: "ok" | "failed") => env.FACTORY.prepare(
    "SELECT COUNT(*) AS n FROM install_receipts WHERE install_id=? AND step='smoke' AND status=?",
  ).bind(f.install, status).first<{ n: number }>();

  it.each(["read", "write"] as const)("retries a transient D1 failure on the smoke receipt %s and reaches READY with one ok receipt and no compensation", async (kind) => {
    const f = await fixture();
    const armed = failReceiptD1Once(f, "smoke", kind);
    const s = steps();
    await runInstall(f, s);
    expect(armed()).toBe(false);
    expect(s.attempts.get("smoke")).toBe(2);
    expect(await f.installRow()).toEqual({ status: "ready" });
    expect(await smokeReceiptCount(f, "ok")).toEqual({ n: 1 });
    expect(await smokeReceiptCount(f, "failed")).toEqual({ n: 0 });
    expect(f.compensation).toHaveLength(0);
  });

  it("writes one failed smoke receipt with clean text and dispatches compensation for a NonRetryableError", async () => {
    const f = await fixture();
    f.settings.www.push(new Response("Not Found", { status: 404, headers: { server: "cloudflare" } }));
    const s = steps();
    await runInstall(f, s);
    expect(s.attempts.get("smoke")).toBe(1);
    expect(await smokeReceiptCount(f, "failed")).toEqual({ n: 1 });
    expect(await smokeReceiptCount(f, "ok")).toEqual({ n: 0 });
    const error = JSON.parse((await smokeReceipt(f))!.output_json).error as string;
    expect(error).toContain("www returned 404");
    expect(error).not.toContain("NonRetryableError");
    expect(await f.installRow()).toEqual({ status: "failed" });
    expect(f.compensation).toHaveLength(1);
  });

  it("writes one ok smoke receipt and no failed one when a retried 52x then passes", async () => {
    const f = await fixture();
    f.settings.apex.push(new Response("error code: 1016", { status: 530 }));
    const s = steps();
    await runInstall(f, s);
    expect(s.attempts.get("smoke")).toBe(2);
    expect(await smokeReceiptCount(f, "ok")).toEqual({ n: 1 });
    expect(await smokeReceiptCount(f, "failed")).toEqual({ n: 0 });
    expect(f.compensation).toHaveLength(0);
  });

  it("uploads the brand Worker with run_worker_first and an ASSETS binding (BR-1)", async () => {
    const f = await fixture();
    await runInstall(f);
    expect(f.uploads[0]!.assets).toEqual({ jwt: "local-session", config: { html_handling: "none", run_worker_first: true } });
    expect(f.uploads[0]!.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
  });

  it("attaches and smokes the apex plus www for a brand on its own zone", async () => {
    const f = await fixture();
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "ready" });
    const attached = f.network.mock.calls
      .filter(([url, init]) => String(url).endsWith("/workers/domains") && init?.method === "PUT")
      .map(([, init]) => (JSON.parse(String(init!.body)) as { hostname: string }).hostname);
    expect(attached).toEqual([`${f.id}.example`, `www.${f.id}.example`]);
    expect(f.applied[0]!.hostnames).toEqual([`${f.id}.example`, `www.${f.id}.example`]);
    expect(JSON.parse((await smokeReceipt(f))!.output_json!)).toEqual({ apex_status: 200, www_status: 301, final_url: `https://${f.id}.example/` });
  });

  it("attaches and smokes only the bare domain for a subdomain-zone brand and never touches www", async () => {
    const f = await fixture(false, true);
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "ready" });
    const attached = f.network.mock.calls
      .filter(([url, init]) => String(url).endsWith("/workers/domains") && init?.method === "PUT")
      .map(([, init]) => (JSON.parse(String(init!.body)) as { hostname: string }).hostname);
    expect(attached).toEqual([`${f.id}.sub.example`]);
    expect(f.network.mock.calls.some(([url]) => String(url).includes(`www.${f.id}.sub.example`))).toBe(false);
    const dnsNames = f.network.mock.calls
      .filter(([url]) => String(url).includes("/dns_records"))
      .map(([url]) => new URL(String(url)).searchParams.get("name"));
    expect(dnsNames).toEqual([`${f.id}.sub.example`]);
    expect(f.applied[0]!.hostnames).toEqual([`${f.id}.sub.example`]);
    expect(smokeCalls(f)).toHaveLength(1);
    expect(JSON.parse((await smokeReceipt(f))!.output_json!)).toEqual({ apex_status: 200, final_url: `https://${f.id}.sub.example/` });
    const receipt = await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step='attach_domains'")
      .bind(f.install).first<{ output_json: string }>();
    expect(JSON.parse(receipt!.output_json)).toEqual({ apex_domain_id: `local-${f.id}.sub.example` });
  });

  it("rolls back an older subdomain install whose receipt still carries a www domain", async () => {
    const f = await fixture(false, true);
    f.settings.smokeFails = true;
    await runInstall(f);
    expect(f.compensation).toHaveLength(1);
    // The install ran before per-zone hostnames existed and attached www.<domain> too.
    await f.network("https://api.cloudflare.com/client/v4/accounts/test/workers/domains", {
      method: "PUT", body: JSON.stringify({ hostname: `www.${f.id}.sub.example`, service: `brand-${f.brand}` }),
    });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), steps().step);
    const deleted = f.network.mock.calls
      .filter(([url, init]) => /\/workers\/domains\/local-/.test(String(url)) && init?.method === "DELETE")
      .map(([url]) => String(url).split("/workers/domains/")[1]!);
    expect(deleted.sort()).toEqual([`local-${f.id}.sub.example`, `local-www.${f.id}.sub.example`].sort());
    expect(f.applied[1]!.hostnames).toEqual([`${f.id}.sub.example`]);
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
  });

  it.each([["a first install", false], ["an upgrade of a live brand", true]])("binds the contract's analytics forward paths on %s", async (_name, live) => {
    const f = await fixture(live);
    await runInstall(f);
    expect(await f.installRow()).toEqual({ status: "ready" });
    const analytics = f.uploads[0]!.bindings.filter((binding) => binding.name === "CORE_ANALYTICS_PATHS");
    expect(analytics).toEqual([{ type: "plain_text", name: "CORE_ANALYTICS_PATHS", text: JSON.stringify(ANALYTICS_FORWARD_PATHS) }]);
    expect(JSON.parse(analytics[0]!.text as string)).toEqual({
      posthog: "/analytics/posthog", sentry: "/analytics/sentry", telemetry: "/analytics/telemetry", errors: "/analytics/errors",
    });
    // The paths are the only analytics binding: the real PostHog key and Sentry DSN never leave core.
    expect(JSON.stringify(f.uploads[0]!.bindings)).not.toMatch(/phc_|dsn|posthog_key|sentry_dsn/i);
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

  it("keeps compensation running when two retries arrive before dispatch and during rollback", async () => {
    const f = await fixture();
    f.settings.smokeFails = true;
    const retry = () => queueInstallRetry(env.FACTORY, f.install);
    const s = steps();
    s.hooks.before = async (name) => {
      if (name !== "rollback") return;
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await f.brandRow()).toMatchObject({ status: "installing" });
      expect(f.compensation).toHaveLength(0);
      expect(await Promise.all([retry(), retry()])).toEqual([null, null]);
      expect((await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(f.brand).all()).results).toHaveLength(1);
    };
    await runInstall(f, s);
    expect(f.compensation).toHaveLength(1);
    const rollback = steps();
    rollback.hooks.before = async (name) => {
      if (name !== "attach_domains") return;
      expect(await Promise.all([retry(), retry()])).toEqual([null, null]);
      expect((await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(f.brand).all()).results).toHaveLength(2);
    };
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), rollback.step);
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
    expect(f.runtime()).toMatchObject({ paused: true, applied_revision_id: null });
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

  it("copies the target template's text defaults into the upgrade revision", async () => {
    const f = await fixture(true);
    await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?").bind(f.install).run();
    const target = `target-text-${f.id}`;
    const defaults = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
    await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at,text_defaults_json) VALUES (?,?,3,?,?,'sealed',?,'owner',?,?)")
      .bind(target, f.template, target, `${f.id}/site.zip`, now, now, JSON.stringify(defaults)).run();
    f.bindings.INSTALL_WORKFLOW = { create: vi.fn(async ({ params }: { params: InstallParams }) => {
      await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?").bind(params.install_id).run();
      await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'sync_runtime','ok','{}',?)").bind(params.install_id, now).run();
      return { id: params.install_id };
    }) } as unknown as Workflow;
    const params: UpgradeAllParams = { from_template_version_id: f.version, to_template_version_id: target, form_artifact_id: f.artifact, canary_brand_id: f.brand, started_by: "owner", started_role: "owner" };
    await UpgradeAllWorkflow.prototype.run.call({ env: f.bindings } as unknown as UpgradeAllWorkflow, event(params), steps().step);
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND template_version_id=?").bind(f.brand, target).first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json).text_defaults).toEqual(defaults);
  });

  describe("smoke during upgrade", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function addUpgradeRevision(f: Fixture) {
      const next = `next-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      f.params.revision_id = next;
    }
    const smokeOutput = async (installId: string) => JSON.parse((await env.FACTORY.prepare(
      "SELECT output_json FROM install_receipts WHERE install_id=? AND step='smoke' AND status='ok'",
    ).bind(installId).first<{ output_json: string }>())!.output_json) as unknown;

    it("upgrade-all completes for a paused brand: pause page smoke passes, READY, still paused", async () => {
      const f = await fixture(true);
      await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?").bind(f.install).run();
      const target = `target-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at) VALUES (?,?,2,?,?,'sealed',?,'owner',?)").bind(target, f.template, target, `${f.id}/site.zip`, now, now).run();
      const dispatched: InstallParams[] = [];
      f.bindings.INSTALL_WORKFLOW = { async create({ params }: { params: InstallParams }) {
        dispatched.push(params);
        await InstallBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as InstallBrandWorkflow, event(params), steps().step);
        return { id: params.install_id };
      } } as unknown as Workflow;
      const params: UpgradeAllParams = { from_template_version_id: f.version, to_template_version_id: target, form_artifact_id: f.artifact, canary_brand_id: f.brand, started_by: "owner", started_role: "owner" };
      await UpgradeAllWorkflow.prototype.run.call({ env: f.bindings } as unknown as UpgradeAllWorkflow, event(params), steps().step);
      expect(dispatched).toHaveLength(1);
      const install = dispatched[0]!;
      expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(install.install_id).first()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: install.revision_id });
      expect(f.runtime()).toMatchObject({ paused: true, applied_revision_id: install.revision_id });
      expect(await smokeOutput(install.install_id)).toEqual({ apex_status: 503, www_status: 301 });
      expect(smokeCalls(f)).toHaveLength(2);
    });

    it("smokes a live brand upgrade for the landing page (regression)", async () => {
      const f = await fixture(true, false, false);
      await addUpgradeRevision(f);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await smokeOutput(f.install)).toEqual({ apex_status: 200, www_status: 301, final_url: `https://${f.id}.example/` });
      expect(f.runtime()).toMatchObject({ paused: false, applied_revision_id: f.params.revision_id });
    });

    it("fails a live upgrade whose apex answers the pause page", async () => {
      const f = await fixture(true, false, false);
      await addUpgradeRevision(f);
      f.settings.apex.push(new Response("<h1>Temporarily unavailable</h1>", { status: 503 }));
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining("apex returned 503 (expected 200") });
      expect(smokeCalls(f)).toHaveLength(2);
    });

    it("fails a paused upgrade whose apex serves the landing page without retry", async () => {
      const f = await fixture(true);
      await addUpgradeRevision(f);
      f.settings.apex.push(new Response('<h1><span data-kw>Quick Loan</span></h1><form data-cta></form>', { status: 200 }));
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining("apex returned 200 (expected 503") });
      expect(smokeCalls(f)).toHaveLength(2);
    });

    it("retries a failed pause-state read instead of assuming live or paused", async () => {
      const f = await fixture(true);
      await addUpgradeRevision(f);
      const s = steps();
      s.hooks.before = async (name) => { if (name === "smoke") f.settings.stateMode = "fail"; };
      s.hooks.retry = async (name) => { if (name === "smoke") f.settings.stateMode = "ok"; };
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(smokeCalls(f)).toHaveLength(2);
      expect(await smokeOutput(f.install)).toEqual({ apex_status: 503, www_status: 301 });
    });

    it("fails the install when the pause-state read never recovers, without fetching the brand", async () => {
      const f = await fixture(true);
      await addUpgradeRevision(f);
      const s = steps();
      s.hooks.before = async (name) => { if (name === "smoke") f.settings.stateMode = "fail"; };
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining("Core lifecycle request failed (503)") });
      expect(smokeCalls(f)).toHaveLength(0);
    });

    it("treats an absent runtime state as not paused", async () => {
      const f = await fixture(true);
      await addUpgradeRevision(f);
      const s = steps();
      s.hooks.before = async (name) => { if (name === "smoke") f.settings.stateMode = "absent"; };
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await smokeReceipt(f)).toMatchObject({ status: "failed", output_json: expect.stringContaining("apex returned 503 (expected 200") });
    });

    it("does not read the runtime state for smoke on a first install", async () => {
      const f = await fixture();
      const s = steps();
      s.hooks.before = async (name) => { if (name === "smoke") f.settings.stateMode = "fail"; };
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await smokeOutput(f.install)).toEqual({ apex_status: 200, www_status: 301, final_url: `https://${f.id}.example/` });
    });
  });

  // A redeploy is an upgrade-kind install onto a copy of the current revision: same template version,
  // same form artifact, revision + 1. The Workflow treats it as an upgrade because the brand already has a revision.
  describe("redeploy of a live brand", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function startRedeploy(f: Fixture) {
      const next = `redeploy-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) SELECT ?,brand_id,revision + 1,template_version_id,form_artifact_id,config_json,'owner',? FROM brand_revisions WHERE revision_id=?")
        .bind(next, now, f.revision).run();
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
      return next;
    }
    const revisionRow = (id: string) => env.FACTORY.prepare("SELECT revision,template_version_id,form_artifact_id,worker_version_id FROM brand_revisions WHERE revision_id=?").bind(id).first();
    const stepsOf = async (installId: string) => (await env.FACTORY.prepare("SELECT step FROM install_receipts WHERE install_id=? AND status='ok' ORDER BY id").bind(installId).all<{ step: string }>()).results.map((row) => row.step);

    it("reaches READY at the same template version and artifact on a new revision, uploading the runtime again", async () => {
      const f = await fixture(true, false, false);
      const next = await startRedeploy(f);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: next });
      expect(await revisionRow(next)).toEqual({ revision: 2, template_version_id: f.version, form_artifact_id: f.artifact, worker_version_id: "worker-local" });
      expect(await revisionRow(f.revision)).toMatchObject({ revision: 1, template_version_id: f.version, form_artifact_id: f.artifact, worker_version_id: "worker-old" });
      expect(f.uploads).toHaveLength(1);
      expect(f.uploads[0]!.bindings).toContainEqual({ type: "plain_text", name: "BRAND_ID", text: f.brand });
      expect(f.network.mock.calls.some(([url]) => String(url).endsWith(`/scripts/brand-${f.brand}/assets-upload-session`))).toBe(true);
      // An upgrade syncs the existing runtime from the old revision; only a first install provisions.
      expect(f.applied).toHaveLength(1);
      expect(f.applied[0]).toMatchObject({ expected_revision_id: f.revision, target_revision_id: next });
      expect(await stepsOf(f.install)).toEqual(["validate", "save_rollback", "render", "upload_assets", "upload_script", "deploy", "attach_domains", "smoke", "sync_runtime", "receipt"]);
      expect(f.compensation).toHaveLength(0);
    });

    it("keeps a paused brand paused: the smoke expects the 503 pause page and core keeps paused", async () => {
      const f = await fixture(true);
      const next = await startRedeploy(f);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step='smoke' AND status='ok'").bind(f.install).first())
        .toEqual({ output_json: JSON.stringify({ apex_status: 503, www_status: 301 }) });
      expect(f.runtime()).toMatchObject({ paused: true, applied_revision_id: next });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: next });
    });

    it("rolls back to the previous Worker version when the smoke fails and leaves the brand live on the old revision", async () => {
      const f = await fixture(true, false, false);
      const next = await startRedeploy(f);
      f.settings.smokeFails = true;
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(f.compensation).toHaveLength(1);
      expect(f.compensation[0]).toMatchObject({ original_install_id: f.install, brand_id: f.brand, to_revision_id: f.revision });
      expect(await f.brandRow()).toEqual({ status: "installing", current_revision_id: f.revision });
      expect(f.applied).toHaveLength(0);

      await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), steps().step);
      const redeployed = f.network.mock.calls.filter(([url, init]) => String(url).endsWith(`/scripts/brand-${f.brand}/deployments`) && init?.method === "POST");
      expect(redeployed).toHaveLength(1);
      expect(JSON.parse(String(redeployed[0]![1]!.body))).toEqual({ strategy: "percentage", versions: [{ version_id: "worker-old", percentage: 100 }] });
      expect(await f.installRow()).toEqual({ status: "rolled_back" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      expect(f.runtime()).toMatchObject({ applied_revision_id: f.revision, paused: false });
      expect(await revisionRow(next)).toMatchObject({ template_version_id: f.version, form_artifact_id: f.artifact });
    });

    // A newer registered release: its own ZIP, payload 2026-01, bundle form@new.
    async function addNewForm(f: Fixture) {
      const artifact = `form-new-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,created_at,payload_version,bundle_form_version) VALUES (?,?,?,?,?,'2026-01','form@new')")
        .bind(artifact, `new${f.id}`, `${f.id}/form-new.zip`, f.id, new Date(Date.parse(now) + 1000).toISOString()).run();
      const enc = new TextEncoder();
      await env.ARTIFACTS.put(`${f.id}/form-new.zip`, zip(new Map([
        ["/_f/index.html", enc.encode('<p>Form v2</p><script src="/_f/assets/index-v2.js"></script>')],
        ["/_f/assets/index-v2.js", enc.encode("console.log('form v2')")],
      ])));
      return artifact;
    }
    async function startFormRedeploy(f: Fixture, artifact: string) {
      const next = await startRedeploy(f);
      await env.FACTORY.prepare("UPDATE brand_revisions SET form_artifact_id=? WHERE revision_id=?").bind(artifact, next).run();
      return next;
    }
    const renderedFiles = async (f: Fixture, revision: string) => unzip(new Uint8Array(await (await env.ARTIFACTS.get(`renders/${f.brand}/${revision}.zip`))!.arrayBuffer()));
    const brandConfig = (f: Fixture) => (f.uploads[0]!.bindings.find((binding) => binding.name === "BRAND_CONFIG") as { json: Record<string, unknown> }).json;

    it("moves a live brand to a newer form: renders the new ZIP, ships its version in the Worker config and syncs core", async () => {
      const f = await fixture(true, false, false);
      const artifact = await addNewForm(f);
      const next = await startFormRedeploy(f, artifact);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: next });
      expect(await revisionRow(next)).toEqual({ revision: 2, template_version_id: f.version, form_artifact_id: artifact, worker_version_id: "worker-local" });
      // The rendered assets come from the new ZIP, not the old one.
      const rendered = await renderedFiles(f, next);
      expect(DEC.decode(rendered.get("/_f/index.html")!)).toContain("Form v2");
      expect(rendered.has("/_f/assets/index-v2.js")).toBe(false);
      expect([...rendered.keys()].filter((path) => /^\/_f\/assets\/[0-9a-f]{8}_[0-9a-f]{16}\.js$/.test(path))).toHaveLength(1);
      expect(brandConfig(f)).toMatchObject({ form_version: "form@new" });
      // Core: the runtime sync carries the new bundle identity, and the lead payload version is untouched.
      expect(f.applied).toHaveLength(1);
      expect(f.applied[0]).toMatchObject({ expected_revision_id: f.revision, target_revision_id: next, initial_runtime: { form_version: "form@new" } });
      expect(f.runtime()).toMatchObject({ applied_revision_id: next, bundle_form_version: "form@new" });
      expect(await stepsOf(f.install)).toEqual(["validate", "save_rollback", "render", "upload_assets", "upload_script", "deploy", "attach_domains", "smoke", "sync_runtime", "receipt"]);
      expect(f.compensation).toHaveLength(0);
    });

    it("the same redeploy without a new artifact keeps the old form version in the Worker config and core", async () => {
      const f = await fixture(true, false, false);
      await addNewForm(f);
      await startRedeploy(f);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(brandConfig(f)).toMatchObject({ form_version: "form@old" });
      expect(f.runtime()).toMatchObject({ bundle_form_version: "form@old" });
    });

    it("fails before changing anything when the new form's ZIP is missing, leaving the old form live", async () => {
      const f = await fixture(true, false, false);
      const artifact = await addNewForm(f);
      await env.ARTIFACTS.delete(`${f.id}/form-new.zip`);
      const next = await startFormRedeploy(f, artifact);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(f.uploads).toHaveLength(0);
      expect(f.applied).toHaveLength(0);
      expect(f.runtime()).toMatchObject({ applied_revision_id: f.revision, bundle_form_version: "form@old" });
      expect(await revisionRow(next)).toMatchObject({ worker_version_id: null });
    });

    it("rolls a failed smoke back to the old Worker version and the old form version", async () => {
      const f = await fixture(true, false, false);
      const artifact = await addNewForm(f);
      const next = await startFormRedeploy(f, artifact);
      f.settings.smokeFails = true;
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(f.compensation).toHaveLength(1);
      expect(f.compensation[0]).toMatchObject({ original_install_id: f.install, to_revision_id: f.revision });
      // Core was not synced to the new form: the sync step comes after the smoke test.
      expect(f.applied).toHaveLength(0);
      expect(f.runtime()).toMatchObject({ bundle_form_version: "form@old" });

      await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), steps().step);
      const redeployed = f.network.mock.calls.filter(([url, init]) => String(url).endsWith(`/scripts/brand-${f.brand}/deployments`) && init?.method === "POST");
      expect(JSON.parse(String(redeployed[0]![1]!.body))).toEqual({ strategy: "percentage", versions: [{ version_id: "worker-old", percentage: 100 }] });
      expect(await f.installRow()).toEqual({ status: "rolled_back" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      expect(f.runtime()).toMatchObject({ applied_revision_id: f.revision, bundle_form_version: "form@old" });
      expect(f.applied.at(-1)).toMatchObject({ target_revision_id: f.revision, bundle_form_version: "form@old" });
      expect(await revisionRow(f.revision)).toMatchObject({ form_artifact_id: f.artifact });
    });

    it("a manual rollback after a successful form change returns to the previous revision, its Worker version and its form version", async () => {
      const f = await fixture(true, false, false);
      const artifact = await addNewForm(f);
      const next = await startFormRedeploy(f, artifact);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(f.runtime()).toMatchObject({ applied_revision_id: next, bundle_form_version: "form@new" });

      const rollbackId = `rollback-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at) VALUES (?,?,'rollback','queued',?,?,'owner','owner',?)")
        .bind(rollbackId, f.brand, next, f.revision, now).run();
      await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
        event({ install_id: rollbackId, brand_id: f.brand, to_revision_id: f.revision }), steps().step);
      const deployments = f.network.mock.calls.filter(([url, init]) => String(url).endsWith(`/scripts/brand-${f.brand}/deployments`) && init?.method === "POST");
      expect(JSON.parse(String(deployments.at(-1)![1]!.body))).toEqual({ strategy: "percentage", versions: [{ version_id: "worker-old", percentage: 100 }] });
      expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(rollbackId).first()).toEqual({ status: "rolled_back" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      expect(f.runtime()).toMatchObject({ applied_revision_id: f.revision, bundle_form_version: "form@old" });
      // The form change stays on its own revision; the old revision still names the old artifact.
      expect(await revisionRow(f.revision)).toMatchObject({ form_artifact_id: f.artifact });
      expect(await revisionRow(next)).toMatchObject({ form_artifact_id: artifact });
    });
  });

  // Cloudflare creates the DNS record of an attached Custom Domain itself, so the DNS preflight
  // must tell the brand's own record from a foreign one on first installs and on upgrades alike.
  // sync_runtime runs on every install: a first install copies the draft's ads routing into Core and every install
  // makes sure the brand has its own listmonk list (FUS-358).
  describe("sync_runtime: ads routing and the brand's listmonk list", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const ads = { google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A", microsoft_ads_account: "12345678" };
    const withProfile = (f: Fixture, revision = f.revision) => env.FACTORY.prepare("UPDATE brand_revisions SET config_json=? WHERE revision_id=?")
      .bind(JSON.stringify({ keyword_default: "Quick Loan", profile: { ads } }), revision).run();
    const syncReceipt = async (installId: string) => {
      const row = await env.FACTORY.prepare("SELECT status,output_json FROM install_receipts WHERE install_id=? AND step='sync_runtime'").bind(installId).first<{ status: string; output_json: string }>();
      return row && { status: row.status, output: JSON.parse(row.output_json) as Record<string, unknown> };
    };

    it("a first install sends the draft's Google Ads route to Core (never the Microsoft account) and creates the list", async () => {
      const f = await fixture();
      await withProfile(f);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(f.adsRouted).toEqual([{ install_id: f.install, brand_id: f.brand, account: "test",
        ads: { google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A" } }]);
      expect(f.listCalls).toEqual([{ install_id: f.install, brand_id: f.brand, account: "test" }]);
      expect(await syncReceipt(f.install)).toEqual({ status: "ok", output: {
        ads_routing: { copied: ["google_ads_account", "google_conversion_action", "adkit_project"], kept: [] },
        mailing_list: { state: "created", list_id: 900 },
      } });
      // One provision plus no second runtime apply: a first install applies in provision_runtime only.
      expect(f.applied).toHaveLength(1);
    });

    it("a first install without profile.ads makes no ads routing call", async () => {
      const f = await fixture();
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(f.adsRouted).toEqual([]);
      expect(f.listCalls).toHaveLength(1);
    });

    it("an upgrade of a live brand never copies ads routing, so a route the owner cleared stays clear", async () => {
      const f = await fixture(true, false, false);
      const next = `upgrade-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) SELECT ?,brand_id,2,template_version_id,form_artifact_id,config_json,'owner',? FROM brand_revisions WHERE revision_id=?")
        .bind(next, now, f.revision).run();
      await withProfile(f, next);
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(f.adsRouted).toEqual([]);
      expect(f.listCalls).toHaveLength(1);
      expect((await syncReceipt(f.install))!.output).toMatchObject({ state: "applied", applied_revision_id: next, mailing_list: { state: "created", list_id: 900 } });
    });

    it("a listmonk failure fails sync_runtime with a clear message after its retries and queues the rollback", async () => {
      const f = await fixture();
      f.settings.listHttp.push(...Array(REMOTE_STEP_RETRY_CONFIG.retries.limit + 1).fill(502));
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await syncReceipt(f.install)).toEqual({ status: "failed", output: { error: "Mailing list: listmonk list was not created: listmonk POST list failed: 502 (502)" } });
      expect(f.listCalls).toHaveLength(REMOTE_STEP_RETRY_CONFIG.retries.limit + 1);
      expect(f.compensation).toHaveLength(1);
      expect(await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first())
        .toEqual({ error: "Error: Mailing list: listmonk list was not created: listmonk POST list failed: 502 (502)" });
    });

    it("a transient listmonk failure retries the step and the brand gets exactly one list", async () => {
      const f = await fixture();
      f.settings.listHttp.push(502);
      const s = steps();
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(s.attempts.get("sync_runtime")).toBe(2);
      expect((await syncReceipt(f.install))!.output).toMatchObject({ mailing_list: { state: "created", list_id: 900 } });
    });

    it("a re-run of sync_runtime after its work succeeded finds the stored list and adds none", async () => {
      const f = await fixture();
      const s = steps();
      let failed = false;
      // The step's ok receipt write fails once, so the engine re-runs the whole step.
      const real = f.bindings.FACTORY;
      (f.bindings as unknown as { FACTORY: unknown }).FACTORY = new Proxy(real, { get: (t, p) => p === "prepare" ? (sql: string) => {
        const statement = t.prepare(sql);
        if (failed || !/^INSERT INTO install_receipts/.test(sql)) return statement;
        return new Proxy(statement, { get: (target, prop) => prop === "bind" ? (...args: unknown[]) => {
          const bound = target.bind(...args);
          if (!(args.includes("sync_runtime") && args.includes("ok"))) return bound;
          failed = true;
          return new Proxy(bound, { get: (b, q) => q === "run" ? async () => { throw new Error("D1_ERROR: transient receipt write"); } : Reflect.get(b, q, b) });
        } : Reflect.get(target, prop, target) });
      } : Reflect.get(t, p, t) });
      await runInstall(f, s);
      expect(failed).toBe(true);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(s.attempts.get("sync_runtime")).toBe(2);
      expect((await syncReceipt(f.install))!.output).toMatchObject({ mailing_list: { state: "stored", list_id: 900 } });
    });
  });

  describe("DNS preflight in validate", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function startUpgrade(f: Fixture) {
      const next = `upgrade-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
      return next;
    }
    const validateReceipt = (installId: string) => env.FACTORY.prepare("SELECT status,output_json FROM install_receipts WHERE install_id=? AND step='validate'")
      .bind(installId).first<{ status: string; output_json: string }>();
    const compensationRows = (f: Fixture) => env.FACTORY.prepare("SELECT COUNT(*) AS n FROM installs WHERE brand_id=? AND kind='rollback'").bind(f.brand).first<{ n: number }>();

    it("passes validate and reaches READY on an upgrade of an apex brand whose own apex and www records are in the zone", async () => {
      const f = await fixture(true, false, false);
      const next = await startUpgrade(f);
      expect([...f.domains.keys()]).toEqual([`${f.id}.example`, `www.${f.id}.example`]);
      await runInstall(f);
      expect(await validateReceipt(f.install)).toMatchObject({ status: "ok" });
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: next });
      expect(f.compensation).toHaveLength(0);
    });

    it("passes validate on an upgrade of a subdomain brand whose own record is in the zone", async () => {
      const f = await fixture(true, true, false);
      const next = await startUpgrade(f);
      expect([...f.domains.keys()]).toEqual([`${f.id}.sub.example`]);
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: next });
    });

    it("asks the account Custom Domains list for the brand script before it trusts a record", async () => {
      const f = await fixture(true, true, false);
      await startUpgrade(f);
      await runInstall(f);
      const listed = f.network.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), method: init?.method ?? "GET" }))
        .filter(({ url, method }) => url.pathname.endsWith("/workers/domains") && method === "GET");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.url.searchParams.get("service")).toBe(`brand-${f.brand}`);
      expect(listed[0]!.url.searchParams.get("zone_id")).toBe("zone-local");
    });

    it("does not list Custom Domains when the zone has no record on the brand hostnames", async () => {
      const f = await fixture();
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith("/workers/domains") && (init?.method ?? "GET") === "GET")).toBe(false);
    });

    it("still blocks a first install on a foreign record, with the same message", async () => {
      const f = await fixture();
      f.settings.foreignDns.push({ type: "A", name: `${f.id}.example` });
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await validateReceipt(f.install)).toEqual({ status: "failed", output_json: JSON.stringify({ error: `Existing DNS records block Custom Domain attach: A ${f.id}.example` }) });
      expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
      expect(f.compensation).toHaveLength(0);
    });

    it("blocks a foreign record on www even when the apex record is the brand's own", async () => {
      const f = await fixture(true, false, false);
      await startUpgrade(f);
      f.domains.delete(`www.${f.id}.example`);
      f.settings.foreignDns.push({ type: "A", name: `www.${f.id}.example` });
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(JSON.parse((await validateReceipt(f.install))!.output_json)).toEqual({ error: `Existing DNS records block Custom Domain attach: A www.${f.id}.example` });
    });

    it("blocks an upgrade whose domain was detached and then got a foreign record", async () => {
      const f = await fixture(true, true, false);
      await startUpgrade(f);
      f.domains.clear();
      f.settings.foreignDns.push({ type: "A", name: `${f.id}.sub.example` });
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(JSON.parse((await validateReceipt(f.install))!.output_json)).toEqual({ error: `Existing DNS records block Custom Domain attach: A ${f.id}.sub.example` });
    });

    it("blocks an upgrade whose hostname is attached to another script", async () => {
      const f = await fixture(true, true, false);
      await startUpgrade(f);
      f.domains.set(`${f.id}.sub.example`, "brand-someone-else");
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(JSON.parse((await validateReceipt(f.install))!.output_json)).toEqual({ error: `Existing DNS records block Custom Domain attach: AAAA ${f.id}.sub.example` });
    });

    // Bug 2 of FUS-345: a validate failure on an upgrade has mutated nothing.
    it("ends a validate failure on an upgrade failed, with the brand live on its old revision and nothing to roll back", async () => {
      const f = await fixture(true, true, false);
      await startUpgrade(f);
      f.settings.foreignDns.push({ type: "A", name: `${f.id}.sub.example` });
      f.domains.clear();
      const s = steps();
      await runInstall(f, s);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      expect(f.compensation).toHaveLength(0);
      expect(await compensationRows(f)).toEqual({ n: 0 });
      expect(f.uploads).toHaveLength(0);
      expect(f.applied).toHaveLength(0);
      expect(await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step='rollback'").bind(f.install).first())
        .toEqual({ output_json: JSON.stringify({ compensation: "not_required" }) });
      const row = await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first<{ error: string }>();
      expect(row!.error).toContain("Existing DNS records block Custom Domain attach");
      // A DNS conflict is deterministic: validate runs once and the install settles at once.
      expect(s.attempts.get("validate")).toBe(1);
      expect(s.failures.get("validate")).toBeInstanceOf(NonRetryableError);
      expect(s.configs.get("validate")).toEqual({ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "60 seconds" });
    });

    it("lets the owner retry that failed upgrade once the foreign record is gone", async () => {
      const f = await fixture(true, true, false);
      await startUpgrade(f);
      f.settings.foreignDns.push({ type: "A", name: `${f.id}.sub.example` });
      f.domains.clear();
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      const retryId = await queueInstallRetry(env.FACTORY, f.install);
      expect(retryId).not.toBeNull();
      f.settings.foreignDns.length = 0;
      f.domains.set(`${f.id}.sub.example`, `brand-${f.brand}`);
      await runInstall({ ...f, params: { ...f.params, install_id: retryId! } });
      expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(retryId).first()).toEqual({ status: "ready" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.params.revision_id });
    });
  });

  // FUS-345: a deterministic validate failure must settle at once. Cloudflare Workflows retries a
  // step that throws a plain Error, and the harness runs the configured retries without waiting.
  describe("validate fails fast", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const validateReceipt = (installId: string) => env.FACTORY.prepare("SELECT status,output_json FROM install_receipts WHERE install_id=? AND step='validate'")
      .bind(installId).first<{ status: string; output_json: string }>();
    const compensationRows = (f: Fixture) => env.FACTORY.prepare("SELECT COUNT(*) AS n FROM installs WHERE brand_id=? AND kind='rollback'").bind(f.brand).first<{ n: number }>();

    const deterministic: Array<[string, (f: Fixture) => Promise<void> | void, string]> = [
      ["revision not found", (f) => { f.params.revision_id = "missing-revision"; }, "Revision missing-revision not found"],
      // A sealed template version and form payload_version are immutable in D1, so those checks cannot be reached here.
      ["revision config overriding tenant defaults", async (f) => { await env.FACTORY.prepare("UPDATE brand_revisions SET config_json='{\"aid\":\"1\"}' WHERE revision_id=?").bind(f.revision).run(); }, "Revision cannot override tenant-owned runtime defaults"],
      ["form artifact r2 key missing", async (f) => { await env.FACTORY.prepare("UPDATE form_artifacts SET r2_key='' WHERE form_artifact_id=?").bind(f.artifact).run(); }, "Form artifact is missing"],
      ["unparsable amount buckets setting", (f) => { (f.bindings as unknown as Record<string, string>).DEFAULT_AMOUNT_BUCKETS = "["; }, "JSON"],
      ["zone not found", (f) => { f.settings.zoneName = "other.example"; }, "Zone not found for domain"],
      ["zone not active", (f) => { f.settings.zoneStatus = "pending"; }, "is not active (status=pending)"],
      ["DNS conflict", (f) => { f.settings.foreignDns.push({ type: "AAAA", name: `${f.id}.example` }); }, "Existing DNS records block Custom Domain attach"],
      ["Cloudflare 401", (f) => { f.settings.zoneHttp.push(401); }, "HTTP 401"],
      ["Cloudflare 403", (f) => { f.settings.zoneHttp.push(403); }, "HTTP 403"],
      ["Core 401", (f) => { f.settings.stateHttp.push(401); }, "Core lifecycle request failed (401)"],
    ];

    it.each(deterministic)("runs validate once and ends failed on %s", async (_name, arrange, text) => {
      const f = await fixture();
      await arrange(f);
      const s = steps();
      await runInstall(f, s);
      expect(s.failures.get("validate")).toBeInstanceOf(NonRetryableError);
      expect((s.failures.get("validate") as Error).message).toContain(text);
      expect(s.attempts.get("validate")).toBe(1);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await f.brandRow()).toEqual({ status: "failed", current_revision_id: null });
      expect(JSON.parse((await validateReceipt(f.install))!.output_json).error).toContain(text);
      expect(f.compensation).toHaveLength(0);
      expect(await compensationRows(f)).toEqual({ n: 0 });
      expect(await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step='rollback'").bind(f.install).first())
        .toEqual({ output_json: JSON.stringify({ compensation: "not_required" }) });
      const row = await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first<{ error: string }>();
      expect(row!.error).toBe(`Error: ${(s.failures.get("validate") as Error).message}`);
      expect(row!.error).toContain(text);
    });

    it("keeps an upgrade live on its old revision when validate fails fast", async () => {
      const f = await fixture(true, true, false);
      const next = `upgrade-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
      f.settings.zoneHttp.push(403);
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get("validate")).toBe(1);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      expect(f.compensation).toHaveLength(0);
    });

    it.each([
      ["Cloudflare 502 on the zone lookup", (f: Fixture) => { f.settings.zoneHttp.push(502); }],
      ["Cloudflare 429 on the zone lookup", (f: Fixture) => { f.settings.zoneHttp.push(429); }],
      ["Core 503 on runtime-state", (f: Fixture) => { f.settings.stateHttp.push(503); }],
      ["Core 429 on runtime-state", (f: Fixture) => { f.settings.stateHttp.push(429); }],
      ["Workers Domains list 500", (f: Fixture) => {
        f.settings.foreignDns.push({ type: "A", name: `www.${f.id}.example` });
        f.domains.set(`www.${f.id}.example`, `brand-${f.brand}`);
        f.settings.domainsHttp.push(500);
      }],
    ])("retries a transient failure (%s) and reaches READY", async (_name, arrange) => {
      const f = await fixture();
      arrange(f);
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get("validate")).toBe(2);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await validateReceipt(f.install)).toMatchObject({ status: "ok" });
    });

    it("gives up after the configured retries on a persistent transient failure, with a plain Error", async () => {
      const f = await fixture();
      f.settings.zoneHttp.push(502, 502, 502, 502, 502);
      const s = steps();
      await runInstall(f, s);
      expect(s.failures.get("validate")).not.toBeInstanceOf(NonRetryableError);
      expect(s.attempts.get("validate")).toBe(4);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(JSON.parse((await validateReceipt(f.install))!.output_json).error).toContain("HTTP 502");
    });

    const okReceipts = (f: Fixture) => env.FACTORY.prepare("SELECT COUNT(*) AS n FROM install_receipts WHERE install_id=? AND step='validate' AND status='ok'")
      .bind(f.install).first<{ n: number }>();
    const allValidateReceipts = (f: Fixture) => env.FACTORY.prepare("SELECT COUNT(*) AS n FROM install_receipts WHERE install_id=? AND step='validate'")
      .bind(f.install).first<{ n: number }>();

    it.each(["read", "write"] as const)("retries a transient D1 failure on the validate receipt %s and reaches READY with one ok receipt", async (kind) => {
      const f = await fixture();
      const armed = failReceiptD1Once(f, "validate", kind);
      const s = steps();
      await runInstall(f, s);
      expect(armed()).toBe(false);
      expect(s.attempts.get("validate")).toBe(2);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await okReceipts(f)).toEqual({ n: 1 });
      expect(await allValidateReceipts(f)).toEqual({ n: 1 });
    });

    it("writes exactly one failed receipt, after one run, for a deterministic failure", async () => {
      const f = await fixture();
      f.settings.zoneName = "other.example";
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get("validate")).toBe(1);
      expect(await allValidateReceipts(f)).toEqual({ n: 1 });
      expect((await validateReceipt(f.install))!.status).toBe("failed");
    });

    it("re-runs validate when the owner retries a failed install", async () => {
      const f = await fixture();
      f.settings.zoneName = "other.example";
      await runInstall(f);
      expect(await f.installRow()).toEqual({ status: "failed" });
      const retryId = await queueInstallRetry(env.FACTORY, f.install);
      expect(retryId).not.toBeNull();
      f.settings.zoneName = `${f.id}.example`;
      const s = steps();
      await runInstall({ ...f, params: { ...f.params, install_id: retryId! } }, s);
      expect(s.attempts.get("validate")).toBe(1);
      expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(retryId).first()).toEqual({ status: "ready" });
      expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM install_receipts WHERE install_id=? AND step='validate' AND status='ok'").bind(retryId).first()).toEqual({ n: 1 });
    });

    it("stores no failed receipt for an attempt that a retry then fixes", async () => {
      const f = await fixture();
      f.settings.zoneHttp.push(500);
      const s = steps();
      let receiptDuringRetry: unknown = "unset";
      s.hooks.retry = async () => { receiptDuringRetry = await validateReceipt(f.install); };
      await runInstall(f, s);
      expect(receiptDuringRetry).toBeNull();
      expect(await validateReceipt(f.install)).toMatchObject({ status: "ok" });
    });
  });

  // FUS-345: every install step keeps its Workflow retries. A failed receipt is written only when no retry is left, so a transient
  // failure is retried for real, a failure that the same input always repeats settles at once, and a step whose work succeeded but
  // whose ok receipt could not be written runs again without repeating a mutation that is not idempotent.
  describe("install steps keep their retries", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    type Match = (url: URL, init?: RequestInit) => boolean;
    const urlOf = (input: string | Request | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const cf = {
      session: ((url) => url.pathname.endsWith("/assets-upload-session")) as Match,
      script: ((url, init) => init?.method === "PUT" && /\/workers\/scripts\/brand-[^/]+$/.test(url.pathname)) as Match,
      deployments: ((url, init) => init?.method === "GET" && url.pathname.endsWith("/deployments")) as Match,
      domain: ((url, init) => init?.method === "PUT" && url.pathname.endsWith("/workers/domains")) as Match,
    };
    const callsTo = (f: Fixture, match: Match) => f.network.mock.calls.filter(([input, init]) => match(urlOf(input), init)).length;
    const receipts = async (f: Fixture, step: string, status: "ok" | "failed") => (await env.FACTORY
      .prepare("SELECT COUNT(*) AS n FROM install_receipts WHERE install_id=? AND step=? AND status=?").bind(f.install, step, status).first<{ n: number }>())!.n;
    const receiptOutput = async (f: Fixture, step: string) => JSON.parse((await env.FACTORY
      .prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step=?").bind(f.install, step).first<{ output_json: string }>())!.output_json) as Record<string, unknown>;
    const installError = async (f: Fixture) => (await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first<{ error: string }>())!.error;
    async function startUpgrade(f: Fixture) {
      const next = `upgrade-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
      return next;
    }

    // A Cloudflare API answer with `status` for the first `times` requests that `match`.
    function failCloudflare(f: Fixture, match: Match, status: number, times = 1) {
      const real = f.network;
      let left = times;
      vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
        if (left > 0 && match(urlOf(input), init)) {
          left--;
          return Response.json({ success: false, errors: [{ code: 9999, message: "injected failure" }] }, { status });
        }
        return real(input, init);
      });
    }
    // A D1 error on the first `times` statements whose SQL matches.
    function failD1(f: Fixture, sql: RegExp, times = 1) {
      const real = f.bindings.FACTORY;
      let left = times;
      const prepare = (text: string) => {
        const statement = real.prepare(text);
        if (left <= 0 || !sql.test(text)) return statement;
        return new Proxy(statement, { get: (target, prop) => prop === "bind"
          ? (...args: unknown[]) => new Proxy(target.bind(...args), { get: (bound, p) => (p === "first" || p === "run" || p === "all") && left > 0
            ? async () => { left--; throw new Error("D1_ERROR: injected failure"); }
            : Reflect.get(bound, p, bound) })
          : Reflect.get(target, prop, target) });
      };
      (f.bindings as unknown as { FACTORY: unknown }).FACTORY = new Proxy(real, { get: (t, p) => p === "prepare" ? prepare : Reflect.get(t, p, t) });
    }
    // An R2 error on the first `times` writes of a render.
    function failRenderWrite(f: Fixture, times = 1) {
      const real = f.bindings.ARTIFACTS;
      let left = times;
      (f.bindings as unknown as { ARTIFACTS: unknown }).ARTIFACTS = new Proxy(real, { get: (t, p) => {
        const member = Reflect.get(t, p, t) as unknown;
        if (typeof member !== "function") return member;
        if (p !== "put") return member.bind(t);
        return async (key: string, ...rest: unknown[]) => {
          if (left > 0 && key.startsWith("renders/")) { left--; throw new Error("R2 internal error"); }
          return (member as (...args: unknown[]) => Promise<unknown>).call(t, key, ...rest);
        };
      } });
    }

    const transient: Array<[step: string, live: boolean, arrange: (f: Fixture) => void]> = [
      ["save_rollback", false, (f) => failD1(f, /^UPDATE installs SET rollback_record_json/)],
      ["render", false, (f) => failRenderWrite(f)],
      ["upload_assets", false, (f) => failCloudflare(f, cf.session, 502)],
      ["upload_script", false, (f) => failCloudflare(f, cf.script, 500)],
      ["provision_runtime", false, (f) => { f.settings.applyHttp.push(503); }],
      ["deploy", false, (f) => failCloudflare(f, cf.deployments, 502)],
      ["attach_domains", false, (f) => failCloudflare(f, cf.domain, 429)],
      ["sync_runtime", true, (f) => { f.settings.applyHttp.push(503); }],
      ["receipt", false, (f) => failD1(f, /^UPDATE brands SET status = 'live'/)],
    ];
    async function prepared(live: boolean, arrange: (f: Fixture) => void | Promise<void>) {
      const f = await fixture(live, false, false);
      if (live) await startUpgrade(f);
      await arrange(f);
      return f;
    }

    it.each(transient)("retries a transient failure in %s and reaches READY with one ok receipt, no failed one and no compensation", async (step, live, arrange) => {
      const f = await prepared(live, arrange);
      const s = steps();
      let receiptDuringRetry: unknown = "unset";
      s.hooks.retry = async (name) => { if (name === step) receiptDuringRetry = await receipts(f, step, "failed"); };
      await runInstall(f, s);
      expect(s.attempts.get(step)).toBe(2);
      expect(receiptDuringRetry).toBe(0);
      expect(s.configs.get(step)?.retries?.limit).toBeGreaterThan(0);
      expect(await f.installRow()).toEqual({ status: "ready" });
      expect(await receipts(f, step, "ok")).toBe(1);
      expect(await receipts(f, step, "failed")).toBe(0);
      expect(f.compensation).toHaveLength(0);
      expect((await f.brandRow() as { status: string }).status).toBe("live");
    });

    const deterministic: Array<[step: string, live: boolean, arrange: (f: Fixture) => void | Promise<void>, text: string, compensates: boolean]> = [
      ["render", false, async (f) => { await env.ARTIFACTS.delete(`${f.id}/site.zip`); }, "R2 object not found", false],
      ["upload_assets", false, (f) => failCloudflare(f, cf.session, 403, Infinity), "HTTP 403", true],
      ["upload_script", false, (f) => failCloudflare(f, cf.script, 400, Infinity), "HTTP 400", true],
      ["provision_runtime", false, (f) => { f.settings.applyHttp.push(403); }, "Core lifecycle request failed (403)", true],
      ["deploy", false, (f) => failCloudflare(f, cf.deployments, 403, Infinity), "HTTP 403", true],
      ["attach_domains", false, (f) => failCloudflare(f, cf.domain, 400, Infinity), "HTTP 400", true],
      ["sync_runtime", true, (f) => { f.settings.applyHttp.push(409); }, "Core lifecycle request failed (409)", true],
    ];
    it.each(deterministic)("settles at once on a deterministic failure in %s: one failed receipt, no retry, compensation as before", async (step, live, arrange, text, compensates) => {
      const f = await prepared(live, arrange);
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get(step)).toBe(1);
      expect(s.failures.get(step)).toBeInstanceOf(NonRetryableError);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(await receipts(f, step, "failed")).toBe(1);
      expect(await receipts(f, step, "ok")).toBe(0);
      const message = (await receiptOutput(f, step)).error as string;
      expect(message).toContain(text);
      expect(message).not.toContain("NonRetryableError");
      expect(await installError(f)).toBe(`Error: ${message}`);
      expect(f.compensation).toHaveLength(compensates ? 1 : 0);
      if (!compensates) expect(await receiptOutput(f, "rollback")).toEqual({ compensation: "not_required" });
    });

    it.each([
      ["upload_script", (f: Fixture) => failCloudflare(f, cf.script, 502, Infinity), true],
      ["save_rollback", (f: Fixture) => failD1(f, /^UPDATE installs SET rollback_record_json/, Infinity), false],
    ] as const)("gives up on a persistent transient failure in %s after its configured retries, with one failed receipt", async (step, arrange, compensates) => {
      const f = await prepared(false, arrange);
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get(step)).toBe(s.configs.get(step)!.retries!.limit! + 1);
      expect(s.failures.get(step)).not.toBeInstanceOf(NonRetryableError);
      expect(await receipts(f, step, "failed")).toBe(1);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(f.compensation).toHaveLength(compensates ? 1 : 0);
    });

    it("keeps compensation after a retried upload_script when the smoke then fails", async () => {
      const f = await prepared(false, (g) => { failCloudflare(g, cf.script, 500); g.settings.smokeFails = true; });
      const s = steps();
      await runInstall(f, s);
      expect(s.attempts.get("upload_script")).toBe(2);
      expect(await f.installRow()).toEqual({ status: "failed" });
      expect(f.compensation).toHaveLength(1);
      expect(await f.brandRow()).toMatchObject({ status: "installing" });
    });

    describe("a failed ok receipt write after the work succeeded", () => {
      async function run(step: string, live: boolean) {
        const f = await prepared(live, () => {});
        const armed = failReceiptD1Once(f, step, "write");
        const s = steps();
        await runInstall(f, s);
        expect(armed()).toBe(false);
        expect(s.attempts.get(step)).toBe(2);
        expect(await f.installRow()).toEqual({ status: "ready" });
        expect(await receipts(f, step, "ok")).toBe(1);
        expect(await receipts(f, step, "failed")).toBe(0);
        expect(f.compensation).toHaveLength(0);
        return f;
      }

      it.each(["save_rollback", "render", "receipt"])("re-runs %s, which only writes D1 rows and one R2 key with the same value", async (step) => {
        const f = await run(step, false);
        expect(await env.FACTORY.prepare("SELECT rollback_record_json FROM installs WHERE install_id=?").bind(f.install).first()).toEqual({ rollback_record_json: '{"previous_revision_id":null}' });
        expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      });
      it("re-runs upload_assets: Cloudflare takes assets by content hash, so a second session uploads nothing new", async () => {
        const f = await run("upload_assets", false);
        expect(callsTo(f, cf.session)).toBe(2);
      });
      it("re-runs upload_script, which puts the same script again: one more Worker version with identical content", async () => {
        const f = await run("upload_script", false);
        expect(f.uploads).toHaveLength(2);
        expect(f.uploads[1]).toEqual(f.uploads[0]);
      });
      it("re-runs deploy, which only reads the latest deployment and sets the version id again", async () => {
        const f = await run("deploy", false);
        expect(callsTo(f, cf.deployments)).toBe(2);
        expect(await env.FACTORY.prepare("SELECT worker_version_id FROM brand_revisions WHERE revision_id=?").bind(f.revision).first()).toEqual({ worker_version_id: "worker-local" });
      });
      it("re-runs attach_domains, which puts the same hostnames on the same script again", async () => {
        const f = await run("attach_domains", false);
        expect(callsTo(f, cf.domain)).toBe(4);
        expect([...f.domains]).toEqual([[f.settings.zoneName, `brand-${f.brand}`], [`www.${f.settings.zoneName}`, `brand-${f.brand}`]]);
      });
      it.each([["provision_runtime", false], ["sync_runtime", true]] as const)("re-runs %s: Core replays the same install_id as a noop and changes nothing", async (step, live) => {
        const f = await run(step, live);
        expect(f.applied).toHaveLength(2);
        expect(f.counters.applyEffects).toBe(1);
        expect(f.runtime()).toMatchObject({ applied_revision_id: f.params.revision_id, last_lifecycle_install_id: f.install });
        expect(await receiptOutput(f, step)).toMatchObject({ state: "noop" });
      });
    });

    describe("compensation dispatch", () => {
      const evidence = async (f: Fixture) => { try { return JSON.parse(await installError(f)); } catch { return null; } };

      it("retries a transient dispatch failure and records no recovery evidence", async () => {
        const f = await fixture();
        f.settings.smokeFails = true;
        f.settings.dispatchFailures = 1;
        const s = steps();
        await runInstall(f, s);
        expect(s.attempts.get("rollback")).toBe(2);
        expect(f.compensation).toHaveLength(1);
        expect(await receipts(f, "rollback", "ok")).toBe(1);
        expect(await receipts(f, "rollback", "failed")).toBe(0);
        expect(await evidence(f)).toBeNull();
        expect(await f.brandRow()).toMatchObject({ status: "installing" });
      });

      it("does not dispatch twice when the dispatch worked but its ok receipt could not be written", async () => {
        const f = await fixture();
        f.settings.smokeFails = true;
        const armed = failReceiptD1Once(f, "rollback", "write");
        const s = steps();
        await runInstall(f, s);
        expect(armed()).toBe(false);
        expect(s.attempts.get("rollback")).toBe(2);
        expect(f.compensation).toHaveLength(1);
        expect(await receipts(f, "rollback", "ok")).toBe(1);
        expect(await receiptOutput(f, "rollback")).toEqual({ compensation_install_id: `compensate-${f.install}`, triggered_rollback: "workflow_started" });
        expect(await evidence(f)).toBeNull();
        expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM installs WHERE brand_id=? AND kind='rollback'").bind(f.brand).first()).toEqual({ n: 1 });
      });

      it("records the recovery evidence once, after the last attempt", async () => {
        const f = await fixture();
        f.settings.smokeFails = true;
        f.settings.dispatchFails = true;
        const s = steps();
        s.hooks.retry = async () => { expect(await evidence(f)).toBeNull(); };
        await expect(runInstall(f, s)).rejects.toThrow("compensation dispatch unavailable");
        expect(s.attempts.get("rollback")).toBe(s.configs.get("rollback")!.retries!.limit! + 1);
        expect(await evidence(f)).toMatchObject({ recovery_required: true, original_install_id: f.install });
        expect(await receipts(f, "rollback", "failed")).toBe(1);
        expect(await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='install.compensation_failed' AND entity_id=?").bind(f.install).first()).toEqual({ n: 1 });
      });

      it("settles at once on a rollback record that cannot be parsed", async () => {
        const f = await fixture();
        f.settings.smokeFails = true;
        const s = steps();
        s.hooks.before = async (name) => { if (name === "rollback") await env.FACTORY.prepare("UPDATE installs SET rollback_record_json='{' WHERE install_id=?").bind(f.install).run(); };
        await expect(runInstall(f, s)).rejects.toThrow();
        expect(s.attempts.get("rollback")).toBe(1);
        expect(s.failures.get("rollback")).toBeInstanceOf(NonRetryableError);
        expect(await receipts(f, "rollback", "failed")).toBe(1);
        expect(f.compensation).toHaveLength(0);
      });
    });

    // FUS-345: rollback.ts and upgrade-all.ts follow the install pattern. The rollback Workflow reuses the install Workflow's
    // receipt rule, retry configs and fail-fast classes; upgrade-all has no receipts but dispatches installs with deterministic ids.
    describe("the rollback Workflow", () => {
      const deployPost: Match = (url, init) => init?.method === "POST" && url.pathname.endsWith("/deployments");
      const deleted: Match = (url, init) => init?.method === "DELETE" && url.pathname.includes("/workers/domains/");
      const lockedBrand = async (f: Fixture) => (await f.brandRow() as { status: string }).status === "installing";
      const rollbackRun = (f: Fixture, payload: RollbackParams, s = steps()) =>
        RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(payload), s.step);
      // A manual rollback of a live brand: onto its own revision ("revision") or, as after a first install, to no revision ("first").
      async function manual(to: "revision" | "first", arrange: (f: Fixture) => void | Promise<void> = () => {}) {
        const f = await fixture(true, false, false);
        await env.FACTORY.prepare("UPDATE installs SET kind='rollback' WHERE install_id=?").bind(f.install).run();
        await arrange(f);
        const payload: RollbackParams = { install_id: f.install, brand_id: f.brand, to_revision_id: to === "revision" ? f.revision : null };
        return { f, payload };
      }

      const transientRollback: Array<[step: string, to: "revision" | "first", arrange: (f: Fixture) => void]> = [
        ["validate", "revision", (f) => { f.settings.zoneHttp.push(502); }],
        ["deploy", "revision", (f) => failCloudflare(f, deployPost, 502)],
        ["sync_runtime", "revision", (f) => { f.settings.applyHttp.push(503); }],
        ["attach_domains", "revision", (f) => failCloudflare(f, cf.domain, 429)],
        ["receipt", "revision", (f) => failD1(f, /^UPDATE brands SET status = 'live'/)],
        ["attach_domains", "first", (f) => { f.settings.domainsHttp.push(502); }],
        ["sync_runtime", "first", (f) => { f.settings.applyHttp.push(503); }],
        ["receipt", "first", (f) => failD1(f, /^UPDATE brands SET status = 'failed'/)],
      ];
      it.each(transientRollback)("retries a transient failure in %s (%s) and finishes with one ok receipt, no failed one and no recovery evidence", async (step, to, arrange) => {
        const { f, payload } = await manual(to, arrange);
        const s = steps();
        let receiptDuringRetry: unknown = "unset";
        s.hooks.retry = async (name) => { if (name === step) receiptDuringRetry = await receipts(f, step, "failed"); };
        await rollbackRun(f, payload, s);
        expect(s.attempts.get(step)).toBe(2);
        expect(receiptDuringRetry).toBe(0);
        expect(s.configs.get(step)?.retries?.limit).toBeGreaterThan(0);
        expect(await f.installRow()).toEqual({ status: "rolled_back" });
        expect(await receipts(f, step, "ok")).toBe(1);
        expect(await receipts(f, step, "failed")).toBe(0);
        expect(await installError(f)).toBeNull();
        expect(await lockedBrand(f)).toBe(false);
        expect(await f.brandRow()).toEqual(to === "revision" ? { status: "live", current_revision_id: f.revision } : { status: "failed", current_revision_id: null });
      });

      const deterministicRollback: Array<[step: string, to: "revision" | "first", arrange: (f: Fixture) => void | Promise<void>, text: string]> = [
        ["validate", "revision", (f) => { f.settings.zoneName = "other.example"; }, "Zone not found for domain"],
        ["validate", "revision", (f) => { f.settings.zoneHttp.push(403); }, "HTTP 403"],
        ["deploy", "revision", (f) => failCloudflare(f, deployPost, 403, Infinity), "HTTP 403"],
        ["deploy", "revision", async (f) => { await env.FACTORY.prepare("UPDATE brand_revisions SET worker_version_id=NULL WHERE revision_id=?").bind(f.revision).run(); }, "is not a deployed revision"],
        ["sync_runtime", "revision", (f) => { f.settings.applyHttp.push(409); }, "Core lifecycle request failed (409)"],
        ["attach_domains", "revision", (f) => failCloudflare(f, cf.domain, 400, Infinity), "HTTP 400"],
        ["attach_domains", "first", (f) => { f.settings.domainsHttp.push(403); }, "HTTP 403"],
        ["sync_runtime", "first", (f) => { f.settings.applyHttp.push(409); }, "Core lifecycle request failed (409)"],
      ];
      it.each(deterministicRollback)("settles at once on a deterministic failure in %s (%s): one failed receipt, no retry, clean text (%#)", async (step, to, arrange, text) => {
        const { f, payload } = await manual(to, arrange);
        const s = steps();
        await expect(rollbackRun(f, payload, s)).rejects.toThrow(text);
        expect(s.attempts.get(step)).toBe(1);
        expect(s.failures.get(step)).toBeInstanceOf(NonRetryableError);
        expect(await receipts(f, step, "failed")).toBe(1);
        expect(await receipts(f, step, "ok")).toBe(0);
        const message = (await receiptOutput(f, step)).error as string;
        expect(message).toContain(text);
        expect(message).not.toContain("NonRetryableError");
        expect(await f.installRow()).toEqual({ status: "failed" });
        const stored = await installError(f);
        expect(stored).not.toContain("NonRetryableError");
        // A validate failure has mutated nothing and frees the brand. Any later step keeps the lock and records the evidence for Owner recovery.
        if (step === "validate") {
          expect(stored).toBe(`Error: ${message}`);
          expect(await lockedBrand(f)).toBe(false);
        } else {
          expect(JSON.parse(stored)).toMatchObject({ recovery_required: true, original_install_id: f.install, error: `Error: ${message}` });
          expect(await lockedBrand(f)).toBe(true);
        }
      });

      it.each(["deploy", "sync_runtime", "attach_domains"])("gives up on a persistent transient failure in %s after its configured retries, keeping the lock for Owner recovery", async (step) => {
        const { f, payload } = await manual("revision", (g) => {
          if (step === "deploy") failCloudflare(g, deployPost, 502, Infinity);
          if (step === "sync_runtime") g.settings.coreFails = true;
          if (step === "attach_domains") failCloudflare(g, cf.domain, 502, Infinity);
        });
        const s = steps();
        await expect(rollbackRun(f, payload, s)).rejects.toThrow();
        expect(s.attempts.get(step)).toBe(s.configs.get(step)!.retries!.limit! + 1);
        expect(s.failures.get(step)).not.toBeInstanceOf(NonRetryableError);
        expect(await receipts(f, step, "failed")).toBe(1);
        expect(JSON.parse(await installError(f))).toMatchObject({ recovery_required: true, audit_action: "rollback.failed_lock_retained" });
        expect(await lockedBrand(f)).toBe(true);
        // The retained lock is what recovery needs: an Owner recovers the brand once the cause is gone.
        f.settings.coreFails = false;
        vi.stubGlobal("fetch", f.network);
        expect((await recover(f)).status).toBe(201);
        await rollbackRun(f, f.compensation[0]!);
        expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
      });

      it("claim_rollback settles at once when another lifecycle operation holds the brand: one attempt, a NonRetryableError", async () => {
        const { f, payload } = await manual("revision", async (g) => {
          await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'install','running','owner','2000-01-01T00:00:00.000Z')").bind(`other-${g.id}`, g.brand).run();
        });
        const s = steps();
        await expect(rollbackRun(f, payload, s)).rejects.toThrow("Brand already has a lifecycle mutation in progress");
        expect(s.attempts.get("claim_rollback")).toBe(1);
        expect(s.failures.get("claim_rollback")).toBeInstanceOf(NonRetryableError);
        expect(s.attempts.has("validate")).toBe(false);
      });

      it("claim_rollback retries a transient D1 error and then claims the install", async () => {
        const { f, payload } = await manual("revision", (g) => failD1(g, /^UPDATE installs SET status = 'running'/));
        const s = steps();
        await rollbackRun(f, payload, s);
        expect(s.attempts.get("claim_rollback")).toBe(2);
        expect(s.configs.get("claim_rollback")?.retries?.limit).toBeGreaterThan(0);
        expect(await f.installRow()).toEqual({ status: "rolled_back" });
      });

      it.each(["revision", "first"] as const)("finish_rollback writes the manual rollback rows in one batch (%s), and a failed batch leaves both rows untouched", async (to) => {
        const { f, payload } = await manual(to);
        const real = f.bindings.FACTORY;
        const batches: number[] = [];
        let failOnce = true;
        const writes: string[] = [];
        let finishing = false;
        (f.bindings as unknown as { FACTORY: unknown }).FACTORY = new Proxy(real, { get: (t, p) => {
          if (p === "batch") return async (statements: D1PreparedStatement[]) => {
            if (!finishing) return t.batch(statements);
            batches.push(statements.length);
            if (failOnce) { failOnce = false; throw new Error("D1_ERROR: injected failure"); }
            return t.batch(statements);
          };
          if (p === "prepare") return (sql: string) => { if (finishing && /^UPDATE (installs|brands)/.test(sql)) writes.push(sql); return t.prepare(sql); };
          const member = Reflect.get(t, p, t) as unknown;
          return typeof member === "function" ? member.bind(t) : member;
        } });
        const s = steps();
        s.hooks.before = async (name) => { finishing = name === "finish_rollback"; };
        s.hooks.retry = async () => {
          // After the failed batch the install row has not moved.
          expect(await f.installRow()).toEqual({ status: "running" });
        };
        await rollbackRun(f, payload, s);
        expect(s.attempts.get("finish_rollback")).toBe(2);
        expect(batches).toEqual(to === "revision" ? [2, 2] : [1, 1]);
        // Every UPDATE of the step goes through the batch: none is issued on its own.
        expect(writes).toHaveLength(batches.reduce((n, c) => n + c, 0));
        expect(await f.installRow()).toEqual({ status: "rolled_back" });
        expect(await lockedBrand(f)).toBe(false);
      });

      describe("a failed ok receipt write after the work succeeded", () => {
        async function again(step: string, to: "revision" | "first") {
          const { f, payload } = await manual(to);
          const armed = failReceiptD1Once(f, step, "write");
          const s = steps();
          await rollbackRun(f, payload, s);
          expect(armed()).toBe(false);
          expect(s.attempts.get(step)).toBe(2);
          expect(await f.installRow()).toEqual({ status: "rolled_back" });
          expect(await receipts(f, step, "ok")).toBe(1);
          expect(await receipts(f, step, "failed")).toBe(0);
          expect(await installError(f)).toBeNull();
          return f;
        }
        it("re-runs validate, which only reads the brand and the zone", async () => {
          const f = await again("validate", "revision");
          expect(f.network.mock.calls.filter(([input]) => urlOf(input).pathname.endsWith("/zones")).length).toBe(2);
        });
        it("re-runs deploy, which sets the same older Worker version live again: the traffic does not change", async () => {
          const f = await again("deploy", "revision");
          const posts = f.network.mock.calls.filter(([input, init]) => deployPost(urlOf(input), init));
          expect(posts).toHaveLength(2);
          expect(posts[1]![1]!.body).toBe(posts[0]![1]!.body);
          expect(String(posts[0]![1]!.body)).toContain("worker-old");
        });
        it.each(["revision", "first"] as const)("re-runs sync_runtime (%s): Core replays the same install_id as a noop and changes nothing", async (to) => {
          const f = await again("sync_runtime", to);
          expect(f.applied).toHaveLength(2);
          expect(f.counters.applyEffects).toBe(1);
          expect(f.runtime()).toMatchObject({ applied_revision_id: to === "revision" ? f.revision : null, last_lifecycle_install_id: f.install, paused: to === "first" });
        });
        it("re-runs attach_domains, which puts the same hostnames on the same script again", async () => {
          const f = await again("attach_domains", "revision");
          expect(callsTo(f, cf.domain)).toBe(4);
          expect([...f.domains]).toEqual([[f.settings.zoneName, `brand-${f.brand}`], [`www.${f.settings.zoneName}`, `brand-${f.brand}`]]);
        });
        it("re-runs the detach: it lists what is still attached, so no domain is deleted twice (the receipt then counts only the second pass)", async () => {
          const f = await again("attach_domains", "first");
          expect(callsTo(f, deleted)).toBe(2);
          expect(f.domains.size).toBe(0);
          expect(await receiptOutput(f, "attach_domains")).toEqual({ detached: 0 });
        });
        it.each(["revision", "first"] as const)("re-runs receipt (%s), which sets the same brand columns again", async (to) => {
          const f = await again("receipt", to);
          expect(await f.brandRow()).toEqual(to === "revision" ? { status: "live", current_revision_id: f.revision } : { status: "failed", current_revision_id: null });
        });
      });

      describe("compensation", () => {
        async function failedUpgrade() {
          const f = await fixture(true, false, false);
          const next = `next-${f.id}`;
          await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
            .bind(next, f.brand, f.version, f.artifact, now).run();
          f.params.revision_id = next;
          f.settings.smokeFails = true;
          await runInstall(f);
          expect(f.compensation).toHaveLength(1);
          expect(await f.installRow()).toEqual({ status: "failed" });
          f.settings.smokeFails = false;
          return f;
        }
        const audits = async (f: Fixture, action: string) => (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action=? AND entity_id=?").bind(action, f.install).first<{ n: number }>())!.n;

        it("retries a transient failure and finishes the original install as rolled back, with no recovery evidence", async () => {
          const f = await failedUpgrade();
          f.settings.applyHttp.push(503);
          const s = steps();
          await rollbackRun(f, f.compensation[0]!, s);
          expect(s.attempts.get("sync_runtime")).toBe(2);
          expect(await f.installRow()).toEqual({ status: "rolled_back" });
          expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
          expect(await installError(f)).toBeNull();
          expect(await audits(f, "install.compensation_succeeded")).toBe(1);
          expect(await audits(f, "install.compensation_failed")).toBe(0);
          expect(f.compensation).toHaveLength(1);
        });

        it("fails the original install with recovery evidence once, after the last attempt", async () => {
          const f = await failedUpgrade();
          f.settings.coreFails = true;
          const s = steps();
          s.hooks.retry = async () => { expect(await installError(f)).not.toContain("recovery_required"); };
          await expect(rollbackRun(f, f.compensation[0]!, s)).rejects.toThrow("Core lifecycle request failed (503)");
          expect(s.attempts.get("sync_runtime")).toBe(s.configs.get("sync_runtime")!.retries!.limit! + 1);
          expect(JSON.parse(await installError(f))).toMatchObject({ recovery_required: true, original_install_id: f.install, compensation_install_id: f.compensation[0]!.install_id });
          expect(await audits(f, "install.compensation_failed")).toBe(1);
          expect(await lockedBrand(f)).toBe(true);
        });

        it("does not finish twice when the batch committed but its result was lost: the next lifecycle operation keeps its lock", async () => {
          const f = await failedUpgrade();
          const real = f.bindings.FACTORY;
          let lost = true;
          (f.bindings as unknown as { FACTORY: unknown }).FACTORY = new Proxy(real, { get: (t, p) => {
            if (p === "batch") return async (statements: D1PreparedStatement[]) => {
              const result = await t.batch(statements);
              if (lost && statements.length === 4) {
                lost = false;
                // The brand is free after the commit, so a new install may take it before the engine retries.
                await t.prepare("UPDATE brands SET status='installing' WHERE brand_id=?").bind(f.brand).run();
                throw new Error("D1_ERROR: result lost");
              }
              return result;
            };
            const member = Reflect.get(t, p, t) as unknown;
            return typeof member === "function" ? member.bind(t) : member;
          } });
          const s = steps();
          await rollbackRun(f, f.compensation[0]!, s);
          expect(lost).toBe(false);
          expect(s.attempts.get("finish_rollback")).toBe(2);
          expect(await f.installRow()).toEqual({ status: "rolled_back" });
          expect(await lockedBrand(f)).toBe(true);
          expect(await audits(f, "install.compensation_succeeded")).toBe(1);
        });
      });
    });

    describe("the upgrade-all Workflow", () => {
      const control = { failCreate: new Map<string, number>(), loseResponse: new Map<string, number>(), autoReady: true, lookupFailures: 0 };
      const rejections = async (installId: string) => (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='install.rejected' AND entity_id=?").bind(installId).first<{ n: number }>())!.n;
      const statusOf = async (installId: string) => (await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(installId).first<{ status: string }>())?.status;
      async function addBrand(f: Fixture, name: string) {
        const brand = `${name}-${f.id}`;
        await env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,status,current_revision_id,created_by,created_at,updated_at) VALUES (?,?,'test',?,'live',?,'owner',?,?)").bind(brand, brand, `${brand}.example`, `rev-${brand}`, now, now).run();
        await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,worker_version_id,created_by,created_at) VALUES (?,?,1,?,?,'{}','worker-old','owner',?)").bind(`rev-${brand}`, brand, f.version, f.artifact, now).run();
        return brand;
      }
      // A live canary brand plus two more, a target template version, and an install Workflow that behaves like the engine:
      // an id can be created once, get() of an id never created throws, and the canary reaches READY as soon as its instance exists.
      async function prepare(keepFixtureInstall = false) {
        control.failCreate.clear(); control.loseResponse.clear(); control.autoReady = true; control.lookupFailures = 0;
        const f = await fixture(true, false, false);
        if (!keepFixtureInstall) await env.FACTORY.prepare("DELETE FROM installs WHERE install_id=?").bind(f.install).run();
        const second = await addBrand(f, "second");
        const third = await addBrand(f, "third");
        const target = `target-${f.id}`;
        await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_at,created_by,created_at) VALUES (?,?,2,?,?,'sealed',?,'owner',?)").bind(target, f.template, target, `${f.id}/site.zip`, now, now).run();
        const created = new Map<string, InstallParams>();
        const createCalls: string[] = [];
        f.bindings.INSTALL_WORKFLOW = {
          async create({ id, params }: { id: string; params: InstallParams }) {
            createCalls.push(params.brand_id);
            const failures = control.failCreate.get(params.brand_id) ?? 0;
            if (failures > 0) { control.failCreate.set(params.brand_id, failures - 1); throw new Error("workflow service unavailable"); }
            if (created.has(id)) throw new Error("instance.already_exists");
            created.set(id, params);
            if (params.brand_id === f.brand && control.autoReady) {
              await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?").bind(id).run();
              await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'sync_runtime','ok','{}',?)").bind(id, now).run();
            }
            const lost = control.loseResponse.get(params.brand_id) ?? 0;
            if (lost > 0) { control.loseResponse.set(params.brand_id, lost - 1); throw new Error("network connection lost"); }
            return { id };
          },
          async get(id: string) {
            // A lookup that fails without an answer: the instance may or may not exist. Only "instance.not_found" means it does not.
            if (control.lookupFailures > 0) { control.lookupFailures--; throw new Error("workflow service unavailable"); }
            if (!created.has(id)) throw new Error("instance.not_found");
            return { id };
          },
        } as unknown as Workflow;
        const params: UpgradeAllParams = { from_template_version_id: f.version, to_template_version_id: target, form_artifact_id: f.artifact, canary_brand_id: f.brand, started_by: "owner", started_role: "owner" };
        const run = (s = steps()) => UpgradeAllWorkflow.prototype.run.call({ env: f.bindings } as unknown as UpgradeAllWorkflow, event(params), s.step);
        const installOf = (brand: string) => upgradeInstallId(f.version, target, f.artifact, brand, "owner", "owner", f.brand);
        return { f, second, third, created, createCalls, run, installOf, control };
      }
      type Prepared = Awaited<ReturnType<typeof prepare>>;
      const everyInstall = (p: Prepared) => [p.f.brand, p.second, p.third];
      const limit = REMOTE_STEP_RETRY_CONFIG.retries.limit;

      it("starts one instance per brand on the plain path", async () => {
        const p = await prepare();
        const s = steps();
        await p.run(s);
        expect(p.createCalls.sort()).toEqual(everyInstall(p).sort());
        expect(p.created.size).toBe(3);
        expect(s.configs.get("canary_install")?.retries?.limit).toBe(limit);
        expect(s.configs.get("bulk_installs")?.retries?.limit).toBe(limit);
        expect(s.configs.get("canary_status_0")?.retries?.limit).toBeGreaterThan(0);
      });

      describe("collect_upgrade", () => {
        it("settles at once when the target version is not sealed: one attempt, a NonRetryableError, nothing created", async () => {
          const p = await prepare();
          const target = `target-${p.f.id}`;
          await env.FACTORY.prepare("DELETE FROM template_versions WHERE template_version_id=?").bind(target).run();
          await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES (?,?,2,?,?,'draft','owner',?)").bind(target, p.f.template, target, `${p.f.id}/site.zip`, now).run();
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("Upgrade target template version is not sealed");
          expect(s.attempts.get("collect_upgrade")).toBe(1);
          expect(s.failures.get("collect_upgrade")).toBeInstanceOf(NonRetryableError);
          expect(p.createCalls).toHaveLength(0);
        });
        it("settles at once when a template version row is missing", async () => {
          const p = await prepare();
          await env.FACTORY.prepare("DELETE FROM template_versions WHERE template_version_id=?").bind(`target-${p.f.id}`).run();
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("Upgrade template version not found");
          expect(s.attempts.get("collect_upgrade")).toBe(1);
          expect(s.failures.get("collect_upgrade")).toBeInstanceOf(NonRetryableError);
        });
        it("retries a transient D1 error and then collects the brands", async () => {
          const p = await prepare();
          failD1(p.f, /^SELECT template_id, status FROM template_versions/);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("collect_upgrade")).toBe(2);
          expect(s.configs.get("collect_upgrade")?.retries?.limit).toBeGreaterThan(0);
          expect(p.created.size).toBe(3);
        });
      });

      describe("canary_install", () => {
        it("retries a failed dispatch without rejecting the install, and starts its instance once", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.f.brand, 1);
          const canary = await p.installOf(p.f.brand);
          const s = steps();
          s.hooks.retry = async () => {
            // Between the attempts the install is claimed (running) and has no instance yet.
            expect(await statusOf(canary)).toBe("running");
            expect(p.created.size).toBe(0);
          };
          await p.run(s);
          expect(s.attempts.get("canary_install")).toBe(2);
          expect(p.createCalls.filter((b) => b === p.f.brand)).toHaveLength(2);
          expect(p.created.size).toBe(3);
          expect(await statusOf(await p.installOf(p.f.brand))).toBe("ready");
          expect(await rejections(await p.installOf(p.f.brand))).toBe(0);
        });

        it("retries a transient D1 error while claiming the install, and starts its instance once", async () => {
          const p = await prepare();
          failD1(p.f, /^UPDATE installs SET status = 'running'/);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("canary_install")).toBe(2);
          expect(p.createCalls.filter((b) => b === p.f.brand)).toHaveLength(1);
          expect(p.created.size).toBe(3);
          expect(await rejections(await p.installOf(p.f.brand))).toBe(0);
        });

        it("counts a dispatch whose answer was lost as started: no second create, no rejection", async () => {
          const p = await prepare();
          p.control.loseResponse.set(p.f.brand, 1);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("canary_install")).toBe(1);
          expect(p.createCalls.filter((b) => b === p.f.brand)).toHaveLength(1);
          expect(await statusOf(await p.installOf(p.f.brand))).toBe("ready");
          expect(await rejections(await p.installOf(p.f.brand))).toBe(0);
        });

        it("run again after it dispatched: finds the running install and its instance, and neither creates nor rejects", async () => {
          const p = await prepare();
          p.control.autoReady = false;
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("Canary install did not reach READY");
          const canary = await p.installOf(p.f.brand);
          expect(await statusOf(canary)).toBe("running");
          expect(p.createCalls).toEqual([p.f.brand]);
          await env.FACTORY.prepare("UPDATE installs SET status='ready' WHERE install_id=?").bind(canary).run();
          await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'sync_runtime','ok','{}',?)").bind(canary, now).run();
          for (const name of [...s.cache.keys()].filter((key) => key === "canary_install" || key.startsWith("canary_status_"))) s.cache.delete(name);
          await p.run(s);
          expect(p.createCalls.filter((b) => b === p.f.brand)).toHaveLength(1);
          expect(await statusOf(canary)).toBe("ready");
          expect(await rejections(canary)).toBe(0);
        });

        it("never rejects an install whose Workflow state is unknown: it stays running, the brand lock is kept, no second create happens and the command fails with a clear error", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.f.brand, Infinity);
          p.control.lookupFailures = Infinity;
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("could not be looked up");
          expect(s.attempts.get("canary_install")).toBe(limit + 1);
          const canary = await p.installOf(p.f.brand);
          expect(await statusOf(canary)).toBe("running");
          expect(await rejections(canary)).toBe(0);
          expect(await p.f.brandRow()).toMatchObject({ status: "installing" });
          expect(p.createCalls).toEqual([p.f.brand]);
        });

        it("keeps a running install that exists when the lookup fails on the last attempt: no create, no rejection", async () => {
          const p = await prepare();
          p.control.autoReady = false;
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("Canary install did not reach READY");
          const canary = await p.installOf(p.f.brand);
          for (const name of [...s.cache.keys()].filter((key) => key === "canary_install")) s.cache.delete(name);
          p.control.lookupFailures = Infinity;
          await expect(p.run(s)).rejects.toThrow("could not be looked up");
          expect(s.attempts.get("canary_install")).toBe(limit + 1);
          expect(await statusOf(canary)).toBe("running");
          expect(await rejections(canary)).toBe(0);
          expect(await p.f.brandRow()).toMatchObject({ status: "installing" });
          expect(p.createCalls).toEqual([p.f.brand]);
        });

        it("retries an unknown lookup and creates the missing instance once the lookup answers not found", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.f.brand, 1);
          p.control.lookupFailures = 1;
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("canary_install")).toBe(2);
          expect(p.createCalls.filter((b) => b === p.f.brand)).toHaveLength(2);
          expect(p.created.size).toBe(3);
          expect(await rejections(await p.installOf(p.f.brand))).toBe(0);
        });

        it("gives up on a persistent dispatch failure after its configured retries: the install is rejected, the brand lock is freed and the command fails", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.f.brand, Infinity);
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("workflow service unavailable");
          expect(s.attempts.get("canary_install")).toBe(limit + 1);
          const canary = await p.installOf(p.f.brand);
          expect(await statusOf(canary)).toBe("failed");
          expect(await rejections(canary)).toBe(1);
          expect(await p.f.brandRow()).toEqual({ status: "live", current_revision_id: p.f.revision });
          expect(p.created.size).toBe(0);
          expect(p.createCalls).toHaveLength(limit + 1);
        });

        it("settles at once when another lifecycle operation holds the brand: the install is rejected and no instance starts", async () => {
          const p = await prepare(true);
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("Brand already has a lifecycle mutation in progress");
          expect(s.attempts.get("canary_install")).toBe(1);
          expect(s.failures.get("canary_install")).toBeInstanceOf(NonRetryableError);
          const canary = await p.installOf(p.f.brand);
          expect(await statusOf(canary)).toBe("failed");
          expect(await rejections(canary)).toBe(1);
          expect(p.createCalls).toHaveLength(0);
          expect(await statusOf(p.f.install)).toBe("queued");
        });
      });

      describe("canary_status", () => {
        it("retries a transient D1 error in the poll: the command completes and no install starts twice", async () => {
          const p = await prepare();
          failD1(p.f, /^SELECT status FROM install_receipts WHERE install_id = \? AND step = 'sync_runtime'/);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("canary_status_0")).toBe(2);
          expect(p.createCalls.sort()).toEqual(everyInstall(p).sort());
          expect(await rejections(await p.installOf(p.f.brand))).toBe(0);
        });

        it("fails the command only when the poll keeps failing, and still starts nothing twice", async () => {
          const p = await prepare();
          failD1(p.f, /^SELECT status FROM install_receipts WHERE install_id = \? AND step = 'sync_runtime'/, Infinity);
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("D1_ERROR");
          expect(s.attempts.get("canary_status_0")).toBe(limit + 1);
          expect(p.createCalls).toEqual([p.f.brand]);
        });
      });

      describe("bulk_installs", () => {
        it("retries one brand's failed dispatch and does not start the others again", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.second, 1);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(2);
          expect(p.createCalls.filter((b) => b === p.second)).toHaveLength(2);
          expect(p.createCalls.filter((b) => b === p.third)).toHaveLength(1);
          expect(p.created.size).toBe(3);
          for (const brand of [p.second, p.third]) {
            expect(await statusOf(await p.installOf(brand))).toBe("running");
            expect(await rejections(await p.installOf(brand))).toBe(0);
          }
        });

        it("counts a dispatch whose answer was lost as started: no second create, no rejection", async () => {
          const p = await prepare();
          p.control.loseResponse.set(p.second, 1);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(1);
          expect(p.createCalls.filter((b) => b === p.second)).toHaveLength(1);
          expect(await statusOf(await p.installOf(p.second))).toBe("running");
          expect(await rejections(await p.installOf(p.second))).toBe(0);
        });

        it("retries a transient D1 error in the loop, still starts the other brand at once, and starts every instance once", async () => {
          const p = await prepare();
          failD1(p.f, /current_revision_id, \?, 0, 'queued'/);
          const s = steps();
          let startedBeforeRetry = -1;
          s.hooks.retry = async (name) => { if (name === "bulk_installs") startedBeforeRetry = p.createCalls.filter((b) => b === p.third).length; };
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(2);
          expect(startedBeforeRetry).toBe(1);
          expect(p.createCalls.filter((b) => b === p.second)).toHaveLength(1);
          expect(p.createCalls.filter((b) => b === p.third)).toHaveLength(1);
          for (const brand of [p.second, p.third]) expect(await statusOf(await p.installOf(brand))).toBe("running");
        });

        it("never rejects an install whose Workflow state is unknown, on the last attempt either: both stay running, the locks are kept, nothing is created again", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.second, Infinity);
          p.control.lookupFailures = Infinity;
          const s = steps();
          await expect(p.run(s)).rejects.toThrow("could not be looked up");
          expect(s.attempts.get("bulk_installs")).toBe(limit + 1);
          for (const brand of [p.second, p.third]) {
            expect(await statusOf(await p.installOf(brand))).toBe("running");
            expect(await rejections(await p.installOf(brand))).toBe(0);
            expect(await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id=?").bind(brand).first()).toEqual({ status: "installing" });
            expect(p.createCalls.filter((b) => b === brand)).toHaveLength(1);
          }
        });

        it("retries an unknown lookup for one brand, creates its missing instance and skips the other brand's running install", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.second, 1);
          p.control.lookupFailures = 1;
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(2);
          expect(p.createCalls.filter((b) => b === p.second)).toHaveLength(2);
          expect(p.createCalls.filter((b) => b === p.third)).toHaveLength(1);
          expect(p.created.size).toBe(3);
          for (const brand of [p.second, p.third]) {
            expect(await statusOf(await p.installOf(brand))).toBe("running");
            expect(await rejections(await p.installOf(brand))).toBe(0);
          }
        });

        it("gives up on one brand's persistent failure after its configured retries: that install is rejected and the others still start", async () => {
          const p = await prepare();
          p.control.failCreate.set(p.second, Infinity);
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(limit + 1);
          expect(p.createCalls.filter((b) => b === p.second)).toHaveLength(limit + 1);
          expect(p.createCalls.filter((b) => b === p.third)).toHaveLength(1);
          expect(await statusOf(await p.installOf(p.second))).toBe("failed");
          expect(await rejections(await p.installOf(p.second))).toBe(1);
          expect(await statusOf(await p.installOf(p.third))).toBe("running");
        });

        it("rejects a brand that another lifecycle operation holds at once, and starts the others", async () => {
          const p = await prepare();
          await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'install','running','owner',?)").bind(`other-${p.f.id}`, p.second, "2020-01-01T00:00:00.000Z").run();
          const s = steps();
          await p.run(s);
          expect(s.attempts.get("bulk_installs")).toBe(1);
          expect(p.createCalls).not.toContain(p.second);
          expect(await statusOf(await p.installOf(p.second))).toBe("failed");
          expect(await statusOf(await p.installOf(p.third))).toBe("running");
          expect(await statusOf(`other-${p.f.id}`)).toBe("running");
        });

        it("run again after it dispatched: starts nothing and rejects nothing", async () => {
          const p = await prepare();
          const s = steps();
          await p.run(s);
          s.cache.delete("bulk_installs");
          const calls = p.createCalls.length;
          await p.run(s);
          expect(p.createCalls).toHaveLength(calls);
          for (const brand of [p.second, p.third]) {
            expect(await statusOf(await p.installOf(brand))).toBe("running");
            expect(await rejections(await p.installOf(brand))).toBe(0);
          }
        });
      });
    });
  });

  // FUS-345: the engine hands a step's NonRetryableError to the Workflow code as Error("NonRetryableError: <message>").
  // The panel and the receipts keep the text they had before validate failures became non-retryable.
  describe("engine error text", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const receiptError = async (installId: string, step: string) => JSON.parse((await env.FACTORY.prepare("SELECT output_json FROM install_receipts WHERE install_id=? AND step=?")
      .bind(installId, step).first<{ output_json: string }>())!.output_json).error as string;
    const installError = async (installId: string) => (await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(installId).first<{ error: string }>())!.error;
    async function startUpgrade(f: Fixture) {
      const next = `upgrade-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      await env.FACTORY.prepare("UPDATE installs SET kind='upgrade',from_revision_id=?,to_revision_id=? WHERE install_id=?").bind(f.revision, next, f.install).run();
      f.params.revision_id = next;
    }
    const zoneMessage = (f: Fixture) => `Zone not found for domain ${f.id}.example (tried: ${f.id}.example)`;

    it("models the engine: a NonRetryableError reaches the Workflow code as Error('NonRetryableError: <message>')", async () => {
      const s = steps();
      const thrown = await s.step.do("probe", async () => { throw new NonRetryableError("boom"); }).catch((e: unknown) => e) as Error;
      expect(thrown.name).toBe("Error");
      expect(thrown.message).toBe("NonRetryableError: boom");
      expect(thrown).not.toBeInstanceOf(NonRetryableError);
    });

    it("keeps the prefix out of installs.error and the receipt for a validate failure on a first install", async () => {
      const f = await fixture();
      f.settings.zoneName = "other.example";
      await runInstall(f);
      expect(await installError(f.install)).toBe(`Error: ${zoneMessage(f)}`);
      expect(await receiptError(f.install, "validate")).toBe(zoneMessage(f));
    });

    it("keeps the prefix out of installs.error and the receipt for a validate failure on an upgrade", async () => {
      const f = await fixture(true, false, false);
      await startUpgrade(f);
      f.settings.zoneName = "other.example";
      await runInstall(f);
      expect(await installError(f.install)).toBe(`Error: ${zoneMessage(f)}`);
      expect(await receiptError(f.install, "validate")).toBe(zoneMessage(f));
    });

    it("keeps the prefix out of installs.error and the receipt for a smoke NonRetryableError", async () => {
      const f = await fixture();
      f.settings.www.push(new Response(null, { status: 301, headers: { Location: "https://wrong.example/" } }));
      await runInstall(f);
      expect(await installError(f.install)).toBe("Error: Smoke: www redirect does not target the apex");
      expect(await receiptError(f.install, "smoke")).toBe("Smoke: www redirect does not target the apex");
    });

    it("keeps the text clean when a retry install fails the same way again", async () => {
      const f = await fixture();
      f.settings.zoneName = "other.example";
      await runInstall(f);
      const retryId = await queueInstallRetry(env.FACTORY, f.install);
      expect(retryId).not.toBeNull();
      await runInstall({ ...f, params: { ...f.params, install_id: retryId! } });
      expect(await installError(retryId!)).toBe(`Error: ${zoneMessage(f)}`);
      expect(await receiptError(retryId!, "validate")).toBe(zoneMessage(f));
    });

    it("keeps the text clean when a retry install fails the smoke again", async () => {
      const f = await fixture();
      f.settings.www.push(new Response(null, { status: 301, headers: { Location: "https://wrong.example/" } }));
      await runInstall(f);
      await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(f.compensation[0]!), steps().step);
      const retryId = `retry-${f.install}`;
      await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,to_revision_id,status,started_by,started_at) VALUES (?,?,'install',?,'queued','owner',?)")
        .bind(retryId, f.brand, f.revision, now).run();
      f.settings.www.push(new Response(null, { status: 301, headers: { Location: "https://wrong.example/" } }));
      await runInstall({ ...f, params: { ...f.params, install_id: retryId } });
      expect(await installError(retryId)).toBe("Error: Smoke: www redirect does not target the apex");
      expect(await receiptError(retryId, "smoke")).toBe("Smoke: www redirect does not target the apex");
    });

    it("never double-prefixes a stored failed receipt when the same install runs again", async () => {
      const f = await fixture();
      f.settings.zoneName = "other.example";
      await runInstall(f);
      await runInstall(f);
      await runInstall(f);
      expect(await installError(f.install)).toBe(`Error: ${zoneMessage(f)}`);
      expect(await receiptError(f.install, "validate")).toBe(zoneMessage(f));
    });

    it("reads a stored smoke receipt that an older release saved with the engine prefix without repeating it", async () => {
      const f = await fixture();
      f.settings.www.push(new Response(null, { status: 301, headers: { Location: "https://wrong.example/" } }));
      await runInstall(f);
      await env.FACTORY.prepare("UPDATE install_receipts SET output_json=? WHERE install_id=? AND step='smoke'")
        .bind(JSON.stringify({ error: "NonRetryableError: Smoke: www redirect does not target the apex" }), f.install).run();
      await env.FACTORY.prepare("UPDATE installs SET status='running', error=NULL WHERE install_id=?").bind(f.install).run();
      await runInstall(f);
      expect(await installError(f.install)).toBe("Error: Smoke: www redirect does not target the apex");
    });

    it("still rejects a queued install as lifecycle-blocked when the engine prefixes that message", async () => {
      const f = await fixture();
      const s = steps();
      const real = s.step.do.bind(s.step) as (...args: unknown[]) => Promise<unknown>;
      (s.step as unknown as { do: unknown }).do = (name: string, ...rest: unknown[]) => name === "claim_install"
        ? Promise.reject(engineRethrow(new NonRetryableError("Brand already has a lifecycle mutation in progress")))
        : real(name, ...rest);
      await expect(runInstall(f, s)).rejects.toThrow("Brand already has a lifecycle mutation in progress");
      expect(JSON.parse(await installError(f.install))).toMatchObject({
        error: "Error: Brand already has a lifecycle mutation in progress",
        actionable: expect.stringContaining("retry with a new install_id"),
      });
      expect(await receiptError(f.install, "validate")).toBe("Error: Brand already has a lifecycle mutation in progress");
    });
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

  it.each([false, true])("recovers after compensation dispatch throws (live=%s)", async (live) => {
    const f = await fixture(live);
    if (live) {
      const next = `next-${f.id}`;
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?,?,2,?,?,'{}','owner',?)")
        .bind(next, f.brand, f.version, f.artifact, now).run();
      f.params.revision_id = next;
    }
    f.settings.smokeFails = true;
    f.settings.dispatchFails = true;
    await expect(runInstall(f)).rejects.toThrow("compensation dispatch unavailable");
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    expect(f.compensation).toHaveLength(0);
    // Dispatch failure stamps both rows. The newer compensation must not hide its source.
    const compensationId = `compensate-${f.install}`;
    const failed = await env.FACTORY.prepare("SELECT status,error FROM installs WHERE install_id=?")
      .bind(compensationId).first<{ status: string; error: string }>();
    expect(failed?.status).toBe("failed");
    expect(JSON.parse(failed!.error)).toMatchObject({ recovery_required: true, original_install_id: f.install });
    f.settings.dispatchFails = false;
    expect((await recover(f, "employee")).status).toBe(403);
    expect(f.compensation).toHaveLength(0);
    expect((await recover(f)).status).toBe(201);
    const recovery = f.compensation[0]!;
    expect(recovery).toMatchObject({ original_install_id: f.install, to_revision_id: live ? f.revision : null });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
      event(recovery), steps().step);
    expect(await f.brandRow()).toEqual({ status: live ? "live" : "failed", current_revision_id: live ? f.revision : null });
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(f.runtime()).toMatchObject({ applied_revision_id: live ? f.revision : null, paused: true });
    if (live) expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith("/deployments") && String(init?.body).includes("worker-old"))).toBe(true);
    else expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith(`/workers/domains/local-${f.id}.example`) && init?.method === "DELETE")).toBe(true);
    expect(await env.FACTORY.prepare("SELECT status FROM install_receipts WHERE install_id=? AND step='receipt'").bind(recovery.install_id).first()).toEqual({ status: "ok" });
    expect(await env.FACTORY.prepare("SELECT actor_role FROM audit_log WHERE entity_id=? AND action='install.recover'").bind(recovery.install_id).first()).toEqual({ actor_role: "owner" });
    const calls = f.network.mock.calls.length;
    expect(await (await recover(f)).json()).toMatchObject({ install_id: recovery.install_id, idempotent: true });
    expect(f.compensation).toHaveLength(1);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(await env.FACTORY.prepare("SELECT status,error FROM installs WHERE install_id=?").bind(compensationId).first()).toEqual(failed);
    const nextInstall = `new-${f.id}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'install','queued','owner',?)").bind(nextInstall, f.brand, now).run();
    expect(await setInstallStatus(env.FACTORY, nextInstall, "running", undefined, f.brand)).toBe("claimed");
  });

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
    // The failed deployment may already be current when compensation fails.
    await env.FACTORY.prepare("UPDATE brands SET current_revision_id=? WHERE brand_id=?").bind(f.params.revision_id, f.brand).run();
    const failedReceipts = await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(f.compensation[0]!.install_id).all();
    const responses = await Promise.all([recover(f), recover(f)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const recovery = f.compensation[1]!;
    expect(recovery).toMatchObject({ original_install_id: f.install, to_revision_id: live ? f.revision : null });
    expect(await env.FACTORY.prepare("SELECT from_revision_id,to_revision_id FROM installs WHERE install_id=?").bind(recovery.install_id).first())
      .toEqual({ from_revision_id: f.params.revision_id, to_revision_id: live ? f.revision : null });
    expect((await recover(f)).status).toBe(409);
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(recovery), steps().step);
    expect(await f.brandRow()).toEqual({ status: live ? "live" : "failed", current_revision_id: live ? f.revision : null });
    expect(f.runtime()).toMatchObject({ applied_revision_id: live ? f.revision : null, paused: true });
    if (live) expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith("/deployments") && String(init?.body).includes("worker-old"))).toBe(true);
    else expect(f.network.mock.calls.some(([url, init]) => String(url).endsWith(`/workers/domains/local-${f.id}.example`) && init?.method === "DELETE")).toBe(true);
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

    // A stale panel action or Workflow replay must not release the next install's lock.
    const runtimeBeforeReplay = f.runtime();
    const auditBeforeReplay = await env.FACTORY.prepare("SELECT * FROM audit_log WHERE entity_id IN (?,?) ORDER BY id")
      .bind(f.install, recovery.install_id).all();
    expect(await (await recover(f)).json()).toMatchObject({ install_id: recovery.install_id, idempotent: true });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(recovery), steps().step);
    expect(await f.brandRow()).toEqual({ status: "installing", current_revision_id: live ? f.revision : null });
    expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(nextInstall).first()).toEqual({ status: "running" });
    expect(f.runtime()).toEqual(runtimeBeforeReplay);
    expect(f.network).toHaveBeenCalledTimes(calls);
    expect(f.compensation).toHaveLength(2);
    expect((await env.FACTORY.prepare("SELECT * FROM audit_log WHERE entity_id IN (?,?) ORDER BY id")
      .bind(f.install, recovery.install_id).all()).results).toEqual(auditBeforeReplay.results);
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

  it("leaves a recovery that its Workflow already claimed running when the dispatch answer is lost and the lookup fails", async () => {
    const f = await fixture();
    await failCompensation(f);
    (f.bindings as unknown as { ROLLBACK_WORKFLOW: unknown }).ROLLBACK_WORKFLOW = {
      async create({ params }: { params: RollbackParams }) {
        await env.FACTORY.prepare("UPDATE installs SET status='running' WHERE install_id=?").bind(params.install_id).run();
        throw new Error("network connection lost");
      },
      async get() { throw new Error("workflow service unavailable"); },
    };
    const response = await recover(f);
    expect(response.status).toBe(502);
    const { install_id } = await response.json() as { install_id: string };
    expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id=?").bind(install_id).first()).toEqual({ status: "running" });
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
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

  it("recovers the retained lock after a failed manual rollback and frees it for the next install", async () => {
    const f = await fixture(true);
    await env.FACTORY.prepare("UPDATE installs SET kind='rollback' WHERE install_id=?").bind(f.install).run();
    f.settings.coreFails = true;
    await expect(RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow,
      event({ install_id: f.install, brand_id: f.brand, to_revision_id: f.revision }), steps().step)).rejects.toThrow("Core lifecycle request failed (503)");
    f.settings.coreFails = false;
    expect(await f.brandRow()).toMatchObject({ status: "installing" });
    const failed = await env.FACTORY.prepare("SELECT error FROM installs WHERE install_id=?").bind(f.install).first<{ error: string }>();
    expect(JSON.parse(failed!.error)).toMatchObject({ recovery_required: true, original_install_id: f.install, audit_action: "rollback.failed_lock_retained" });
    expect(await env.FACTORY.prepare("SELECT actor_role FROM audit_log WHERE entity_id=? AND action='rollback.failed_lock_retained'").bind(f.install).first()).toEqual({ actor_role: "system" });
    expect((await recover(f, "employee")).status).toBe(403);
    expect(f.compensation).toHaveLength(0);
    expect((await recover(f)).status).toBe(201);
    const recovery = f.compensation[0]!;
    expect(recovery).toMatchObject({ original_install_id: f.install, to_revision_id: f.revision });
    await RollbackBrandWorkflow.prototype.run.call({ env: f.bindings } as unknown as RollbackBrandWorkflow, event(recovery), steps().step);
    expect(await f.brandRow()).toEqual({ status: "live", current_revision_id: f.revision });
    expect(await f.installRow()).toEqual({ status: "rolled_back" });
    expect(await env.FACTORY.prepare("SELECT status FROM install_receipts WHERE install_id=? AND step='rollback'").bind(f.install).first()).toEqual({ status: "ok" });
    expect(await (await recover(f)).json()).toMatchObject({ install_id: recovery.install_id, idempotent: true });
    expect(f.compensation).toHaveLength(1);
    const nextInstall = `new-${f.id}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'install','queued','owner',?)").bind(nextInstall, f.brand, now).run();
    expect(await setInstallStatus(env.FACTORY, nextInstall, "running", undefined, f.brand)).toBe("claimed");
  });
});
