import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TemplateDetailResponse, TemplateListResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

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
    env.FACTORY.prepare(`INSERT INTO certifications (template_version_id, check_name, result, details_json, artifact_r2_key, created_at)
      SELECT * FROM (VALUES
        ('tv-bolt-1', 'lint', 'pass', '{}', NULL, ?1),
        ('tv-bolt-1', 'identity_scan', 'pass', '{"similarity":{"summary":"PASS: no sealed templates to compare against yet."}}', NULL, ?1),
        ('tv-bolt-1', 'screenshot_desktop', 'pass', '{}', ?2, ?1),
        ('tv-bolt-1', 'screenshot_mobile', 'fail', '{"error":"timeout"}', NULL, ?1))
      WHERE NOT EXISTS (SELECT 1 FROM certifications WHERE template_version_id = 'tv-bolt-1')`).bind(NOW, SHOT),
  ]);
  await env.ARTIFACTS.put(SHOT, new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
});

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
    expect((await postZip(form())).status).toBe(502);
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

  it("passes a factory refusal through and reports a missing binding", async () => {
    const FACTORY_WORKER = { fetch: async () => Response.json({ ok: false, error: "not_certified", message: "The version is rejected." }, { status: 409 }) } as unknown as Fetcher;
    const refused = await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER }) });
    expect([refused.status, await refused.json()]).toEqual([409, { ok: false, error: "not_certified", message: "The version is rejected." }]);
    expect((await call("/api/templates/tv-bolt-1/approve", { cookie: owner, method: "POST", body: {} })).status).toBe(502);
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
    expect((await call("/api/templates/import", { cookie: employee, method: "POST", body: { url: "https://harbor.example.com/", template_name: "Bolt" } })).status).toBe(502);
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
});
