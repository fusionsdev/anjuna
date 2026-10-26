import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateDetailResponse, TemplateListResponse } from "@anjuna/contracts";
import worker from "../src/server/index";
import { ORIGIN, call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-17T00:00:00.000Z";
const SHOT = "screenshots/tv-bolt-1/r/screenshot_desktop.png";
const DEFAULTS = { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Check your funding options." };
let owner: string;
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-bolt', 'Bolt Harbor', 'react_spa', 'bk_1', ?1)").bind(NOW),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at, text_defaults_json, submitted_by_key_id, submitted_by_label)
      VALUES ('tv-bolt-1', 'tpl-bolt', 1, ?1, 'templates/tpl-bolt/a.zip', 'certified', 'bk_1', ?2, ?3, 'bk_1', 'Somchai (bolt.new)')`).bind("a".repeat(64), NOW, JSON.stringify(DEFAULTS)),
    env.FACTORY.prepare("UPDATE template_versions SET theme_vars_json = NULL WHERE template_version_id = 'tv-bolt-1'"),    env.FACTORY.prepare(`INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at)
      SELECT * FROM (VALUES
        ('tv-bolt-1', 'lint', 'pass', '{}', NULL, ?1),
        ('tv-bolt-1', 'identity_scan', 'pass', '{"similarity":{"summary":"PASS: no sealed templates to compare against yet."}}', NULL, ?1),
        ('tv-bolt-1', 'screenshot_desktop', 'pass', '{}', ?2, ?1),
        ('tv-bolt-1', 'screenshot_mobile', 'fail', '{"error":"timeout"}', NULL, ?1))
      WHERE NOT EXISTS (SELECT 1 FROM certifications WHERE template_version_id = 'tv-bolt-1')`).bind(NOW, SHOT),
  ]);
  await env.ARTIFACTS.put(SHOT, new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
});

// audit_log is append-only, so tests compare counts before and after instead of clearing it.
const themeAuditCount = async () => (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-bolt-1'").first<{ n: number }>())!.n;

const sealedAuditCount = async () => (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-sealed-t'").first<{ n: number }>())!.n;
const sealedRow = () => env.FACTORY.prepare("SELECT * FROM template_versions WHERE template_version_id = 'tv-sealed-t'").first<Record<string, unknown>>();
const backfillRow = () => env.FACTORY.prepare("SELECT * FROM template_theme_vars WHERE template_version_id = 'tv-sealed-t'").first<{ theme_vars_json: string; updated_by: string }>();
/** A sealed version (immutable, TP-3) with an optional import-time map; the afterEach removes it. */
const insertSealed = (columnMap: unknown = null) => env.FACTORY.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
  VALUES ('tv-sealed-t', 'tpl-bolt', 7, ?1, 'templates/tpl-bolt/s.zip', 'sealed', 'owner', ?2, 'bk_1', ?2, ?3)`)
  .bind("c".repeat(64), NOW, columnMap === null ? null : JSON.stringify(columnMap)).run();
const putThemeVars = (cookie: string, body: unknown, id = "tv-sealed-t") => call(`/api/templates/${id}/theme-vars`, { cookie, method: "PUT", body });

const me = async (cookie: string) => ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

