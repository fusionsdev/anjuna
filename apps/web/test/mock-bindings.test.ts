import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeployHistoryResponse, SealedTemplatesResponse, TemplateListResponse, TemplateSubmitResult } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";
import { withMockBindings } from "../src/server/mock-bindings";

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

const mockEnv = makeEnv({ MOCK_CORE: "1" });

describe("mock bindings for local preview", () => {
  it("MOCK_CORE=1 with no bindings: GET /api/lifecycle/brands has no core_error", async () => {
    const response = await call("/api/lifecycle/brands", { cookie: owner, env: mockEnv });
    expect(response.status).toBe(200);
    const body = await response.json() as { brands: { brand_id: string }[]; core_error: unknown };
    expect(body.core_error).toBeNull();
    expect(body.brands.map((b) => b.brand_id)).toContain("brand-a");
  });

  it("MOCK_CORE=1: GET /api/deploys has no unavailable source", async () => {
    const response = await call("/api/deploys", { cookie: owner, env: mockEnv });
    expect(response.status).toBe(200);
    expect(DeployHistoryResponse.parse(await response.json()).unavailable).toEqual([]);
  });

  it("MOCK_CORE=1: an install dispatch is accepted", async () => {
    const listed = await call("/api/templates/sealed", { cookie: employee, env: mockEnv });
    const { templates } = SealedTemplatesResponse.parse(await listed.json());
    const draft = await call("/api/brands/drafts", { cookie: employee, method: "POST", env: mockEnv, body: { domain: "mock-install.example", keyword_default: "Quick Loan", template_version_id: templates[0]!.template_version_id } });
    expect(draft.status).toBe(201);
    const { brand } = await draft.json() as { brand: { brand_id: string } };
    const install = await call(`/api/brands/${brand.brand_id}/install`, { cookie: employee, method: "POST", body: {}, env: mockEnv });
    expect(install.status).toBe(201);
    expect(await install.json()).toMatchObject({ brand_id: brand.brand_id, status: "running" });
    const row = await env.FACTORY.prepare("SELECT status FROM installs WHERE brand_id=?1").bind(brand.brand_id).first<{ status: string }>();
    expect(row?.status).toBe("running");
  });

  it("MOCK_CORE=1: template import from URL succeeds", async () => {
    const response = await call("/api/templates/import", { cookie: employee, method: "POST", env: mockEnv, body: { url: "https://harbor.example.com/", template_name: "Bolt Harbor" } });
    expect(response.status).toBe(200);
    expect(TemplateSubmitResult.parse(await response.json())).toMatchObject({ status: "awaiting_approval", version: 1 });
  });

  it("MOCK_CORE=1: an imported template appears in the list and its detail answers 200", async () => {
    const imported = await call("/api/templates/import", { cookie: employee, method: "POST", env: mockEnv, body: { url: "https://harbor.example.com/", template_name: "Bolt Harbor" } });
    expect(imported.status).toBe(200);
    const result = TemplateSubmitResult.parse(await imported.json());
    const listed = await call("/api/templates", { cookie: employee, env: mockEnv });
    expect(listed.status).toBe(200);
    expect(TemplateListResponse.parse(await listed.json()).templates.map((t) => t.template_version_id)).toContain(result.template_version_id);
    const detail = await call(`/api/templates/${encodeURIComponent(result.template_version_id!)}`, { cookie: employee, env: mockEnv });
    expect(detail.status).toBe(200);
  });

  it("a present CORE_LIFECYCLE binding is used even with MOCK_CORE=1", async () => {
    let calls = 0;
    const lifecycle = { fetch: async () => { calls++; return Response.json({ brands: [] }); } } as unknown as Fetcher;
    const response = await call("/api/lifecycle/brands", { cookie: owner, env: makeEnv({ MOCK_CORE: "1", CORE_LIFECYCLE: lifecycle }) });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    const merged = withMockBindings(makeEnv({ MOCK_CORE: "1", CORE_LIFECYCLE: lifecycle }));
    expect(merged.CORE_LIFECYCLE).toBe(lifecycle);
    expect(merged.FACTORY_WORKER).toBeDefined();
    expect(merged.TEMPLATE_MCP).toBeDefined();
  });

  it("MOCK_CORE=0 returns the same env object", () => {
    const off = makeEnv({ MOCK_CORE: "0" });
    expect(withMockBindings(off)).toBe(off);
    const unset = makeEnv({ MOCK_CORE: undefined });
    expect(withMockBindings(unset)).toBe(unset);
  });

  it("unknown paths answer 404 JSON", async () => {
    const merged = withMockBindings(mockEnv);
    for (const binding of [merged.CORE_LIFECYCLE, merged.FACTORY_WORKER, merged.TEMPLATE_MCP]) {
      const response = await binding!.fetch(new Request("https://x/nope", { method: "POST", body: "{}" }));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "not_found" });
    }
  });
});
