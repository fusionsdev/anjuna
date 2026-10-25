import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChecklistEvidence, InstallWithReceipts, LifecycleBrandSummary, SealedTemplatesResponse } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
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

  it("lets an Employee Install (201) but refuses Employee Pause and Rollback (403)", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "emp-install.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const worker = { fetch: async () => Response.json({ ok: true, instance_id: "ins-emp" }) } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER: worker });
    expect((await call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: testEnv })).status).toBe(201);
    for (const action of ["pause", "rollback"]) {
      const response = await call(`/api/brands/${brand.brand_id}/${action}`, { cookie: employee, method: "POST", body: {}, env: testEnv });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
  });

  it("refuses Employee Rollback and Upgrade-all before any mutation or dispatch", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "owner-only.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    let dispatches = 0;
    const testEnv = makeEnv({ FACTORY_WORKER: { fetch: async () => { dispatches++; return Response.json({ ok: true }); } } as unknown as Fetcher });
    const before = await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first();
    for (const [method, path] of [["POST", `/api/brands/${brand.brand_id}/rollback`], ["POST", "/api/upgrade-all"]]) {
      const response = await call(path!, { cookie: employee, method: method!, body: {}, env: testEnv });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
    expect(dispatches).toBe(0);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first()).toEqual(before);
    expect(await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ status: "draft" });
    expect((await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).all()).results).toHaveLength(0);
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

  it("lists only the bare hostname for a draft on a subdomain, since install attaches www only at the zone apex", async () => {
    const hostnamesOf = async (domain: string) => {
      const created = await post(employee, "/api/brands/drafts", { domain, keyword_default: "Quick Loan", template_version_id: "tv-1" });
      const { brand } = await created.json() as { brand: { brand_id: string } };
      const rows = (await (await call("/api/lifecycle/brands", { cookie: employee })).json() as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
      return rows.find((row) => row.brand_id === brand.brand_id)!.hostnames;
    };
    expect(await hostnamesOf("apex-two-labels.test")).toEqual(["apex-two-labels.test", "www.apex-two-labels.test"]);
    expect(await hostnamesOf("demo06.aduplift.ai")).toEqual(["demo06.aduplift.ai"]);
    expect(await hostnamesOf("sub.demo06.aduplift.ai")).toEqual(["sub.demo06.aduplift.ai"]);
    expect(await hostnamesOf("example.co.uk")).toEqual(["example.co.uk"]);
  });

  it("returns renderable lifecycle rows and normalizes a lowercase draft keyword", async () => {
    const response = await post(employee, "/api/brands/drafts", { domain: "renderable.test", keyword_default: "quick loan", template_version_id: "tv-1" });
    const { brand } = await response.json() as { brand: { brand_id: string } };
    const list = await call("/api/lifecycle/brands", { cookie: employee });
    const rows = (await list.json() as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
    expect(rows.find((row) => row.brand_id === brand.brand_id)).toMatchObject({ hostnames: ["renderable.test", "www.renderable.test"], runtime_sync_status: "queued" });
    expect(await env.FACTORY.prepare("SELECT keyword_default FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ keyword_default: "Quick Loan" });
  });

  it("stores the supplied brand name, trims it, and audits it; without a name it derives one from the domain", async () => {
    const named = await post(employee, "/api/brands/drafts", { domain: "maple-cash.test", name: "  Maple Cash  ", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(named.status).toBe(201);
    const { brand } = await named.json() as { brand: { brand_id: string; name: string } };
    expect(brand.name).toBe("Maple Cash");
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ name: "Maple Cash" });
    const audit = await env.FACTORY.prepare("SELECT after_json FROM audit_log WHERE action='brand.create' AND entity_id=?").bind(brand.brand_id).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ domain: "maple-cash.test", name: "Maple Cash" });

    const derived = await post(employee, "/api/brands/drafts", { domain: "level-lending.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(derived.status).toBe(201);
    const { brand: fallback } = await derived.json() as { brand: { brand_id: string; name: string } };
    expect(fallback.name).toBe("level lending");
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id=?").bind(fallback.brand_id).first()).toEqual({ name: "level lending" });
  });

  it.each(["Anjuna Loans", "my AURUM cash", "<b>x", "   ", "-Leading dash", "x".repeat(61)])("rejects brand name %j with 422 and creates nothing", async (name) => {
    const before = await env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first();
    const response = await post(employee, "/api/brands/drafts", { domain: "bad-name.test", name, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid" });
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first()).toEqual(before);
  });

  it("accepts a Thai brand name with combining marks and stores it unchanged", async () => {
    const response = await post(employee, "/api/brands/drafts", { domain: "thai-name.test", name: "สินเชื่อ ด่วน", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(response.status).toBe(201);
    const { brand } = await response.json() as { brand: { brand_id: string; name: string } };
    expect(brand.name).toBe("สินเชื่อ ด่วน");
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id=?").bind(brand.brand_id).first()).toEqual({ name: "สินเชื่อ ด่วน" });
  });

  it("rejects a domain-derived brand name that contains a reserved word", async () => {
    const before = await env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first();
    const response = await post(employee, "/api/brands/drafts", { domain: "aurum-cash.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid", issues: [{ path: ["name"] }] });
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first()).toEqual(before);
  });

  it("lists the form and payload versions of a fresh draft while current_revision_id stays null", async () => {
    const response = await post(employee, "/api/brands/drafts", { domain: "fresh-draft.test", name: "Fresh Draft", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await response.json() as { brand: { brand_id: string } };
    const artifact = await env.FACTORY.prepare("SELECT fa.bundle_form_version, fa.payload_version FROM brand_revisions r JOIN form_artifacts fa ON fa.form_artifact_id=r.form_artifact_id WHERE r.revision_id=?").bind(`${brand.brand_id}_rev_1`).first<{ bundle_form_version: string; payload_version: string }>();
    expect(artifact?.bundle_form_version).toMatch(/^form@/);
    const list = await call("/api/lifecycle/brands", { cookie: employee });
    const rows = (await list.json() as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
    const expected = { current_revision_id: null, bundle_form_version: artifact!.bundle_form_version, payload_version: artifact!.payload_version, runtime_sync_status: "queued" };
    expect(rows.find((row) => row.brand_id === brand.brand_id)).toMatchObject(expected);
    const single = await call(`/api/lifecycle/brands/${brand.brand_id}`, { cookie: employee });
    expect(LifecycleBrandSummary.parse((await single.json() as { brand: unknown }).brand)).toMatchObject(expected);
  });

  it("joins the current revision when set and the first revision when current_revision_id is null", async () => {
    const at = "2026-10-02T00:00:00Z";
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-pin-2','abcdef9','forms/fa-pin-2','manifest-pin-2','2026-01','form@abcdef9','2026-09-01T00:00:00Z')"),
      env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand_pin_live','Pin Live','test-account','pin-live.test','Quick Loan','live','brand_pin_live_rev_1','owner',?1,?1)").bind(at),
      env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES ('brand_pin_failed','Pin Failed','test-account','pin-failed.test','Quick Loan','failed',NULL,'owner',?1,?1)").bind(at),
      env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand_pin_live_rev_1','brand_pin_live',1,'tv-1','fa-1','{}','owner',?1)").bind(at),
      env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand_pin_live_rev_2','brand_pin_live',2,'tv-1','fa-pin-2','{}','owner',?1)").bind(at),
      env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES ('brand_pin_failed_rev_1','brand_pin_failed',1,'tv-1','fa-1','{}','owner',?1)").bind(at),
    ]);
    const list = await call("/api/lifecycle/brands", { cookie: employee });
    const rows = (await list.json() as { brands: unknown[] }).brands.map((row) => LifecycleBrandSummary.parse(row));
    expect(rows.find((row) => row.brand_id === "brand_pin_live")).toMatchObject({ current_revision_id: "brand_pin_live_rev_1", bundle_form_version: "form@abcdef1", payload_version: "2026-01" });
    expect(rows.find((row) => row.brand_id === "brand_pin_failed")).toMatchObject({ current_revision_id: null, bundle_form_version: "form@abcdef1", payload_version: "2026-01" });
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

  it.each(["not_queued", "queued", "running"])("refuses two concurrent retries while compensation is %s without creating anything", async (compensationStatus) => {
    const draft = await post(employee, "/api/brands/drafts", { domain: `compensation-${compensationStatus.replaceAll("_", "-")}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const failed = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).first<{ install_id: string }>();
    const installId = failed!.install_id;
    await env.FACTORY.prepare("UPDATE brands SET status='installing' WHERE brand_id=?").bind(brand.brand_id).run();
    await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,'smoke','failed','{}',?)").bind(installId, new Date().toISOString()).run();
    if (compensationStatus !== "not_queued") {
      await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'rollback',?,'system',?)")
        .bind(`compensate-${installId}`, brand.brand_id, compensationStatus, new Date().toISOString()).run();
    }
    const snapshot = async () => ({
      brand: await env.FACTORY.prepare("SELECT * FROM brands WHERE brand_id=?").bind(brand.brand_id).first(),
      installs: (await env.FACTORY.prepare("SELECT * FROM installs WHERE brand_id=? ORDER BY install_id").bind(brand.brand_id).all()).results,
      receipts: (await env.FACTORY.prepare("SELECT * FROM install_receipts ORDER BY id").all()).results,
      audits: (await env.FACTORY.prepare("SELECT * FROM audit_log ORDER BY id").all()).results,
    });
    const before = await snapshot();
    let dispatches = 0;
    const factory = { async fetch() { dispatches++; return Response.json({ ok: true }); } } as unknown as Fetcher;
    const retry = () => call(`/api/installs/${installId}/retry`, { cookie: employee, method: "POST", env: makeEnv({ FACTORY_WORKER: factory }) });
    expect((await Promise.all([retry(), retry()])).map((response) => response.status)).toEqual([409, 409]);
    expect(dispatches).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it.each([false, true])("dispatches only one of two concurrent retries (receipts=%s)", async (receipted) => {
    const draft = await post(employee, "/api/brands/drafts", { domain: `concurrent-retry-${receipted}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const failed = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).first<{ install_id: string }>();
    if (receipted) {
      for (const [step, status, output] of [["validate", "ok", '{"zone_id":"local-zone"}'], ["save_rollback", "ok", '{"previous_revision_id":null}'], ["render", "failed", '{"error":"missing template"}'], ["rollback", "ok", '{"compensation":"not_required"}']] as const) {
        await env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,?,?,?,?)")
          .bind(failed!.install_id, step, status, output, new Date().toISOString()).run();
      }
      await env.FACTORY.prepare("UPDATE installs SET rollback_record_json=? WHERE install_id=?").bind('{"previous_revision_id":null}', failed!.install_id).run();
    }
    const originalReceipts = (await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(failed!.install_id).all()).results;
    const dispatched: Array<{ install_id: string }> = [];
    const receiptsAtDispatch: unknown[][] = [];
    const factory = { async fetch(request: Request) {
      const payload = await request.json() as { install_id: string };
      dispatched.push(payload);
      receiptsAtDispatch.push((await env.FACTORY.prepare("SELECT step,status,output_json FROM install_receipts WHERE install_id=? ORDER BY id").bind(payload.install_id).all()).results);
      return Response.json({ ok: true });
    } } as unknown as Fetcher;
    const retry = () => call(`/api/installs/${failed!.install_id}/retry`, { cookie: employee, method: "POST", env: makeEnv({ FACTORY_WORKER: factory }) });
    expect((await Promise.all([retry(), retry()])).map((response) => response.status).sort()).toEqual([201, 409]);
    expect(dispatched).toHaveLength(1);
    expect(receiptsAtDispatch).toEqual([receipted
      ? originalReceipts.slice(0, 2).map(({ step, status, output_json }) => ({ step, status, output_json }))
      : []]);
    const retryId = dispatched[0]!.install_id;
    const attempts = (await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).all()).results;
    expect(attempts).toHaveLength(receipted ? 2 : 1);
    const audits = (await env.FACTORY.prepare("SELECT action FROM audit_log WHERE entity_id=? AND action=?")
      .bind(retryId, receipted ? "install.start" : "install.retry").all()).results;
    expect(audits).toHaveLength(1);
    if (receipted) {
      expect((await env.FACTORY.prepare("SELECT step,status,output_json FROM install_receipts WHERE install_id=? ORDER BY id").bind(retryId).all()).results)
        .toEqual(originalReceipts.slice(0, 2).map(({ step, status, output_json }) => ({ step, status, output_json })));
      expect((await env.FACTORY.prepare("SELECT * FROM install_receipts WHERE install_id=? ORDER BY id").bind(failed!.install_id).all()).results).toEqual(originalReceipts);
      expect(await env.FACTORY.prepare("SELECT rollback_record_json FROM installs WHERE install_id=?").bind(retryId).first()).toEqual({ rollback_record_json: '{"previous_revision_id":null}' });
      // A fast failed successor must not let a stale Retry create a second child.
      await env.FACTORY.prepare("UPDATE installs SET status='failed' WHERE install_id=?").bind(retryId).run();
      expect((await retry()).status).toBe(409);
      expect(dispatched).toHaveLength(1);
    }
  });

  it.each([
    { label: "rollback receipt and compensate row", compensateRow: true, rollbackOutput: (id: string) => JSON.stringify({ compensation_install_id: `compensate-${id}`, triggered_rollback: "workflow_started" }), copied: 0 },
    { label: "rollback receipt only", compensateRow: false, rollbackOutput: (id: string) => JSON.stringify({ compensation_install_id: `compensate-${id}`, triggered_rollback: "workflow_started" }), copied: 0 },
    { label: "compensate row only", compensateRow: true, rollbackOutput: () => null, copied: 0 },
    { label: "rollback receipt says compensation not_required", compensateRow: false, rollbackOutput: () => '{"compensation":"not_required"}', copied: 9 },
  ])("retry copies the ok prefix only without compensation evidence: $label", async ({ label, compensateRow, rollbackOutput, copied }) => {
    const slug = label.replace(/[^a-z]+/g, "-");
    const draft = await post(employee, "/api/brands/drafts", { domain: `compensated-${slug}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    await post(employee, `/api/brands/${brand.brand_id}/install`, {});
    const source = await env.FACTORY.prepare("SELECT install_id FROM installs WHERE brand_id=?").bind(brand.brand_id).first<{ install_id: string }>();
    const sourceId = source!.install_id;
    const now = new Date().toISOString();
    const okSteps = ["validate", "save_rollback", "render", "upload_assets", "upload_script", "provision_runtime", "deploy", "attach_domains", "smoke"];
    const receipts: Array<[string, string, string]> = [
      ...okSteps.map((step): [string, string, string] => [step, "ok", "{}"]),
      ["sync_runtime", "failed", '{"error":"ads routing 503"}'],
    ];
    const rollback = rollbackOutput(sourceId);
    if (rollback) receipts.push(["rollback", "ok", rollback]);
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE brands SET status='failed',current_revision_id=NULL WHERE brand_id=?").bind(brand.brand_id),
      env.FACTORY.prepare("UPDATE installs SET status='failed' WHERE install_id=?").bind(sourceId),
      ...receipts.map(([step, status, output]) => env.FACTORY.prepare("INSERT INTO install_receipts (install_id,step,status,output_json,created_at) VALUES (?,?,?,?,?)")
        .bind(sourceId, step, status, output, now)),
      ...(compensateRow ? [env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,started_by,started_at) VALUES (?,?,'rollback','rolled_back','system',?)")
        .bind(`compensate-${sourceId}`, brand.brand_id, now)] : []),
    ]);
    const dispatched: Array<{ install_id: string }> = [];
    const factory = { async fetch(request: Request) { dispatched.push(await request.json() as { install_id: string }); return Response.json({ ok: true }); } } as unknown as Fetcher;
    const response = await call(`/api/installs/${sourceId}/retry`, { cookie: employee, method: "POST", env: makeEnv({ FACTORY_WORKER: factory }) });
    expect(response.status).toBe(201);
    expect(dispatched).toHaveLength(1);
    const retryId = dispatched[0]!.install_id;
    expect(retryId).not.toBe(sourceId);
    const successor = (await env.FACTORY.prepare("SELECT step FROM install_receipts WHERE install_id=? ORDER BY id").bind(retryId).all<{ step: string }>()).results.map((r) => r.step);
    expect(successor).toEqual(copied === 0 ? [] : okSteps);
    expect(successor).toHaveLength(copied);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM install_receipts WHERE install_id=?").bind(sourceId).first<{ n: number }>())?.n).toBe(receipts.length);
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
    const detail = await call(`/api/installs/${installId}`, { cookie: employee });
    expect(await detail.json()).toMatchObject({ install_id: installId, status: "failed", recovery_required: true });
  });

  it.each(["Brand not found", "{broken", null])("reports no recovery evidence for a failed rollback that released the lock (error=%s)", async (error) => {
    const draft = await post(employee, "/api/brands/drafts", { domain: `released-${crypto.randomUUID()}.example`, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const installId = `rb_${brand.brand_id}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,error,started_by,started_at) VALUES (?,?,'rollback','failed',?,'owner',?)")
      .bind(installId, brand.brand_id, error, new Date().toISOString()).run();
    const detail = await call(`/api/installs/${installId}`, { cookie: employee });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ install_id: installId, status: "failed", recovery_required: false });
  });

  it("keeps Recover available after a recovery dispatch stores a plain-text error", async () => {
    const draft = await post(employee, "/api/brands/drafts", { domain: "recovery-dispatch.example", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const installId = `recover_${brand.brand_id}`;
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,error,rollback_record_json,started_by,started_role,started_at) VALUES (?,?,'rollback','failed',?,?,'owner','owner',?)")
      .bind(installId, brand.brand_id, "Error: workflow dispatch unavailable", JSON.stringify({ recovery_of: "original-install" }), new Date().toISOString()).run();
    const detail = await call(`/api/installs/${installId}`, { cookie: owner });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ install_id: installId, status: "failed", recovery_required: true });
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

  it("returns the stored brand name in the list and the detail, hostname unchanged", async () => {
    const named = await post(employee, "/api/brands/drafts", { name: "Level Lending", domain: "level-named.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand } = await named.json() as { brand: { brand_id: string } };
    const unnamed = await post(employee, "/api/brands/drafts", { domain: "plain-fallback.test", keyword_default: "Quick Loan", template_version_id: "tv-1" });
    const { brand: other } = await unnamed.json() as { brand: { brand_id: string } };
    const list = LifecycleBrandSummary.array().parse(((await (await call("/api/lifecycle/brands", { cookie: employee })).json()) as { brands: unknown[] }).brands);
    expect(list.find((row) => row.brand_id === brand.brand_id)).toMatchObject({ name: "Level Lending", hostnames: ["level-named.test", "www.level-named.test"] });
    expect(list.find((row) => row.brand_id === other.brand_id)?.name).toBe("plain fallback");
    const detail = await call(`/api/lifecycle/brands/${brand.brand_id}`, { cookie: employee });
    expect(LifecycleBrandSummary.parse(((await detail.json()) as { brand: unknown }).brand)).toMatchObject({ name: "Level Lending" });
  });

  it("leaves name off a core-only unmanaged brand", async () => {
    const core = { fetch: async () => Response.json({ brands: [
      { brand_id: "core-nameless", account: "test-account", hostnames: ["core-nameless.example", "www.core-nameless.example"], applied_revision_id: null, paused: true, bundle_form_version: null },
    ] }) } as unknown as Fetcher;
    const list = await call("/api/lifecycle/brands", { cookie: employee, env: makeEnv({ CORE_LIFECYCLE: core }) });
    const row = (await list.json() as { brands: Array<Record<string, unknown>> }).brands.find((b) => b.brand_id === "core-nameless");
    expect(row).toBeDefined();
    expect("name" in row!).toBe(false);
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

describe("drain_route checklist computed from the core route", () => {
  const draft = async (domain: string) => {
    const response = await post(employee, "/api/brands/drafts", { domain, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    return (await response.json() as { brand: { brand_id: string } }).brand.brand_id;
  };
  const coreWith = (route: Record<string, string | null> | Error | number) => {
    const paths: string[] = [];
    const core = { fetch: async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      if (route instanceof Error) throw route;
      if (typeof route === "number") return Response.json({ error: "not_found", resource: "brand", request_id: "req_x" }, { status: route });
      const brandId = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      return Response.json({ brand: { ...brandFixture.brand, brand_id: brandId, google_ads_account: null, google_conversion_action: null, adkit_project: null, ...route } });
    } } as unknown as Fetcher;
    return { paths, env: makeEnv({ MOCK_CORE: "0", CORE: core }) };
  };
  const checklist = async (brandId: string, testEnv: ReturnType<typeof makeEnv>) => {
    const response = await call(`/api/brands/${brandId}/checklist`, { cookie: employee, env: testEnv });
    expect(response.status).toBe(200);
    return (await response.json() as { checklist: Array<Record<string, unknown>> }).checklist;
  };

  it("ticks drain_route from core when account and conversion action are set, without a D1 write", async () => {
    const brandId = await draft("route-set.example");
    const core = coreWith({ google_ads_account: "4811219623", google_conversion_action: "7754587837" });
    expect(await checklist(brandId, core.env)).toEqual([{
      item: "drain_route",
      evidence: { brand_id: brandId, item: "drain_route", actor_id: "system", verified_at: brandFixture.brand.updated_at },
      confirmed_by: "system", confirmed_role: "system", confirmed_at: brandFixture.brand.updated_at,
    }]);
    expect(core.paths).toEqual([`/admin/brands/${brandId}`]);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_checklist WHERE brand_id=?1").bind(brandId).first()).toEqual({ n: 0 });
  });

  it("adds no row when the route is half-filled or core fails", async () => {
    const brandId = await draft("route-missing.example");
    const routes: Array<Record<string, string> | number | Error> = [
      { google_ads_account: "4811219623" }, { google_conversion_action: "7754587837" }, 404, 500, new Error("transport"),
    ];
    for (const route of routes) {
      expect(await checklist(brandId, coreWith(route).env), String(route)).toEqual([]);
    }
  });

  it("keeps a stored drain_route attestation over the computed one", async () => {
    const brandId = await draft("route-attested.example");
    expect((await post(employee, `/api/brands/${brandId}/checklist`, { item: "drain_route" })).status).toBe(200);
    const rows = await checklist(brandId, coreWith({ google_ads_account: "4811219623", google_conversion_action: "7754587837" }).env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item: "drain_route", confirmed_role: "employee" });
  });

  it("serves the drain_route and leadsgate_postbacks rows from one getBrand call", async () => {
    const brandId = await draft("route-and-postback.example");
    const core = coreWith({ google_ads_account: "4811219623", google_conversion_action: "7754587837", postback_token: "global" });
    const rows = await checklist(brandId, core.env);
    expect(rows.map((row) => [row.item, row.confirmed_by])).toEqual([["drain_route", "system"], ["leadsgate_postbacks", "system:global-postback"]]);
    expect(core.paths).toEqual([`/admin/brands/${brandId}`]);
  });

  it("does not call core when both computed items are attested", async () => {
    const brandId = await draft("route-all-attested.example");
    for (const item of ["drain_route", "leadsgate_postbacks"]) {
      expect((await post(employee, `/api/brands/${brandId}/checklist`, { item })).status).toBe(200);
    }
    const core = coreWith({ google_ads_account: "4811219623", google_conversion_action: "7754587837", postback_token: "global" });
    expect((await checklist(brandId, core.env)).map((row) => row.confirmed_role)).toEqual(["employee", "employee"]);
    expect(core.paths).toEqual([]);
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

describe("checklist with the tenant postback token", () => {
  type Row = { item: string; evidence: unknown; confirmed_by: string; confirmed_role: string };
  const draft = async (domain: string) => {
    const response = await post(employee, "/api/brands/drafts", { domain, keyword_default: "Quick Loan", template_version_id: "tv-1" });
    return (await response.json() as { brand: { brand_id: string } }).brand.brand_id;
  };
  const coreWith = (outcome: string | (() => never)) => makeEnv({
    MOCK_CORE: undefined,
    CORE: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      expect(path).toMatch(/^\/admin\/brands\/[^/]+$/);
      if (typeof outcome !== "string") outcome();
      return Response.json({ brand: { ...brandFixture.brand, brand_id: decodeURIComponent(path.split("/").pop()!), postback_token: outcome } });
    } } as unknown as Fetcher,
  });
  const read = async (brandId: string, testEnv: ReturnType<typeof makeEnv>) => {
    const response = await call(`/api/brands/${brandId}/checklist`, { cookie: employee, env: testEnv });
    expect(response.status).toBe(200);
    return (await response.json() as { checklist: Row[] }).checklist;
  };

  it("ticks leadsgate_postbacks for a brand the global token covers, without writing it", async () => {
    const brandId = await draft("global-postback.example");
    for (const item of ["drain_route", "final_url"]) {
      expect((await post(employee, `/api/brands/${brandId}/checklist`, { item })).status).toBe(200);
    }
    const sold = { fetch: async () => Response.json({ verified: true, event_id: "event-global", event_at: "2026-10-21T00:00:00.000Z" }) } as unknown as Fetcher;
    expect((await call(`/api/brands/${brandId}/checklist`, { cookie: employee, method: "POST", body: { item: "test_sold", lead_id: "lead-global" }, env: makeEnv({ CORE_LIFECYCLE: sold }) })).status).toBe(200);
    const rows = await read(brandId, coreWith("global"));
    expect(rows.map((row) => row.item)).toEqual(["drain_route", "final_url", "leadsgate_postbacks", "test_sold"]);
    const computed = rows[2]!;
    expect(computed).toMatchObject({ confirmed_by: "system:global-postback", confirmed_role: "system" });
    expect(ChecklistEvidence.parse(computed.evidence)).toMatchObject({ brand_id: brandId, item: "leadsgate_postbacks", actor_id: "system:global-postback" });
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_checklist WHERE brand_id=?1 AND item='leadsgate_postbacks'").bind(brandId).first()).toEqual({ n: 0 });
  });

  it.each(["set", "not_set"])("leaves leadsgate_postbacks open when the token state is %s", async (state) => {
    const brandId = await draft(`postback-${state.replace("_", "-")}.example`);
    expect(await read(brandId, coreWith(state))).toEqual([]);
  });

  it("leaves leadsgate_postbacks open when core fails", async () => {
    const brandId = await draft("postback-core-down.example");
    expect(await read(brandId, coreWith(() => { throw new Error("transport"); }))).toEqual([]);
    const notFound = { fetch: async () => Response.json({ error: "not_found", resource: "brand" }, { status: 404 }) } as unknown as Fetcher;
    expect(await read(brandId, makeEnv({ MOCK_CORE: undefined, CORE: notFound }))).toEqual([]);
  });

  it("keeps a stored attestation over the computed one", async () => {
    const brandId = await draft("postback-stored.example");
    expect((await post(employee, `/api/brands/${brandId}/checklist`, { item: "leadsgate_postbacks" })).status).toBe(200);
    const rows = await read(brandId, coreWith("global"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item: "leadsgate_postbacks", confirmed_role: "employee" });
    expect(rows[0]!.confirmed_by).not.toBe("system:global-postback");
  });

  it("DELETE /api/brands/:id no longer answers 501 and makes no core call", async () => {
    let coreCalls = 0;
    const core = { fetch: async () => { coreCalls += 1; return new Response("{}"); } } as unknown as Fetcher;
    for (const cookie of [owner, employee]) {
      const response = await call("/api/brands/brand-1", { cookie, method: "DELETE", env: makeEnv({ CORE_LIFECYCLE: core }) });
      expect(response.status).toBe(404);
      expect(await response.json()).not.toEqual({ error: "not_implemented" });
    }
    expect(coreCalls).toBe(0);
  });
});