describe("templates API", () => {
  afterEach(async () => {
    // The counting test adds brands and versions that later list assertions must not see.
    await env.FACTORY.batch([
      env.FACTORY.prepare("DELETE FROM brand_revisions WHERE form_artifact_id = 'fa-count'"),
      env.FACTORY.prepare("DELETE FROM brands WHERE account = 'test' AND brand_id IN ('live', 'paused', 'old', 'unused', 'other')"),
      env.FACTORY.prepare("DELETE FROM form_artifacts WHERE form_artifact_id = 'fa-count'"),
      env.FACTORY.prepare("DELETE FROM template_versions WHERE template_version_id IN ('tv-bolt-2', 'tv-unrelated')"),
      env.FACTORY.prepare("DELETE FROM templates WHERE template_id = 'unrelated'"),
      env.FACTORY.prepare("DELETE FROM template_theme_vars WHERE template_version_id = 'tv-sealed-t'"),
      env.FACTORY.prepare("DELETE FROM template_versions WHERE template_version_id = 'tv-sealed-t'"),
    ]);
  });

  it("counts distinct non-retired brands across all template versions", async () => {
    await env.FACTORY.batch([
      env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at) VALUES ('tv-bolt-2', 'tpl-bolt', 2, 'sha-second', 'k2', 'draft', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('unrelated', 'Unrelated', 'astro', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at) VALUES ('tv-unrelated', 'unrelated', 1, 'sha-other', 'k3', 'draft', 'u', ?1)").bind(NOW),
      env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at) VALUES ('fa-count', 'git-count', 'forms/count', 'manifest', ?1)").bind(NOW),
    ]);
    for (const [id, status] of [["live", "live"], ["paused", "paused"], ["old", "retired"], ["unused", "draft"], ["other", "live"]]) {
      await env.FACTORY.prepare("INSERT INTO brands (brand_id, name, account, domain, status, created_by, created_at, updated_at) VALUES (?1, ?1, 'test', ?2, ?3, 'u', ?4, ?4)")
        .bind(id, `${id}.test`, status, NOW).run();
    }
    for (const [id, brand, version, revision] of [
      ["r1", "live", "tv-bolt-1", 1], ["r2", "live", "tv-bolt-2", 2], ["r3", "paused", "tv-bolt-1", 1],
      ["r4", "old", "tv-bolt-1", 1], ["r5", "other", "tv-unrelated", 1],
    ]) {
      await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at) VALUES (?1, ?2, ?3, ?4, 'fa-count', '{}', 'u', ?5)")
        .bind(id, brand, revision, version, NOW).run();
    }
    const { templates } = TemplateListResponse.parse(await (await call("/api/templates", { cookie: employee })).json());
    expect(templates.filter((t) => t.template_id === "tpl-bolt").map((t) => t.brands_using)).toEqual([2, 2]);
    expect(templates.find((t) => t.template_version_id === "tv-bolt-2")).toMatchObject({ thumbnail_url: null });
    expect(templates.find((t) => t.template_id === "unrelated")).toMatchObject({ brands_using: 1, thumbnail_url: null });
  });

  it("imports ZIP for owner and employee with session identity and an editable slug", async () => {
    const sent: FormData[] = [];
    const TEMPLATE_MCP = { fetch: async (req: Request) => {
      expect(req.url).toBe("https://template-mcp/submit-zip");
      sent.push(await req.formData());
      return Response.json({ status: "awaiting_approval", template_version_id: "tv_custom_v1", version: 1, sha256: "b".repeat(64), dashboard_url: null, issues: [], warnings: [], text_defaults: null, similarity: null, next_step: "Submitted." });
    } } as unknown as Fetcher;
    const form = () => {
      const body = new FormData();
      body.set("template_name", "Harbor");
      body.set("template_id", "custom-slug");
      body.set("file", new Blob(["zip forwarded unchanged"]), "site.zip");
      body.set("created_by", "forged-user");
      body.set("submitted_by", JSON.stringify({ key_id: "forged-key", label: "forged" }));
      return body;
    };
    const testEnv = makeEnv({ TEMPLATE_MCP });
    expect((await call("/api/templates/import-zip", { method: "POST", body: form(), env: testEnv })).status).toBe(401);
    expect(sent).toHaveLength(0);
    for (const [cookie, email] of [[owner, "owner@example.test"], [employee, "emp1@example.test"]] as const) {
      expect((await call("/api/templates/import-zip", { cookie, method: "POST", body: form(), env: testEnv })).status).toBe(200);
      const payload = sent.at(-1)!;
      expect(payload.get("template_id")).toBe("custom-slug");
      expect(payload.get("created_by")).toBe(await me(cookie));
      expect(JSON.parse(String(payload.get("submitted_by")))).toEqual({ key_id: null, label: email });
      expect(await (payload.get("file") as Blob).text()).toBe("zip forwarded unchanged");
    }
  });

  it("validates ZIP multipart and maps missing binding, service 422 and transport errors", async () => {
    const form = () => {
      const body = new FormData();
      body.set("template_name", "Harbor"); body.set("template_id", "harbor");
      body.set("file", new Blob(["zip"]), "site.zip");
      return body;
    };
    const postZip = (body: unknown, testEnv = makeEnv()) => call("/api/templates/import-zip", { cookie: employee, method: "POST", body, env: testEnv });
    expect((await postZip({})).status).toBe(422);
    const invalid = form(); invalid.set("template_id", "../evil");
    expect((await postZip(invalid)).status).toBe(422);
    const missing = form(); missing.delete("file");
    expect((await postZip(missing)).status).toBe(422);
    expect((await postZip(form(), makeEnv({ MOCK_CORE: "0" }))).status).toBe(502);
    const tooLarge = form(); tooLarge.set("file", new Blob([new Uint8Array(30 * 1024 * 1024 + 1)]), "big.zip");
    expect((await postZip(tooLarge)).status).toBe(422);
    const err = { error: "needs_build", message: "Upload the built dist folder" };
    const rejected = await postZip(form(), makeEnv({ TEMPLATE_MCP: { fetch: async () => Response.json(err, { status: 422 }) } as unknown as Fetcher }));
    expect([rejected.status, await rejected.json()]).toEqual([422, err]);
    expect((await postZip(form(), makeEnv({ TEMPLATE_MCP: { fetch: async () => { throw new Error("offline"); } } as unknown as Fetcher }))).status).toBe(502);
    expect((await postZip(form(), makeEnv({ TEMPLATE_MCP: { fetch: async () => Response.json({ ok: true }) } as unknown as Fetcher }))).status).toBe(502);
  });

  it("lists every version with its review status for owner and employee", async () => {
    expect((await call("/api/templates")).status).toBe(401);
    for (const cookie of [owner, employee]) {
      const response = await call("/api/templates", { cookie });
      expect(response.status).toBe(200);
      const { templates } = TemplateListResponse.parse(await response.json());
      expect(templates.find((t) => t.template_version_id === "tv-bolt-1")).toEqual({
        template_version_id: "tv-bolt-1", template_id: "tpl-bolt", name: "Bolt Harbor", version: 1, status: "awaiting_approval",
        submitted_by_label: "Somchai (bolt.new)", created_at: NOW, sealed_at: null,
        thumbnail_url: "/api/templates/tv-bolt-1/screenshots/desktop", brands_using: 0,
      });
    }
  });

  it("returns the detail with checks, screenshots and text defaults, and serves the screenshot", async () => {
    const detail = TemplateDetailResponse.parse(await (await call("/api/templates/tv-bolt-1", { cookie: employee })).json());
    expect(detail.template).toMatchObject({ sha256: "a".repeat(64), text_defaults: DEFAULTS, sealed_by: null });
    expect(detail.checks.map((c) => [c.check_name, c.result])).toEqual([
      ["identity_scan", "pass"], ["lint", "pass"], ["screenshot_desktop", "pass"], ["screenshot_mobile", "fail"],
    ]);
    expect(detail.screenshots).toEqual({ desktop: "/api/templates/tv-bolt-1/screenshots/desktop", mobile: null });
    const shot = await call("/api/templates/tv-bolt-1/screenshots/desktop", { cookie: employee });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await shot.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect((await call("/api/templates/tv-bolt-1/screenshots/mobile", { cookie: employee })).status).toBe(404);
    expect((await call("/api/templates/tv-missing", { cookie: employee })).status).toBe(404);
  });

  it("lets only an owner approve, through the factory with the owner's user id", async () => {
    const dispatched: Array<Record<string, string>> = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      dispatched.push({ url: req.url, ...body });
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: dispatched.length > 1 });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER });
    const denied = await call("/api/templates/tv-bolt-1/approve", { cookie: employee, method: "POST", body: {}, env: testEnv });
    expect([denied.status, await denied.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    expect(dispatched).toHaveLength(0);
    const approved = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: testEnv });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, already_sealed: false });
    expect(dispatched[0]).toEqual({ url: "https://factory/seal-template", template_version_id: "tv-bolt-1", sealed_by: await me(owner), sealed_role: "owner" });
    const again = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: testEnv });
    expect(await again.json()).toMatchObject({ ok: true, already_sealed: true });
  });

  it("approve saves corrected theme vars", async () => {
    const dispatched: unknown[] = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      dispatched.push(body);
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: false });
    } } as unknown as Fetcher;
    const themeVars = { primary: ["--brand", "--accent"], primary_dark: ["--brand-dark"], secondary: [] };
    const approved = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: { theme_vars: themeVars }, env: makeEnv({ FACTORY_WORKER }) });
    expect(approved.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    const row = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = 'tv-bolt-1'").first<{ theme_vars_json: string }>();
    expect(JSON.parse(row!.theme_vars_json)).toEqual(themeVars);
    const detail = TemplateDetailResponse.parse(await (await call("/api/templates/tv-bolt-1", { cookie: owner })).json());
    expect(detail.template.theme_vars).toEqual(themeVars);
  });

  it("approve with {} keeps the detected map", async () => {
    const detected = { primary: ["--brand"], primary_dark: ["--brand-dark"], secondary: [] };
    await env.FACTORY.prepare("UPDATE template_versions SET theme_vars_json = ?1 WHERE template_version_id = 'tv-bolt-1'").bind(JSON.stringify(detected)).run();
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: false });
    } } as unknown as Fetcher;
    const auditBefore = await themeAuditCount();
    const approved = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER }) });
    expect(approved.status).toBe(200);
    const row = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = 'tv-bolt-1'").first<{ theme_vars_json: string }>();
    expect(JSON.parse(row!.theme_vars_json)).toEqual(detected);
    expect(await themeAuditCount()).toBe(auditBefore);
  });

  it("approve does not store a map on a version that is not certified", async () => {
    await env.FACTORY.prepare("UPDATE template_versions SET status = 'rejected' WHERE template_version_id = 'tv-bolt-1'").run();
    try {
      const FACTORY_WORKER = { fetch: async () => Response.json({ ok: false, error: "not_certified", message: "The version is rejected." }, { status: 409 }) } as unknown as Fetcher;
      const themeVars = { primary: ["--brand"], primary_dark: [], secondary: [] };
      const auditBefore = await themeAuditCount();
      const refused = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: { theme_vars: themeVars }, env: makeEnv({ FACTORY_WORKER }) });
      expect(refused.status).toBe(409);
      const row = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = 'tv-bolt-1'").first<{ theme_vars_json: string | null }>();
      expect(row!.theme_vars_json).toBeNull();
      expect(await themeAuditCount()).toBe(auditBefore);
    } finally {
      await env.FACTORY.prepare("UPDATE template_versions SET status = 'certified' WHERE template_version_id = 'tv-bolt-1'").run();
    }
  });

  it("approve audits a changed theme map with before and after", async () => {
    const before = { primary: ["--old"], primary_dark: [], secondary: [] };
    const after = { primary: ["--brand"], primary_dark: [], secondary: [] };
    await env.FACTORY.prepare("UPDATE template_versions SET theme_vars_json = ?1 WHERE template_version_id = 'tv-bolt-1'").bind(JSON.stringify(before)).run();
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: false });
    } } as unknown as Fetcher;
    const auditBefore = await themeAuditCount();
    await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: { theme_vars: after }, env: makeEnv({ FACTORY_WORKER }) });
    expect(await themeAuditCount()).toBe(auditBefore + 1);
    const audit = await env.FACTORY.prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-bolt-1' ORDER BY id DESC LIMIT 1").first<{ before_json: string; after_json: string }>();
    expect([JSON.parse(audit!.before_json), JSON.parse(audit!.after_json)]).toEqual([before, after]);
  });

  it("approve rejects an invalid variable name", async () => {
    const dispatched: unknown[] = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => { dispatched.push(await req.json()); return Response.json({ ok: true }); } } as unknown as Fetcher;
    const bad = { primary: ["--ok", "color: red"], primary_dark: [], secondary: [] };
    const refused = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: { theme_vars: bad }, env: makeEnv({ FACTORY_WORKER }) });
    expect([refused.status, await refused.json()]).toEqual([422, { error: "invalid_theme_vars" }]);
    expect(dispatched).toHaveLength(0);
    const row = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = 'tv-bolt-1'").first<{ theme_vars_json: string | null }>();
    expect(row!.theme_vars_json).toBeNull();
  });

  it("approve rejects a malformed JSON body", async () => {
    const dispatched: unknown[] = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => { dispatched.push(await req.json()); return Response.json({ ok: true }); } } as unknown as Fetcher;
    const refused = await worker.fetch(new Request(`${ORIGIN}/api/templates/tv-bolt-1/approve`, {
      method: "POST", headers: { cookie: owner, origin: ORIGIN, "content-type": "application/json" }, body: "{not json",
    }), makeEnv({ FACTORY_WORKER }));
    expect([refused.status, await refused.json()]).toEqual([400, { error: "invalid_json" }]);
    expect(dispatched).toHaveLength(0);
    const row = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = 'tv-bolt-1'").first<{ theme_vars_json: string | null }>();
    expect(row!.theme_vars_json).toBeNull();
  });

  it("passes a factory refusal through and reports a missing binding", async () => {
    const FACTORY_WORKER = { fetch: async () => Response.json({ ok: false, error: "not_certified", message: "The version is rejected." }, { status: 409 }) } as unknown as Fetcher;
    const refused = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER }) });
    expect([refused.status, await refused.json()]).toEqual([409, { ok: false, error: "not_certified", message: "The version is rejected." }]);
    expect((await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: makeEnv({ MOCK_CORE: "0" }) })).status).toBe(502);
  });

  it("imports from a URL through the template MCP with the user's email as submitter", async () => {
    const sent: unknown[] = [];
    const TEMPLATE_MCP = { fetch: async (req: Request) => {
      sent.push({ url: req.url, body: await req.json() });
      return Response.json({ status: "awaiting_approval", template_version_id: "tv_bolt-harbor-2_v1", version: 1, sha256: "b".repeat(64), dashboard_url: null, issues: [], warnings: [], text_defaults: null, similarity: null, next_step: "Submitted." });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ TEMPLATE_MCP });
    const response = await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "https://harbor.example.com/", template_name: "Bolt Harbor 2" }, env: testEnv });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "awaiting_approval" });
    expect(sent).toEqual([{ url: "https://template-mcp/submit-url", body: {
      url: "https://harbor.example.com/", template_id: "bolt-harbor-2", template_name: "Bolt Harbor 2",
      submitted_by: { key_id: null, label: "emp1@example.test" }, created_by: await me(employee),
    } }]);
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "not a url", template_name: "x" }, env: testEnv })).status).toBe(422);
    expect(sent).toHaveLength(1);
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "https://harbor.example.com/", template_name: "Bolt" }, env: makeEnv({ MOCK_CORE: "0" }) })).status).toBe(502);
  });

  it("takes the sealing role and user from the session, never from the request body", async () => {
    const dispatched: Array<Record<string, string>> = [];
    const FACTORY_WORKER = { fetch: async (req: Request) => {
      const body = await req.json() as Record<string, string>;
      dispatched.push(body);
      return Response.json({ ok: true, template_version_id: body.template_version_id, sealed_by: body.sealed_by, sealed_at: NOW, already_sealed: false });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ FACTORY_WORKER });
    const forged = { sealed_by: "someone-else", sealed_role: "owner", template_version_id: "tv-other" };
    expect((await call("/api/templates/tv-bolt-1/approve", { cookie: employee, method: "POST", body: forged, env: testEnv })).status).toBe(403);
    expect(dispatched).toHaveLength(0);
    await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: forged, env: testEnv });
    expect(dispatched).toEqual([{ template_version_id: "tv-bolt-1", sealed_by: await me(owner), sealed_role: "owner" }]);
  });

  it("ignores submitter fields in the import body and uses the session user", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const TEMPLATE_MCP = { fetch: async (req: Request) => {
      sent.push(await req.json() as Record<string, unknown>);
      return Response.json({ status: "awaiting_approval", template_version_id: "tv_x_v1", version: 1, sha256: "c".repeat(64), dashboard_url: null, issues: [], warnings: [], text_defaults: null, similarity: null, next_step: "Submitted." });
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ TEMPLATE_MCP });
    const forged = { url: "https://harbor.example.com/", template_name: "Bolt", created_by: "someone-else", submitted_by: { key_id: "bk_9", label: "boss@example.test" } };
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: forged, env: testEnv })).status).toBe(200);
    expect(sent[0]).toMatchObject({ submitted_by: { key_id: null, label: "emp1@example.test" }, created_by: await me(employee) });
  });

  it("surfaces a rejected import result and a bad_url error from the import service", async () => {
    const issue = { rule: "published-url", message: "The URL did not answer.", fix: "Publish the site and retry." };
    const rejected = { status: "rejected", template_version_id: null, version: null, sha256: null, dashboard_url: null, issues: [issue], warnings: [], text_defaults: null, similarity: null, next_step: "Fix the issues and import again." };
    const body = { url: "https://harbor.example.com/", template_name: "Bolt" };
    const withMcp = (res: Response) => makeEnv({ TEMPLATE_MCP: { fetch: async () => res } as unknown as Fetcher });
    const first = await call("/api/templates/import", { cookie: employee, method: "POST", body, env: withMcp(Response.json(rejected)) });
    expect([first.status, await first.json()]).toEqual([200, rejected]);
    const err = { error: "bad_url", message: "Only public hostnames are accepted." };
    const second = await call("/api/templates/import", { cookie: employee, method: "POST", body, env: withMcp(Response.json(err, { status: 422 })) });
    expect([second.status, await second.json()]).toEqual([422, err]);
  });

  it("detect-theme-vars forwards to the template MCP for an Owner and refuses an Employee", async () => {
    const detected = { template_version_id: "tv-sealed-t", theme_vars: { primary: ["--color-royal"], primary_dark: [], secondary: [] } };
    const forwarded: Array<{ url: string; method: string; body: unknown }> = [];
    const TEMPLATE_MCP = { fetch: async (req: Request) => {
      forwarded.push({ url: req.url, method: req.method, body: await req.json() });
      return Response.json(detected);
    } } as unknown as Fetcher;
    const testEnv = makeEnv({ TEMPLATE_MCP });
    const denied = await call("/api/templates/tv-sealed-t/detect-theme-vars", { cookie: employee, method: "POST", body: {}, env: testEnv });
    expect([denied.status, await denied.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    expect(forwarded).toHaveLength(0);
    const ok = await call("/api/templates/tv-sealed-t/detect-theme-vars", { cookie: owner, method: "POST", env: testEnv });
    expect([ok.status, await ok.json()]).toEqual([200, detected]);
    expect(forwarded).toEqual([{ url: "https://template-mcp/detect-theme-vars", method: "POST", body: { template_version_id: "tv-sealed-t" } }]);
  });

  it("detect-theme-vars answers 502 on transport failure or a bad body", async () => {
    const detect = (testEnv = makeEnv()) => call("/api/templates/tv-sealed-t/detect-theme-vars", { cookie: owner, method: "POST", env: testEnv });
    const withMcp = (fetch: () => Promise<Response>) => makeEnv({ TEMPLATE_MCP: { fetch } as unknown as Fetcher });
    expect((await detect(makeEnv({ MOCK_CORE: "0" }))).status).toBe(502);
    expect((await detect(withMcp(async () => { throw new Error("offline"); }))).status).toBe(502);
    expect((await detect(withMcp(async () => Response.json({ ok: true })))).status).toBe(502);
    expect((await detect(withMcp(async () => Response.json({ template_version_id: "tv-sealed-t", theme_vars: { primary: ["--a"], primary_dark: [], secondary: [], extra: 1 } })))).status).toBe(502);
    expect((await detect(withMcp(async () => Response.json({ error: "internal" }, { status: 500 })))).status).toBe(502);
    expect((await detect(withMcp(async () => Response.json({ template_version_id: "tv-sealed-t", theme_vars: { primary: ["--a"], primary_dark: [], secondary: [] } }, { status: 201 })))).status).toBe(502);
    const missing = await detect(withMcp(async () => Response.json({ error: "not_found" }, { status: 404 })));
    expect([missing.status, await missing.json()]).toEqual([404, { error: "not_found" }]);
    const noZip = await detect(withMcp(async () => Response.json({ error: "template_zip_missing" }, { status: 422 })));
    expect([noZip.status, await noZip.json()]).toEqual([422, { error: "template_zip_missing" }]);
  });

  it("saving theme vars on a sealed version writes the backfill row and one audit row, sealed row unchanged", async () => {
    const before = { primary: ["--old"], primary_dark: [], secondary: [] };
    const next = { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: [] };
    await insertSealed(before);
    const sealedBefore = await sealedRow();
    const auditBefore = await sealedAuditCount();
    const denied = await putThemeVars(employee, { theme_vars: next });
    expect([denied.status, await denied.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    expect(await backfillRow()).toBeNull();
    const saved = await putThemeVars(owner, { theme_vars: next });
    expect([saved.status, await saved.json()]).toEqual([200, { template_version_id: "tv-sealed-t", theme_vars: next }]);
    const stored = await backfillRow();
    expect(JSON.parse(stored!.theme_vars_json)).toEqual(next);
    expect(stored!.updated_by).toBe(await me(owner));
    expect(await sealedRow()).toEqual(sealedBefore);
    expect(await sealedAuditCount()).toBe(auditBefore + 1);
    const audit = await env.FACTORY.prepare("SELECT actor_id, actor_role, entity_type, before_json, after_json FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-sealed-t' ORDER BY id DESC LIMIT 1")
      .first<{ actor_id: string; actor_role: string; entity_type: string; before_json: string; after_json: string }>();
    expect(audit).toMatchObject({ actor_id: await me(owner), actor_role: "owner", entity_type: "template_version" });
    expect([JSON.parse(audit!.before_json), JSON.parse(audit!.after_json)]).toEqual([before, next]);
    const second = { primary: ["--again"], primary_dark: [], secondary: [] };
    expect((await putThemeVars(owner, { theme_vars: second })).status).toBe(200);
    const last = await env.FACTORY.prepare("SELECT before_json FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-sealed-t' ORDER BY id DESC LIMIT 1").first<{ before_json: string }>();
    expect(JSON.parse(last!.before_json)).toEqual(next);
    expect(await sealedRow()).toEqual(sealedBefore);
  });

  it("saving theme vars with an extra body key answers 422", async () => {
    const next = { primary: ["--color-royal"], primary_dark: [], secondary: [] };
    await insertSealed();
    const refused = await putThemeVars(owner, { theme_vars: next, updated_by: "someone-else" });
    expect([refused.status, await refused.json()]).toEqual([422, { error: "invalid_theme_vars" }]);
    expect(await backfillRow()).toBeNull();
  });

  it("concurrent theme vars saves write one audit row with the right before_json", async () => {
    const column = { primary: ["--column"], primary_dark: [], secondary: [] };
    const rival = { primary: ["--rival"], primary_dark: [], secondary: [] };
    const mine = { primary: ["--mine"], primary_dark: [], secondary: [] };
    await insertSealed(column);
    const auditBefore = await sealedAuditCount();
    // The rival save lands between this request's read and its batch.
    const racing = new Proxy(env.FACTORY, { get: (target, prop) => prop === "batch"
      ? async (statements: D1PreparedStatement[]) => {
        await target.batch([
          target.prepare("INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES ('tv-sealed-t', ?1, 'rival', ?2)").bind(JSON.stringify(rival), NOW),
          target.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at)
            VALUES ('rival','owner','template.theme_vars','template_version','tv-sealed-t',?1,?2,?3)`).bind(JSON.stringify(column), JSON.stringify(rival), NOW),
        ]);
        return target.batch(statements);
      }
      : Reflect.get(target, prop).bind(target) });
    const lost = await call("/api/templates/tv-sealed-t/theme-vars", { cookie: owner, method: "PUT", body: { theme_vars: mine }, env: makeEnv({ FACTORY: racing as unknown as D1Database }) });
    expect([lost.status, await lost.json()]).toEqual([409, { error: "conflict", message: "The color map changed; reload and try again" }]);
    expect(JSON.parse((await backfillRow())!.theme_vars_json)).toEqual(rival);
    expect(await sealedAuditCount()).toBe(auditBefore + 1);
    // A retry on the fresh read succeeds and records the rival map as its before_json.
    expect((await putThemeVars(owner, { theme_vars: mine })).status).toBe(200);
    expect(await sealedAuditCount()).toBe(auditBefore + 2);
    const last = await env.FACTORY.prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'template.theme_vars' AND entity_id = 'tv-sealed-t' ORDER BY id DESC LIMIT 1").first<{ before_json: string; after_json: string }>();
    expect([JSON.parse(last!.before_json), JSON.parse(last!.after_json)]).toEqual([rival, mine]);
  });

  it("concurrent saves of the same map at the same time write one audit row", async () => {
    const column = { primary: ["--column"], primary_dark: [], secondary: [] };
    const mine = { primary: ["--mine"], primary_dark: [], secondary: [] };
    await insertSealed(column);
    const auditBefore = await sealedAuditCount();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00.000Z"));
    try {
      // The rival saves the same map with the same updated_at between this request's read and its batch.
      let rivalStatus = 0;
      const racing = new Proxy(env.FACTORY, { get: (target, prop) => prop === "batch"
        ? async (statements: D1PreparedStatement[]) => {
          rivalStatus = (await putThemeVars(owner, { theme_vars: mine })).status;
          return target.batch(statements);
        }
        : Reflect.get(target, prop).bind(target) });
      const lost = await call("/api/templates/tv-sealed-t/theme-vars", { cookie: owner, method: "PUT", body: { theme_vars: mine }, env: makeEnv({ FACTORY: racing as unknown as D1Database }) });
      expect([rivalStatus, lost.status, await lost.json()]).toEqual([200, 409, { error: "conflict", message: "The color map changed; reload and try again" }]);
    } finally {
      vi.useRealTimers();
    }
    expect(JSON.parse((await backfillRow())!.theme_vars_json)).toEqual(mine);
    expect(await sealedAuditCount()).toBe(auditBefore + 1);
  });

  it("saving the same theme vars again writes no audit row", async () => {
    const next = { primary: ["--color-royal"], primary_dark: [], secondary: [] };
    await insertSealed();
    expect((await putThemeVars(owner, { theme_vars: next })).status).toBe(200);
    const auditAfterFirst = await sealedAuditCount();
    const stored = await backfillRow();
    const again = await putThemeVars(owner, { theme_vars: next });
    expect([again.status, await again.json()]).toEqual([200, { template_version_id: "tv-sealed-t", theme_vars: next }]);
    expect(await sealedAuditCount()).toBe(auditAfterFirst);
    expect(await backfillRow()).toEqual(stored);
  });

  it("saving theme vars equal in content but stored with other key order writes nothing", async () => {
    await env.FACTORY.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
      VALUES ('tv-sealed-t', 'tpl-bolt', 7, ?1, 'templates/tpl-bolt/s.zip', 'sealed', 'owner', ?2, 'bk_1', ?2, ?3)`)
      .bind("c".repeat(64), NOW, '{ "secondary": [], "primary_dark": [], "primary": ["--x"] }').run();
    const auditBefore = await sealedAuditCount();
    const same = { primary: ["--x"], primary_dark: [], secondary: [] };
    const res = await putThemeVars(owner, { theme_vars: same });
    expect([res.status, await res.json()]).toEqual([200, { template_version_id: "tv-sealed-t", theme_vars: same }]);
    expect(await backfillRow()).toBeNull();
    expect(await sealedAuditCount()).toBe(auditBefore);
  });

  it("saving theme vars refuses a certified version with 409 and an invalid map with 422", async () => {
    const next = { primary: ["--color-royal"], primary_dark: [], secondary: [] };
    const auditBefore = await themeAuditCount();
    const certified = await putThemeVars(owner, { theme_vars: next }, "tv-bolt-1");
    expect([certified.status, await certified.json()]).toEqual([409, { error: "not_sealed" }]);
    expect((await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM template_theme_vars WHERE template_version_id = 'tv-bolt-1'").first<{ n: number }>())!.n).toBe(0);
    expect(await themeAuditCount()).toBe(auditBefore);
    await insertSealed();
    for (const body of [{ theme_vars: { primary: ["red; }"], primary_dark: [], secondary: [] } }, { theme_vars: { primary: ["--ok"] } }, {}, { theme_vars: { ...next, extra: ["--x"] } }]) {
      const refused = await putThemeVars(owner, body);
      expect([refused.status, await refused.json()], JSON.stringify(body)).toEqual([422, { error: "invalid_theme_vars" }]);
    }
    const badJson = await worker.fetch(new Request(`${ORIGIN}/api/templates/tv-sealed-t/theme-vars`, {
      method: "PUT", headers: { cookie: owner, origin: ORIGIN, "content-type": "application/json" }, body: "{not json",
    }), makeEnv());
    expect([badJson.status, await badJson.json()]).toEqual([400, { error: "invalid_json" }]);
    expect((await putThemeVars(owner, { theme_vars: next }, "tv-missing")).status).toBe(404);
    expect(await backfillRow()).toBeNull();
  });

  it("detail shows the backfilled map over the column", async () => {
    const column = { primary: ["--column"], primary_dark: [], secondary: [] };
    const backfilled = { primary: ["--backfilled"], primary_dark: ["--backfilled-dark"], secondary: [] };
    await insertSealed(column);
    const read = async () => TemplateDetailResponse.parse(await (await call("/api/templates/tv-sealed-t", { cookie: employee })).json()).template.theme_vars;
    expect(await read()).toEqual(column);
    expect((await putThemeVars(owner, { theme_vars: backfilled })).status).toBe(200);
    expect(await read()).toEqual(backfilled);
  });
});
