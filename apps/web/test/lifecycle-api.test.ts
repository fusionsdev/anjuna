import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

  it("rejects draft creation when tenant runtime defaults are not configured", async () => {
    const envWithoutDefaults = makeEnv({ DEFAULT_ACCOUNT: undefined, DEFAULT_AID: undefined, DEFAULT_PREPOP_BASE: undefined, DEFAULT_FORM_ROUTE: undefined, DEFAULT_AMOUNT_BUCKETS: undefined, DEFAULT_PAYLOAD_VERSION: undefined });
    const response = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: "missing-config.example", keyword_default: "Quick Loan", template_version_id: "tv-1" }, env: envWithoutDefaults });
    expect(response.status).toBe(503);
  });

  it("normalizes apex domains and rejects www domains", async () => {
    expect((await post(employee, "/api/brands/drafts", { domain: "www.example.test", keyword_default: "Quick Loan", template_version_id: "tv-1" })).status).toBe(422);
    const response = await post(employee, "/api/brands/drafts", { domain: "apex-normalized.example.test.", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(response.status).toBe(201);
    expect((await response.json() as { brand: { domain: string } }).brand.domain).toBe("apex-normalized.example.test");
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = (SELECT brand_id FROM brands WHERE domain='apex-normalized.example.test')").first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json)).toMatchObject({ form_route: "/request", amount_buckets: [100, 200, 300, 500, 1000], aid: "30003" });
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

  it("acknowledges a successful Workflow dispatch only after sending the exact command", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "dispatch.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    let sent: unknown;
    const worker = { fetch: async (request: Request) => { sent = await request.json(); return Response.json({ ok: true, instance_id: "ins-workflow" }); } } as unknown as Fetcher;
    const res = await call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(res.status).toBe(201);
    expect(sent).toMatchObject({ install_id: expect.stringMatching(/^ins_/), brand_id: brand.brand_id, revision_id: `${brand.brand_id}_rev_1`, started_role: "employee" });
    const row = await env.FACTORY.prepare("SELECT status FROM installs WHERE brand_id=?1 ORDER BY started_at DESC LIMIT 1").bind(brand.brand_id).first<{ status: string }>();
    expect(row?.status).toBe("running");
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
    expect((await detail.json() as { receipts: unknown[] }).receipts[0]).toMatchObject({ status: "queued", output: { reason: "not-needed" } });
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
    const response = await call(`/api/brands/${brand.brand_id}/rollback`, { cookie: employee, method: "POST", body: { to_revision_id: "attacker-revision" }, env: makeEnv({ FACTORY_WORKER: worker }) });
    expect(response.status).toBe(201);
    expect(sent).toMatchObject({ to_revision_id: null });
  });

  it("uses one owner upgrade-all command and rejects employee before factory access", async () => {
    expect((await post(employee, "/api/upgrade-all", {})).status).toBe(403);
    const res = await post(owner, "/api/upgrade-all", { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-x" });
    expect(res.status).toBe(502);
    expect((await env.FACTORY.prepare("SELECT action FROM audit_log WHERE action='upgrade.failed'").all()).results.length).toBeGreaterThan(0);
  });
});
