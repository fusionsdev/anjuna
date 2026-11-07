import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-v1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-v1','tpl-v1',1,'sha-v1','templates/tv-v1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-v1','abcdef1','forms/fa-v1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

interface CreatedKey { key: { key_id: string; label: string; scopes: string[]; secret: string } }

async function mintKey(scopes: string[], label = "Bot"): Promise<CreatedKey["key"]> {
  const response = await call("/api/api-keys", { cookie: owner, method: "POST", body: { label, scopes } });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreatedKey).key;
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** Every wizard field except the Microsoft Ads account, which moved to the global settings. */
const FULL_DRAFT = {
  name: "Maple Cash",
  domain: "maple-v1.example",
  keyword_default: "Quick Loan",
  template_version_id: "tv-v1",
  profile: {
    contact: { phone: "+1 555 0100", address: "1 Main St, Dallas TX", email: "help@maple-v1.example" },
    copy: {
      brand_name: "Maple Cash", site_title: "Maple Cash | Quick Funding", site_description: "See your options in minutes.",
      h1: "{{keyword}} When You Need It", cta: "Check my rate", sub: "Fast answers, no paperwork",
    },
    ads: { google_ads_account: "1234567890", google_conversion_action: "7300000001", adkit_project: "proj_a" },
    theme: { primary: "#f83808", secondary: "#111111" },
  },
};

/** A core stand-in for the AdKit admin routes: records each request and answers contract-valid bodies. */
function adkitCore() {
  const seen: Array<{ method: string; path: string; role: string | null; actor: string | null; body: unknown }> = [];
  const now = "2026-11-07T08:00:00.000Z";
  const core = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json();
      seen.push({ method: request.method, path: url.pathname, role: request.headers.get("x-actor-role"), actor: request.headers.get("x-actor-id"), body });
      if (url.pathname === "/admin/adkit/projects") return Response.json({ items: [{ id: "proj_a", name: "Project A", currency: null, updated_at: now }], synced_at: now });
      if (url.pathname.startsWith("/admin/adkit/projects/")) return Response.json({ items: [{ id: "1234567890", name: "Main", currency: "THB", updated_at: now }], synced_at: now });
      if (url.pathname === "/admin/adkit/jobs") {
        const { brand_draft_id } = body as { brand_draft_id: string };
        return Response.json({
          created: true,
          job: {
            id: "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f", kind: "conversion_action.create", status: "queued",
            payload: { brand_draft_id, account: "1234567890", project: "proj_a", name: "cv-0123456789abcdef" },
            result: null, attempts: 0, idempotency_key: `conversion_action.create:${brand_draft_id}`, requested_by: "x",
            next_attempt_at: null, created_at: now, updated_at: now,
          },
        }, { status: 201 });
      }
      return Response.json({ error: "not_found", resource: "route" }, { status: 404 });
    },
  } as unknown as Fetcher;
  return { seen, env: makeEnv({ MOCK_CORE: "0", CORE: core }) };
}

