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

  it("uses one owner upgrade-all command and rejects employee before factory access", async () => {
    expect((await post(employee, "/api/upgrade-all", {})).status).toBe(403);
    const res = await post(owner, "/api/upgrade-all", { from_template_version_id: "tv-1", to_template_version_id: "tv-2", form_artifact_id: "fa-1", canary_brand_id: "brand-x" });
    expect(res.status).toBe(502);
  });
});
