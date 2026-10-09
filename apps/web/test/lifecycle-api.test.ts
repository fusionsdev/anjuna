import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstallWithReceipts, LifecycleBrandSummary, SealedTemplatesResponse } from "@anjuna/contracts";
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
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

const post = (cookie: string, path: string, body: unknown) => call(path, { cookie, method: "POST", body });

describe("truthful lifecycle BFF", () => {
  it("offers only sealed versions from D1 and refuses unsealed draft input", async () => {
    for (const status of ["draft", "certifying", "certified", "rejected"]) {
      await env.FACTORY.prepare("INSERT INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES (?1,'tpl-1',?2,?4,'templates/unsealed',?3,'owner','2026-10-01T00:00:00Z')")
        .bind(`tv-${status}`, 2 + ["draft", "certifying", "certified", "rejected"].indexOf(status), status, `sha-${status}`).run();
      expect((await post(employee, "/api/brands/drafts", { domain: "unsealed.test", keyword_default: "Quick Loan", template_version_id: `tv-${status}` })).status).toBe(422);
    }
    expect((await call("/api/templates/sealed")).status).toBe(401);
    for (const cookie of [employee, owner]) {
      const response = await call("/api/templates/sealed", { cookie });
      expect(response.status).toBe(200);
      expect(SealedTemplatesResponse.parse(await response.json())).toEqual({ templates: [{ template_version_id: "tv-1", name: "Starter", version: 1, status: "sealed" }] });
    }
  });

  it("rejects an unknown template ID without creating draft records", async () => {
    const listed = await call("/api/templates/sealed", { cookie: employee });
    expect(listed.status).toBe(200);
    const { templates } = SealedTemplatesResponse.parse(await listed.json());
    expect(templates.some((template) => template.template_version_id === "tv-missing")).toBe(false);
    const counts = async () => Promise.all([
      env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first(),
      env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions").first(),
      env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first(),
    ]);
    const before = await counts();
    const response = await post(employee, "/api/brands/drafts", {
      domain: "unknown-template.test", keyword_default: "Quick Loan", template_version_id: "tv-missing",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "template_not_sealed" });
    expect(await counts()).toEqual(before);
  });

  it("refuses Employee Rollback, Upgrade-all and Delete before any mutation or dispatch", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "owner-only.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    let dispatches = 0;
    const testEnv = makeEnv({ FACTORY_WORKER: { fetch: async () => { dispatches++; return Response.json({ ok: true }); } } as unknown as Fetcher });
    const before = await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first();
    for (const [method, path] of [["POST", `/api/brands/${brand.brand_id}/rollback`], ["POST", "/api/upgrade-all"], ["DELETE", `/api/brands/${brand.brand_id}`]]) {
      const response = await call(path!, { cookie: employee, method: method!, body: {}, env: testEnv });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
    expect(dispatches).toBe(0);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first()).toEqual(before);
    expect(await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ status: "draft" });
    expect((await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).all()).results).toHaveLength(0);
    expect((await call(`/api/brands/${brand.brand_id}`, { cookie: owner, method: "DELETE" })).status).toBe(501);
  });

  it("refuses an Employee retry of a failed rollback", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "rollback-retry.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_role,started_at) VALUES ('rollback-denied',?1,'rollback','failed','owner','owner','2026-10-01T00:00:00Z')").bind(brand.brand_id).run();
    expect((await post(employee, "/api/installs/rollback-denied/retry", {})).status).toBe(403);
    expect(await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id='rollback-denied'").first()).toEqual({ status: "failed" });
  });

  it("rejects duplicate domains without a second brand or revision", async () => {
    const input = { domain: "duplicate-lifecycle.example", keyword_default: "quick loan", template_version_id: "tv-1" };
    expect((await post(employee, "/api/brands/drafts", input)).status).toBe(201);
    expect((await post(employee, "/api/brands/drafts", input)).status).toBe(409);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions r JOIN brands b ON b.brand_id=r.brand_id WHERE b.domain=?").bind(input.domain).first()).toEqual({ n: 1 });
  });

  it("persists verified checklist evidence once and scopes lifecycle audit by actor", async () => {
    const response = await post(employee, "/api/brands/drafts", { domain: "checklist-proof.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await response.json() as { brand: { brand_id: string } };
    let verifications = 0;
    const core = { fetch: async (request: Request) => {
      verifications++;
      expect(await request.json()).toEqual({ brand_id: brand.brand_id, lead_id: "sold-proof" });
      return Response.json({ verified: true, event_id: "event-proof", event_at: "2026-10-06T00:00:00.000Z" });
    } } as unknown as Fetcher;
    const attest = () => call(`/api/brands/${brand.brand_id}/checklist`, { cookie: employee, method: "POST", body: { item: "test_sold", lead_id: "sold-proof" }, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect((await attest()).status).toBe(200);
    expect(await (await attest()).json()).toMatchObject({ idempotent: true, evidence: { event_id: "event-proof" } });
    expect(verifications).toBe(1);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log WHERE entity_id=? AND action='checklist.attest'").bind(brand.brand_id).first()).toEqual({ n: 1 });
    const own = await post(owner, "/api/brands/drafts", { domain: "owner-audit-proof.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const ownerBrand = (await own.json() as { brand: { brand_id: string } }).brand.brand_id;
    const employeeAudit = JSON.stringify(await (await call("/api/audit?limit=200", { cookie: employee })).json());
    const ownerAudit = JSON.stringify(await (await call("/api/audit?limit=200", { cookie: owner })).json());
    expect(employeeAudit).toContain(brand.brand_id);
    expect(employeeAudit).not.toContain(ownerBrand);
    expect(ownerAudit).toContain(brand.brand_id);
    expect(ownerAudit).toContain(ownerBrand);
  });

  it("registers artifacts and makes legacy payload backfill set-once and owner-only", async () => {
    const created = await post(owner, "/api/form-artifacts", {
      form_artifact_id: "fa-new", template_version_id: "tv-1", git_sha: "abcdef2",
      bundle_form_version: "form@abcdef2", payload_version: "2026-01",
    });
    expect(created.status).toBe(201);
    expect((await post(employee, "/api/form-artifacts/fa-new/backfill", { payload_version: "2026-01" })).status).toBe(403);

    const first = await post(owner, "/api/form-artifacts/fa-1/backfill", { payload_version: "2026-01" });
    expect(first.status).toBe(409);
    const legacy = await env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,created_at) VALUES ('fa-legacy','abcdef3','forms/fa-legacy','m','2026-10-01T00:00:00Z')").run();
    expect(legacy.success).toBe(true);
    expect((await post(owner, "/api/form-artifacts/fa-legacy/backfill", { payload_version: "2026-01" })).status).toBe(200);
    expect((await post(owner, "/api/form-artifacts/fa-legacy/backfill", { payload_version: "2026-01" })).status).toBe(409);
  });

  it("creates a draft from a sealed template and compatible latest artifact", async () => {
    const res = await post(employee, "/api/brands/drafts", { domain: "example.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ brand: { domain: "example.test", status: "draft" }, revision: { revision: 1, template_version_id: "tv-1", form_artifact_id: expect.stringMatching(/^fa-/) } });
  });

  it("creates a draft using the brand-domain /apply default", async () => {
    const response = await call("/api/brands/drafts", {
      cookie: employee, method: "POST",
      body: { domain: "brand-apply.test", keyword_default: "Quick Loan", template_version_id: "tv-1" },
      env: makeEnv({ DEFAULT_PREPOP_BASE: "/apply" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ brand: { domain: "brand-apply.test", status: "draft" } });
  });

  it.each(["//external.test/apply", "/\\external.test/apply", "/apply?aid=999", "/apply#fragment", "apply"])("rejects unsafe relative prepop default %s", async (prepop) => {
    const response = await call("/api/brands/drafts", {
      cookie: employee, method: "POST",
      body: { domain: "invalid-prepop.test", keyword_default: "Quick Loan", template_version_id: "tv-1" },
      env: makeEnv({ DEFAULT_PREPOP_BASE: prepop }),
    });
    expect(response.status).toBe(503);
  });

  it("rejects draft creation when tenant runtime defaults are not configured", async () => {
    const envWithoutDefaults = makeEnv({ DEFAULT_ACCOUNT: undefined, DEFAULT_AID: undefined, DEFAULT_PREPOP_BASE: undefined, DEFAULT_FORM_ROUTE: undefined, DEFAULT_AMOUNT_BUCKETS: undefined, DEFAULT_PAYLOAD_VERSION: undefined });
    const response = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: "missing-config.example", keyword_default: "Quick Loan", template_version_id: "tv-1" }, env: envWithoutDefaults });
    expect(response.status).toBe(503);
  });

  it("rejects tenant defaults that violate the tenant schema", async () => {
    const invalid = makeEnv({
      DEFAULT_ACCOUNT: "Not a slug",
      DEFAULT_AID: "aid with spaces",
      DEFAULT_PREPOP_BASE: "https://prepop.test?query=1",
      DEFAULT_FORM_ROUTE: "/api/form",
      DEFAULT_AMOUNT_BUCKETS: JSON.stringify(Array.from({ length: 33 }, (_, i) => i + 100)),
    });
    const response = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: "invalid-defaults.example", keyword_default: "Quick Loan", template_version_id: "tv-1" }, env: invalid });
    expect(response.status).toBe(503);
  });

  it("normalizes apex domains and rejects www domains", async () => {
    expect((await post(employee, "/api/brands/drafts", { domain: "www.example.test", keyword_default: "Quick Loan", template_version_id: "tv-1" })).status).toBe(422);
    const response = await post(employee, "/api/brands/drafts", { domain: "apex-normalized.example.test.", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(response.status).toBe(201);
    expect((await response.json() as { brand: { domain: string } }).brand.domain).toBe("apex-normalized.example.test");
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = (SELECT brand_id FROM brands WHERE domain='apex-normalized.example.test')").first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json)).toEqual({ keyword_default: "Quick Loan" });
  });

  it("returns renderable lifecycle rows and normalizes a lowercase draft keyword", async () => {
    const response = await post(employee, "/api/brands/drafts", { domain: "renderable.test", keyword_default: "quick loan", template_version_id: "tv-1" });
    const { brand } = await response.json() as { brand: { brand_id: string } };
    const list = await call("/api/lifecycle/brands", { cookie: employee });
    const rows = (await list.json() as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
    expect(rows.find((row) => row.brand_id === brand.brand_id)).toMatchObject({ hostnames: ["renderable.test", "www.renderable.test"], runtime_sync_status: "queued" });
    expect(await env.FACTORY.prepare("SELECT keyword_default FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ keyword_default: "Quick Loan" });
  });

  it("persists dispatch failures, sends exact immutable payloads, and retries the same install", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "retry.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const missing = await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    expect(missing.status).toBe(502);
    const failed = await env.FACTORY.prepare("SELECT install_id,status,to_revision_id FROM installs WHERE brand_id = ?1").bind(brand.brand_id).first<{ install_id: string; status: string; to_revision_id: string | null }>();
    expect(failed?.status).toBe("failed");
    expect(failed?.to_revision_id).toBe(`${brand.brand_id}_rev_1`);
    expect((await call(`/api/installs/${failed!.install_id}/retry`, { cookie: employee, method: "POST" })).status).toBe(502);
    const retryAudit = await env.FACTORY.prepare("SELECT action FROM audit_log WHERE action='install.retry' AND entity_id=?1").bind(failed!.install_id).all();
    expect(retryAudit.results).toHaveLength(1);
  });

  it("creates a new retry attempt after a terminal factory receipt", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "terminal-retry.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const missing = await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const failed = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?1").bind(brand.brand_id).first<{ install_id: string }>();
    await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?1,'validate','failed','{}',?2)").bind(failed!.install_id, new Date().toISOString()).run();
    const retry = await call(`/api/installs/${failed!.install_id}/retry`, { cookie: employee, method: "POST" });
    expect(missing.status).toBe(502);
    expect(retry.status).toBe(502);
    const attempts = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?1 ORDER BY started_at").bind(brand.brand_id).all<{ install_id: string }>();
    expect(attempts.results.map((r) => r.install_id)).toHaveLength(2);
    expect(attempts.results[1]!.install_id).not.toBe(attempts.results[0]!.install_id);
  });

  it.each([false, true])("blocks retry of an original install requiring recovery before mutation (terminal receipt=%s)", async (terminalReceipt) => {
    const draft = await post(employee, "/api/brands/drafts", { domain: `retained-retry-${terminalReceipt}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const failed = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).first<{ install_id: string }>();
    const installId = failed!.install_id;
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE brands SET status='installing' WHERE brand_id=?").bind(brand.brand_id),
      env.FACTORY.prepare("UPDATE installs SET error=?,rollback_record_json=? WHERE install_id=?")
        .bind(JSON.stringify({ recovery_required: true, original_install_id: installId, compensation_install_id: `compensate-${installId}` }), JSON.stringify({ previous_revision_id: null }), installId),
      env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'rollback','failed','system',?)")
        .bind(`compensate-${installId}`, brand.brand_id, new Date().toISOString()),
    ]);
    if (terminalReceipt) await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'smoke','failed','{}',?)")
      .bind(installId, new Date().toISOString()).run();
    const snapshot = async () => ({
      brand: await env.FACTORY.prepare("SELECT * FROM brands WHERE brand_id=?").bind(brand.brand_id).first(),
      installs: (await env.FACTORY.prepare("SELECT * FROM installs WHERE brand_id=? ORDER BY install_id").bind(brand.brand_id).all()).results,
      audit: (await env.FACTORY.prepare("SELECT * FROM audit_log ORDER BY id").all()).results,
      receipts: (await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(installId).all()).results,
    });
    const before = await snapshot();
    let dispatches = 0;
    const factory = { fetch: async () => { dispatches++; return Response.json({ status: "queued" }, { status: 201 }); } } as unknown as Fetcher;
    for (const cookie of [employee, owner]) {
      const response = await call(`/api/installs/${installId}/retry`, { cookie, method: "POST", env: makeEnv({ FACTORY_WORKER: factory }) });
      expect(response.status).toBe(cookie === owner ? 409 : 403);
      if (cookie === owner) expect(await response.json()).toMatchObject({ error: "recovery_required" });
      expect(await snapshot()).toEqual(before);
    }
    expect(dispatches).toBe(0);
  });

  it("requires the original command's role to retry an upgrade install and refuses a retry while another operation is active", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "upgrade-retry.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const now = new Date().toISOString();
    const rev = `${brand.brand_id}_rev_1`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,to_revision_id,started_by,started_role,started_at) VALUES ('upg-failed',?1,'upgrade','failed',?2,'owner-1','owner',?3)").bind(brand.brand_id, rev, now).run();
    const denied = await call("/api/installs/upg-failed/retry", { cookie: employee, method: "POST" });
    expect(denied.status).toBe(403);
    expect((await env.FACTORY.prepare("SELECT status FROM installs WHERE install_id='upg-failed'").first<{ status: string }>())?.status).toBe("failed");
    expect((await env.FACTORY.prepare("SELECT action FROM audit_log WHERE action='install.retry' AND entity_id='upg-failed'").all()).results).toHaveLength(0);

    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,to_revision_id,started_by,started_at) VALUES ('other-active',?1,'install','running',?2,'employee',?3)").bind(brand.brand_id, rev, now).run();
    const blocked = await call("/api/installs/upg-failed/retry", { cookie: owner, method: "POST" });
    expect(blocked.status).toBe(409);
  });

  it("lets an Employee select a listed sealed template, create a draft and dispatch Install", async () => {
    const listed = await call("/api/templates/sealed", { cookie: employee });
    expect(listed.status).toBe(200);
    const { templates } = SealedTemplatesResponse.parse(await listed.json());
    const template = templates[0]!;
    const draft = await post(employee, "/api/brands/drafts", { domain: "dispatch.example", keyword_default: "Quick Loan", template_version_id: template.template_version_id });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    let sent: unknown;
    const worker = { fetch: async (request: Request) => { sent = await request.json(); return Response.json({ ok: true, instance_id: "ins-workflow" }); } } as unknown as Fetcher;
    const res = await call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(res.status).toBe(201);
    expect(sent).toMatchObject({ install_id: expect.stringMatching(/^ins_/), brand_id: brand.brand_id, revision_id: `${brand.brand_id}_rev_1`, started_role: "employee" });
    const row = await env.FACTORY.prepare("SELECT status FROM installs WHERE brand_id=?1 ORDER BY started_at DESC LIMIT 1").bind(brand.brand_id).first<{ status: string }>();
    expect(row?.status).toBe("running");
  });

  it.each(["owner", "employee"] as const)("rejects a second install of a live brand without new installs, Worker versions or domains (%s)", async (role) => {
    const cookie = role === "owner" ? owner : employee;
    const draft = await post(cookie, "/api/brands/drafts", { domain: `live-rerun-${role}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const revision = `${brand.brand_id}_rev_1`;
    let dispatches = 0;
    const worker = { fetch: async () => { dispatches++; return Response.json({ ok: true }); } } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER: worker });
    const install = () => call(`/api/brands/${brand.brand_id}/install`, { cookie, method: "POST", body: {}, env: testEnv });
    expect((await install()).status).toBe(201);
    const first = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).first<{ install_id: string }>();
    expect(first).not.toBeNull();

    // Simulate the factory's completed first install; no provider is contacted.
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE installs SET status='ready',finished_at=? WHERE install_id=?").bind(new Date().toISOString(), first!.install_id),
      env.FACTORY.prepare("UPDATE brands SET status='live',current_revision_id=? WHERE brand_id=?").bind(revision, brand.brand_id),
      env.FACTORY.prepare("UPDATE brand_revisions SET worker_version_id='worker-existing' WHERE revision_id=?").bind(revision),
    ]);
    expect(await env.FACTORY.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ status: "live", current_revision_id: revision });

    const snapshot = async () => ({
      brand: await env.FACTORY.prepare("SELECT * FROM brands WHERE brand_id=?").bind(brand.brand_id).first(),
      revisions: (await env.FACTORY.prepare("SELECT * FROM brand_revisions WHERE brand_id=?").bind(brand.brand_id).all()).results,
      installs: (await env.FACTORY.prepare("SELECT * FROM installs WHERE brand_id=?").bind(brand.brand_id).all()).results,
      audit: (await env.FACTORY.prepare("SELECT * FROM audit_log WHERE entity_id=?").bind(first!.install_id).all()).results,
    });
    const before = await snapshot();

    const response = await install();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", message: "Only draft or failed brands can be installed" });
    // The factory owns Worker uploads and domain attachment. No second dispatch
    // means this rejected request cannot reach either provider mutation.
    expect(dispatches).toBe(1);
    expect(await snapshot()).toEqual(before);
    const attempts = await env.FACTORY.prepare("SELECT install_id,status FROM installs WHERE brand_id=?").bind(brand.brand_id).all<{ install_id: string; status: string }>();
    expect(attempts.results).toHaveLength(1);
    expect(attempts.results).toContainEqual({ install_id: first!.install_id, status: "ready" });
    expect(await env.FACTORY.prepare("SELECT revision_id,worker_version_id FROM brand_revisions WHERE brand_id=?").bind(brand.brand_id).all()).toMatchObject({ results: [{ revision_id: revision, worker_version_id: "worker-existing" }] });
  });

  it.each(["draft", "failed", "installing", "paused", "retired"])("admits Install only for draft or failed brands (status=%s)", async (status) => {
    const draft = await post(employee, "/api/brands/drafts", { domain: `install-state-${status}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await env.FACTORY.prepare("UPDATE brands SET status=? WHERE brand_id=?").bind(status, brand.brand_id).run();
    let dispatches = 0;
    const worker = { fetch: async () => { dispatches++; return Response.json({ ok: true }); } } as unknown as Fetcher;
    const response = await call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    const admitted = status === "draft" || status === "failed";
    expect(response.status).toBe(admitted ? 201 : 409);
    expect(dispatches).toBe(admitted ? 1 : 0);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ n: admitted ? 1 : 0 });
  });

  it("rejects a second install or rollback while a lifecycle operation is active", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "active-conflict.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const now = new Date().toISOString();
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,to_revision_id,started_by,started_at) VALUES ('active-install',?1,'install','running',?2,'employee',?3)").bind(brand.brand_id, `${brand.brand_id}_rev_1`, now).run();
    const install = await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const rollback = await post(owner, `/api/brands/${brand.brand_id}/rollback`, {});
    expect(install.status).toBe(409);
    expect(rollback.status).toBe(409);
    expect(await install.json()).toMatchObject({ error: "lifecycle_operation_active", active_install_id: "active-install" });
    const rows = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?1").bind(brand.brand_id).all();
    expect(rows.results).toHaveLength(1);
  });

  it("atomically admits only one concurrent install claim", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "atomic-claim.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    let dispatches = 0;
    const worker = { fetch: async () => { dispatches += 1; await new Promise((resolve) => setTimeout(resolve, 1)); return Response.json({ ok: true }); } } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER: worker });
    const responses = await Promise.all([
      call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: testEnv }),
      call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: testEnv }),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    expect(dispatches).toBe(1);
    const rows = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?1").bind(brand.brand_id).all();
    expect(rows.results).toHaveLength(1);
  });

  it("records manual checklist attestations once and exposes lifecycle receipts", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "checklist.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const first = await post(employee, `/api/brands/${brand.brand_id}/checklist`, { item: "drain_route" });
    expect(first.status).toBe(200);
    expect((await post(employee, `/api/brands/${brand.brand_id}/checklist`, { item: "drain_route" })).status).toBe(200);
    expect((await call(`/api/lifecycle/brands/${brand.brand_id}`, { cookie: employee })).status).toBe(200);
  });

  it("returns controlled Test-sold failure and preserves receipt statuses", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "receipt.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const install = await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,to_revision_id,started_by,started_at) VALUES ('ins-receipt',?1,'install','running',?2,'employee',?3)").bind(brand.brand_id, `${brand.brand_id}_rev_1`, new Date().toISOString()).run();
    expect(install.success).toBe(true);
    await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES ('ins-receipt','smoke','skipped','{\"reason\":\"not-needed\"}',?1)").bind(new Date().toISOString()).run();
    const detail = await call("/api/installs/ins-receipt", { cookie: employee });
    expect(detail.status).toBe(200);
    const parsed = InstallWithReceipts.parse(await detail.json());
    expect(parsed).toMatchObject({ runtime_sync_status: "running", receipts: [{ status: "queued" }] });
    expect(parsed.receipts[0]).not.toHaveProperty("output");
    const sold = await call(`/api/brands/${brand.brand_id}/checklist`, { cookie: employee, method: "POST", body: { item: "test_sold", lead_id: "lead-1" }, env: makeEnv({ CORE_LIFECYCLE: { fetch: async () => { throw new Error("transport"); } } as unknown as Fetcher }) });
    expect(sold.status).toBe(502);
  });

  it("merges private core runtime state and preserves unmanaged core-only brands", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "runtime-state.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await env.FACTORY.prepare("UPDATE brands SET current_revision_id=?1 WHERE brand_id=?2").bind(`${brand.brand_id}_rev_1`, brand.brand_id).run();
    const core = { fetch: async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/lifecycle/runtime-list");
      return Response.json({ brands: [
        { brand_id: brand.brand_id, account: "test-account", hostnames: ["runtime-state.example", "www.runtime-state.example"], applied_revision_id: `${brand.brand_id}_rev_1`, paused: false, bundle_form_version: "form@abcdef1" },
        { brand_id: "core-only", account: "test-account", hostnames: ["core-only.example", "www.core-only.example"], applied_revision_id: null, paused: true, bundle_form_version: null },
      ] });
    } } as unknown as Fetcher;
    const list = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ brands: expect.arrayContaining([
      expect.objectContaining({ brand_id: brand.brand_id, runtime_sync_status: "ready" }),
      expect.objectContaining({ brand_id: "core-only", status: "unmanaged", runtime_sync_status: "ready" }),
    ]) });
  });

  it("resolves rollback target server-side and ignores a caller override", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "rollback-authority.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await env.FACTORY.prepare("UPDATE brands SET current_revision_id=?1 WHERE brand_id=?2").bind(`${brand.brand_id}_rev_1`, brand.brand_id).run();
    let sent: unknown;
    const worker = { fetch: async (request: Request) => { sent = await request.json(); return Response.json({ instance_id: "rollback" }); } } as unknown as Fetcher;
    const response = await call(`/api/brands/${brand.brand_id}/rollback`, { cookie: owner, method: "POST", body: { to_revision_id: "attacker-revision" }, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(response.status).toBe(201);
    expect(sent).toMatchObject({ to_revision_id: null });
  });

  it("uses one owner upgrade-all command and rejects employee before factory access", async () => {
    expect((await post(employee, "/api/upgrade-all", {})).status).toBe(403);
    const res = await post(owner, "/api/upgrade-all", { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-x" });
    expect(res.status).toBe(502);
    expect((await env.FACTORY.prepare("SELECT action FROM audit_log WHERE action='upgrade.failed'").all()).results.length).toBeGreaterThan(0);
  });

  it("returns 400 for a malformed percent-encoded brand id instead of throwing", async () => {
    for (const suffix of ["checklist", "installs"]) {
      const res = await call(`/api/brands/%E0%A4%A/${suffix}`, { cookie: employee });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_brand_id" });
    }
    const post400 = await post(employee, "/api/brands/%E0%A4%A/checklist", { item: "drain_route" });
    expect(post400.status).toBe(400);
  });

  it("decodes a percent-encoded brand id on GET installs and GET checklist", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "encoded-id.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const encoded = brand.brand_id.replaceAll("_", "%5F");
    expect(encoded).not.toBe(brand.brand_id);
    for (const suffix of ["installs", "checklist"]) {
      const res = await call(`/api/brands/${encoded}/${suffix}`, { cookie: employee });
      expect(res.status).toBe(200);
      expect((await res.json() as { brand_id: string }).brand_id).toBe(brand.brand_id);
    }
  });
});

 describe("Owner recovery API", () => {
   it("refuses Employees before dispatch and forwards the authenticated Owner identity", async () => {
     const requests: Array<Record<string, unknown>> = [];
     const factory = { fetch: async (request: Request) => {
       expect(new URL(request.url).pathname).toBe("/recover");
       requests.push(await request.json());
       return Response.json({ install_id: "recovery-1", brand_id: "brand-1", status: "queued" }, { status: 201 });
     } } as unknown as Fetcher;
     const invoke = (cookie: string) => call("/api/brands/brand-1/recover", { cookie, method: "POST", body: { started_role: "owner", started_by: "forged" }, env: makeEnv({ FACTORY_WORKER: factory }) });
     expect((await invoke(employee)).status).toBe(403);
     expect(requests).toHaveLength(0);
     const response = await invoke(owner);
     expect(response.status).toBe(201);
     expect(await response.json()).toMatchObject({ install_id: "recovery-1", status: "queued" });
     expect(requests).toHaveLength(1);
     expect(requests[0]).toMatchObject({ brand_id: "brand-1", started_role: "owner" });
     expect(requests[0]!.started_by).not.toBe("forged");
   });
 });