describe("API keys (owner)", () => {
  it("shows the key once, stores only its SHA-256 and keeps it out of the list and the audit row", async () => {
    const key = await mintKey(["brand:draft", "adkit:read"], "Ops bot");
    expect(key.secret).toMatch(/^anj_api_[A-Za-z0-9_-]{43}$/);
    expect(key.scopes).toEqual(["brand:draft", "adkit:read"]);

    const stored = await env.FACTORY.prepare("SELECT * FROM api_keys WHERE key_id = ?1").bind(key.key_id).first<Record<string, unknown>>();
    expect(stored!.key_hash).toBe(createHash("sha256").update(key.secret).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(key.secret);

    const listed = await (await call("/api/api-keys", { cookie: owner })).text();
    expect(listed).toContain(key.key_id);
    expect(listed).not.toContain(key.secret);
    expect(listed).not.toContain(String(stored!.key_hash));

    const audit = await env.FACTORY.prepare("SELECT action, after_json FROM audit_log WHERE entity_id = ?1").bind(key.key_id).all<{ action: string; after_json: string }>();
    expect(audit.results).toEqual([{ action: "api_key.create", after_json: JSON.stringify({ label: "Ops bot", scopes: ["brand:draft", "adkit:read"] }) }]);
  });

  it("refuses an employee, an unknown scope and an empty scope list", async () => {
    expect((await call("/api/api-keys", { cookie: employee })).status).toBe(403);
    expect((await call("/api/api-keys", { cookie: employee, method: "POST", body: { label: "x", scopes: ["brand:draft"] } })).status).toBe(403);
    expect((await call("/api/api-keys", { cookie: owner, method: "POST", body: { label: "x", scopes: ["brand:delete"] } })).status).toBe(422);
    expect((await call("/api/api-keys", { cookie: owner, method: "POST", body: { label: "x", scopes: [] } })).status).toBe(422);
  });

  it("a revoked key gets 401", async () => {
    const key = await mintKey(["adkit:read"]);
    const core = adkitCore();
    expect((await call("/api/v1/adkit/projects", { headers: bearer(key.secret), env: core.env })).status).toBe(200);
    expect((await call(`/api/api-keys/${key.key_id}/revoke`, { cookie: owner, method: "POST", body: {} })).status).toBe(200);
    expect((await call("/api/v1/adkit/projects", { headers: bearer(key.secret), env: core.env })).status).toBe(401);
  });
});

describe("/api/v1 auth", () => {
  it("takes the key from the Authorization bearer header only, never from the query string or another header", async () => {
    const key = await mintKey(["adkit:read"]);
    const core = adkitCore();
    const inQuery = await call(`/api/v1/adkit/projects?key=${key.secret}`, { env: core.env });
    expect(inQuery.status).toBe(400);
    expect(await inQuery.json()).toEqual({ error: "key_in_query" });
    expect((await call(`/api/v1/adkit/projects?token=${key.secret}`, { headers: bearer(key.secret), env: core.env })).status).toBe(400);
    expect((await call("/api/v1/adkit/projects", { headers: { "x-api-key": key.secret }, env: core.env })).status).toBe(401);
    expect((await call("/api/v1/adkit/projects", { headers: bearer("anj_api_not-a-real-key"), env: core.env })).status).toBe(401);
    expect((await call("/api/v1/adkit/projects", { headers: { authorization: `Basic ${key.secret}` }, env: core.env })).status).toBe(401);
    expect(core.seen).toHaveLength(0);
  });

  it("records last_used_at and never echoes the key in a response", async () => {
    const key = await mintKey(["adkit:read"]);
    const core = adkitCore();
    const response = await call("/api/v1/adkit/projects", { headers: bearer(key.secret), env: core.env });
    expect(await response.text()).not.toContain(key.secret);
    const row = await env.FACTORY.prepare("SELECT last_used_at FROM api_keys WHERE key_id = ?1").bind(key.key_id).first<{ last_used_at: string | null }>();
    expect(row!.last_used_at).toEqual(expect.any(String));
  });
});

describe("/api/v1 drafts", () => {
  it("a brand:draft key creates a draft with every wizard field set", async () => {
    const key = await mintKey(["brand:draft"]);
    const created = await call("/api/v1/brands/drafts", { headers: bearer(key.secret), method: "POST", body: FULL_DRAFT });
    expect(created.status).toBe(201);
    const { brand } = (await created.json()) as { brand: { brand_id: string } };

    const draft = await (await call(`/api/wizard/drafts/${brand.brand_id}`, { cookie: owner })).json() as {
      brand: { name: string; domain: string; keyword_default: string }; revision: { template_version_id: string }; profile: unknown;
    };
    expect(draft.brand).toMatchObject({ name: FULL_DRAFT.name, domain: FULL_DRAFT.domain, keyword_default: FULL_DRAFT.keyword_default });
    expect(draft.revision.template_version_id).toBe("tv-v1");
    expect(draft.profile).toEqual(FULL_DRAFT.profile);

    const audit = await env.FACTORY.prepare("SELECT actor_id FROM audit_log WHERE entity_id = ?1 AND action = 'brand.create'").bind(brand.brand_id).first<{ actor_id: string }>();
    expect(audit!.actor_id).toBe(key.key_id);
    const all = await env.FACTORY.prepare("SELECT group_concat(COALESCE(before_json,'') || COALESCE(after_json,''), '') AS text FROM audit_log").first<{ text: string }>();
    expect(all!.text).not.toContain(key.secret);
  });

  it("a brand:draft key edits the draft; a key without the scope gets 403", async () => {
    const key = await mintKey(["brand:draft"]);
    const created = await call("/api/v1/brands/drafts", { headers: bearer(key.secret), method: "POST", body: { ...FULL_DRAFT, domain: "patch-v1.example" } });
    const { brand } = (await created.json()) as { brand: { brand_id: string } };
    const patched = await call(`/api/v1/brands/${brand.brand_id}/draft`, { headers: bearer(key.secret), method: "PATCH", body: { keyword_default: "Cash Today" } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { brand: { keyword_default: string } }).brand.keyword_default).toBe("Cash Today");

    const other = await mintKey(["adkit:read"]);
    const denied = await call("/api/v1/brands/drafts", { headers: bearer(other.secret), method: "POST", body: { ...FULL_DRAFT, domain: "denied-v1.example" } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden_scope", required_scope: "brand:draft" });
  });
});

describe("/api/v1 generate", () => {
  async function draftId(domain: string): Promise<string> {
    const response = await call("/api/brands/drafts", { cookie: owner, method: "POST", body: { ...FULL_DRAFT, domain } });
    expect(response.status).toBe(201);
    return ((await response.json()) as { brand: { brand_id: string } }).brand.brand_id;
  }
  const factoryEnv = () => makeEnv({ FACTORY_WORKER: { fetch: async () => Response.json({ ok: true }) } as unknown as Fetcher });

  it("a key without brand:generate gets 403 and starts nothing", async () => {
    const brandId = await draftId("gen-denied-v1.example");
    const key = await mintKey(["brand:draft", "adkit:read", "adkit:conversion"]);
    const response = await call(`/api/v1/brands/${brandId}/generate`, { headers: bearer(key.secret), method: "POST", body: {}, env: factoryEnv() });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_scope", required_scope: "brand:generate" });
    expect((await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM installs WHERE brand_id = ?1").bind(brandId).first<{ n: number }>())!.n).toBe(0);
  });

  it("an employee session gets 403; an owner session and a brand:generate key start the install", async () => {
    const forEmployee = await draftId("gen-emp-v1.example");
    expect((await call(`/api/v1/brands/${forEmployee}/generate`, { cookie: employee, method: "POST", body: {}, env: factoryEnv() })).status).toBe(403);

    const forOwner = await draftId("gen-owner-v1.example");
    expect((await call(`/api/v1/brands/${forOwner}/generate`, { cookie: owner, method: "POST", body: {}, env: factoryEnv() })).status).toBe(201);

    const forKey = await draftId("gen-key-v1.example");
    const key = await mintKey(["brand:generate"]);
    expect((await call(`/api/v1/brands/${forKey}/generate`, { headers: bearer(key.secret), method: "POST", body: {}, env: factoryEnv() })).status).toBe(201);
  });
});

describe("/api/v1 adkit", () => {
  it("adkit:read lists projects and accounts through core; the key acts as its own actor", async () => {
    const key = await mintKey(["adkit:read"]);
    const core = adkitCore();
    const projects = await call("/api/v1/adkit/projects", { headers: bearer(key.secret), env: core.env });
    expect(projects.status).toBe(200);
    expect(((await projects.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(["proj_a"]);
    const accounts = await call("/api/v1/adkit/projects/proj_a/accounts", { headers: bearer(key.secret), env: core.env });
    expect(accounts.status).toBe(200);
    expect(core.seen.map((s) => [s.path, s.actor])).toEqual([["/admin/adkit/projects", key.key_id], ["/admin/adkit/projects/proj_a/accounts", key.key_id]]);

    const noScope = await mintKey(["brand:draft"]);
    expect((await call("/api/v1/adkit/projects", { headers: bearer(noScope.secret), env: core.env })).status).toBe(403);
    expect((await call("/api/v1/adkit/projects", { cookie: employee, env: core.env })).status).toBe(403);
    expect((await call("/api/v1/adkit/projects", { cookie: owner, env: core.env })).status).toBe(200);
  });

  it("adkit:conversion queues one conversion_action.create job for the draft", async () => {
    const key = await mintKey(["adkit:conversion"]);
    const core = adkitCore();
    const response = await call("/api/v1/adkit/conversion-actions", { headers: bearer(key.secret), method: "POST", body: { brand_draft_id: "brand_0123456789abcdef" }, env: core.env });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { job: { status: string } }).job.status).toBe("queued");
    expect(core.seen).toEqual([expect.objectContaining({ method: "POST", path: "/admin/adkit/jobs", body: { kind: "conversion_action.create", brand_draft_id: "brand_0123456789abcdef" } })]);

    const readOnly = await mintKey(["adkit:read"]);
    expect((await call("/api/v1/adkit/conversion-actions", { headers: bearer(readOnly.secret), method: "POST", body: { brand_draft_id: "brand_0123456789abcdef" }, env: core.env })).status).toBe(403);
    expect(core.seen).toHaveLength(1);
  });
});

describe("global Microsoft Ads account setting", () => {
  it("is owner only, validates the id, clears with null and writes an audit row", async () => {
    expect((await call("/api/settings/microsoft-ads", { cookie: employee })).status).toBe(403);
    expect((await call("/api/settings/microsoft-ads", { cookie: employee, method: "PUT", body: { microsoft_ads_account: "123456" } })).status).toBe(403);
    expect(await (await call("/api/settings/microsoft-ads", { cookie: owner })).json()).toEqual({ microsoft_ads_account: null, updated_at: null });
    expect((await call("/api/settings/microsoft-ads", { cookie: owner, method: "PUT", body: { microsoft_ads_account: "12-34" } })).status).toBe(422);

    const saved = await call("/api/settings/microsoft-ads", { cookie: owner, method: "PUT", body: { microsoft_ads_account: "123456" } });
    expect(saved.status).toBe(200);
    expect(await (await call("/api/settings/microsoft-ads", { cookie: owner })).json()).toMatchObject({ microsoft_ads_account: "123456", updated_at: expect.any(String) });
    expect((await call("/api/settings/microsoft-ads", { cookie: owner, method: "PUT", body: { microsoft_ads_account: null } })).status).toBe(200);
    expect(await (await call("/api/settings/microsoft-ads", { cookie: owner })).json()).toMatchObject({ microsoft_ads_account: null });

    const audit = await env.FACTORY.prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'settings.microsoft_ads_account' ORDER BY id").all<{ before_json: string; after_json: string }>();
    expect(audit.results.map((r) => [JSON.parse(r.before_json), JSON.parse(r.after_json)])).toEqual([
      [{ microsoft_ads_account: null }, { microsoft_ads_account: "123456" }],
      [{ microsoft_ads_account: "123456" }, { microsoft_ads_account: null }],
    ]);
  });
});
