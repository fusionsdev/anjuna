import { env } from "cloudflare:workers";
import { BRAND_ASSET_MAX_BYTES } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
let sequence = 0;
let dispatches: Array<{ path: string; body: Record<string, unknown> }>;

const factory = { fetch: async (request: Request) => {
  dispatches.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
  return Response.json({ ok: true, instance_id: "wf" });
} } as unknown as Fetcher;
const testEnv = () => makeEnv({ FACTORY_WORKER: factory });

const TEXT_DEFAULTS = JSON.stringify({ brand_name: "Copperline", title: "Copperline | Funding", description: "Check your funding options." });

beforeAll(async () => { await setupDatabases(); });

beforeEach(async () => {
  resetState();
  dispatches = [];
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("DELETE FROM brand_assets"),
    env.FACTORY.prepare("DELETE FROM template_theme_vars"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-1','Starter','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-2','Harbor','astro','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-1','tpl-1',1,'sha-1','templates/tv-1','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,text_defaults_json,created_by,created_at) VALUES ('tv-2','tpl-2',1,'sha-2','templates/tv-2','sealed','owner','2026-10-01T00:00:00Z',?1,'owner','2026-10-01T00:00:00Z')").bind(TEXT_DEFAULTS),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at) VALUES ('tv-bare','tpl-2',3,'sha-4','templates/tv-bare','sealed','owner','2026-10-01T00:00:00Z','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,created_by,created_at) VALUES ('tv-draft','tpl-2',2,'sha-3','templates/tv-draft','draft','owner','2026-10-01T00:00:00Z')"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-1','abcdef1','forms/fa-1','manifest','2026-01','form@abcdef1','2026-10-01T00:00:00Z')"),
  ]);
});

const CONFIG = { keyword_default: "Quick Loan", text_defaults: { brand_name: "Starter", title: "Starter", description: "Starter text." }, profile: { contact: { phone: "+1 555 010 0199", address: "12 Main St", email: "help@example.com" }, ads: { google_ads_account: "1234567890" } } };

async function liveBrand(status = "live", config: object = CONFIG, name?: string): Promise<{ brandId: string; revisionId: string }> {
  const brandId = `edit-${++sequence}`;
  const revisionId = `${brandId}-rev-1`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?1,?2,'test-account',?3,'Quick Loan',?4,?5,'owner','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").bind(brandId, name ?? brandId, `${brandId}.test`, status, revisionId),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,1,'tv-1','fa-1',?3,'owner','2026-10-01T00:00:00Z')").bind(revisionId, brandId, JSON.stringify(config)),
  ]);
  return { brandId, revisionId };
}
const activeInstall = (brandId: string, revisionId: string) =>
  env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at) VALUES (?1,?2,'upgrade','running',?3,?3,'owner','owner','2026-10-02T00:00:00Z')").bind(`${brandId}-run`, brandId, revisionId).run();
const config = async (revisionId: string) => JSON.parse((await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE revision_id=?").bind(revisionId).first<{ config_json: string }>())!.config_json) as typeof CONFIG;
const auditActions = async (brandId: string) => (await env.FACTORY.prepare("SELECT action FROM audit_log WHERE entity_id=? ORDER BY id").bind(brandId).all<{ action: string }>()).results.map((row) => row.action);

describe("change the template version of a live brand (redeploy)", () => {
  const redeployWith = (cookie: string, brandId: string, body: unknown) => call(`/api/brands/${brandId}/redeploy`, { cookie, method: "POST", body, env: testEnv() });

  it("redeploy bakes the target version theme_vars", async () => {
    const themeVars = { primary: ["--brand"], primary_dark: ["--brand-dark"], secondary: [] };
    await env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,theme_vars_json,created_by,created_at) VALUES ('tv-themed','tpl-2',4,'sha-5','templates/tv-themed','sealed','owner','2026-10-01T00:00:00Z',?1,'owner','2026-10-01T00:00:00Z')")
      .bind(JSON.stringify(themeVars)).run();
    const { brandId } = await liveBrand();
    expect((await redeployWith(owner, brandId, { template_version_id: "tv-themed" })).status).toBe(201);
    const next = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<{ config_json: string }>();
    expect(JSON.parse(next!.config_json).theme_vars).toEqual(themeVars);
  });

  const backfill = (versionId: string, vars: unknown) => env.FACTORY.prepare("INSERT INTO template_theme_vars (template_version_id,theme_vars_json,updated_by,updated_at) VALUES (?1,?2,'owner','2026-10-02T00:00:00Z')").bind(versionId, JSON.stringify(vars)).run();
  const BACKFILLED = { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: ["--color-ink"] };

  it("plain redeploy bakes a backfilled map", async () => {
    await backfill("tv-1", BACKFILLED);
    const { brandId } = await liveBrand();
    expect((await redeployWith(owner, brandId, {})).status).toBe(201);
    const next = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<{ config_json: string }>();
    expect(JSON.parse(next!.config_json)).toEqual({ ...CONFIG, theme_vars: BACKFILLED });
    const viaArtifact = await liveBrand();
    expect((await redeployWith(owner, viaArtifact.brandId, { form_artifact_id: "fa-1" })).status).toBe(201);
    const artifactNext = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(viaArtifact.brandId).first<{ config_json: string }>();
    expect(JSON.parse(artifactNext!.config_json).theme_vars).toEqual(BACKFILLED);
  });

  it("plain redeploy with an unchanged map copies config_json byte for byte", async () => {
    // Same map, different key order and spacing: the parsed values match, so the stored text must not be rewritten.
    const raw = `{"theme_vars":{"secondary":["--color-ink"],"primary_dark":["--color-royal-dark"],"primary":["--color-royal"]},  "keyword_default":"Quick Loan"}`;
    await backfill("tv-1", BACKFILLED);
    const { brandId, revisionId } = await liveBrand("live", JSON.parse(raw));
    await env.FACTORY.prepare("UPDATE brand_revisions SET config_json=?1 WHERE revision_id=?2").bind(raw, revisionId).run();
    expect((await redeployWith(owner, brandId, {})).status).toBe(201);
    expect(await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first()).toEqual({ config_json: raw });
  });

  it("plain redeploy refuses with 409 when the profile changed after the map was read", async () => {
    await backfill("tv-1", BACKFILLED);
    const { brandId, revisionId } = await liveBrand();
    // The profile edit lands between the redeploy's read and its batch.
    const racing = new Proxy(env.FACTORY, { get: (target, prop) => prop === "batch"
      ? async (statements: D1PreparedStatement[]) => {
        await target.prepare("UPDATE brand_revisions SET config_json=?1 WHERE revision_id=?2").bind(JSON.stringify({ ...CONFIG, keyword_default: "Edited" }), revisionId).run();
        return target.batch(statements);
      }
      : Reflect.get(target, prop).bind(target) });
    const response = await call(`/api/brands/${brandId}/redeploy`, { cookie: owner, method: "POST", body: {}, env: makeEnv({ FACTORY_WORKER: factory, FACTORY: racing as unknown as D1Database }) });
    expect([response.status, await response.json()]).toEqual([409, expect.objectContaining({ error: "conflict" })]);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id=?").bind(brandId).first<{ n: number }>())!.n).toBe(1);
    expect(dispatches).toHaveLength(0);
  });

  it("creates revision N+1 on the chosen sealed template with its text defaults, keeps the profile and starts the upgrade install", async () => {
    const { brandId, revisionId } = await liveBrand();
    const response = await redeployWith(owner, brandId, { template_version_id: "tv-2" });
    expect(response.status).toBe(201);
    const { install_id } = await response.json() as { install_id: string };
    const next = await env.FACTORY.prepare("SELECT revision_id,template_version_id,form_artifact_id,config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<{ revision_id: string; template_version_id: string; form_artifact_id: string; config_json: string }>();
    expect(next).toMatchObject({ template_version_id: "tv-2", form_artifact_id: "fa-1" });
    const nextConfig = JSON.parse(next!.config_json) as typeof CONFIG;
    expect(nextConfig.text_defaults).toEqual(JSON.parse(TEXT_DEFAULTS));
    expect(nextConfig.profile).toEqual(CONFIG.profile);
    expect(nextConfig.keyword_default).toBe("Quick Loan");
    expect(await env.FACTORY.prepare("SELECT kind,status,from_revision_id,to_revision_id,started_role FROM installs WHERE install_id=?").bind(install_id).first())
      .toEqual({ kind: "upgrade", status: "running", from_revision_id: revisionId, to_revision_id: next!.revision_id, started_role: "owner" });
    expect(dispatches).toEqual([{ path: "/install", body: expect.objectContaining({ install_id, brand_id: brandId, revision_id: next!.revision_id }) }]);
    // The old revision stays as it was, so a failed install or a rollback returns to it.
    expect(await config(revisionId)).toEqual(CONFIG);
    expect(await env.FACTORY.prepare("SELECT current_revision_id FROM brands WHERE brand_id=?").bind(brandId).first()).toEqual({ current_revision_id: revisionId });
    const audit = await env.FACTORY.prepare("SELECT after_json FROM audit_log WHERE entity_id=? AND action='redeploy.start'").bind(install_id).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ template_version_id: "tv-2" });
  });

  it("drops the old template's text defaults when the new template has none", async () => {
    const { brandId } = await liveBrand();
    expect((await redeployWith(owner, brandId, { template_version_id: "tv-bare" })).status).toBe(201);
    const next = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<{ config_json: string }>();
    expect(JSON.parse(next!.config_json)).not.toHaveProperty("text_defaults");
  });

  it("refuses an Employee, an unsealed template, an unknown template and the template the brand already runs, with no side effects", async () => {
    const { brandId } = await liveBrand();
    const forbidden = await redeployWith(employee, brandId, { template_version_id: "tv-2" });
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    expect(await (await redeployWith(owner, brandId, { template_version_id: "tv-draft" })).json()).toEqual({ error: "template_not_sealed" });
    expect(await (await redeployWith(owner, brandId, { template_version_id: "no-such" })).json()).toEqual({ error: "template_not_sealed" });
    expect(await (await redeployWith(owner, brandId, { template_version_id: "tv-1" })).json()).toMatchObject({ error: "template_unchanged" });
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id=?").bind(brandId).first<{ n: number }>())!.n).toBe(1);
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id=?").bind(brandId).first()).toEqual({ n: 0 });
    expect(dispatches).toHaveLength(0);
  });

  it("refuses while an install is active and for a brand that is not live", async () => {
    const running = await liveBrand();
    await activeInstall(running.brandId, running.revisionId);
    const conflict = await redeployWith(owner, running.brandId, { template_version_id: "tv-2" });
    expect([conflict.status, await conflict.json()]).toEqual([409, expect.objectContaining({ error: "lifecycle_operation_active" })]);
    const draft = await liveBrand("draft");
    expect((await redeployWith(owner, draft.brandId, { template_version_id: "tv-2" })).status).toBe(409);
    expect(dispatches).toHaveLength(0);
  });

  it("still redeploys the same template with an empty body", async () => {
    const { brandId } = await liveBrand();
    expect((await redeployWith(owner, brandId, {})).status).toBe(201);
    expect(await env.FACTORY.prepare("SELECT template_version_id FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first()).toEqual({ template_version_id: "tv-1" });
  });
});

describe("GET /api/brands/:id/edit", () => {
  it("returns the template version and Microsoft Ads account of the current revision to either role", async () => {
    const { brandId } = await liveBrand("live", { ...CONFIG, profile: { ...CONFIG.profile, ads: { microsoft_ads_account: "123456789" } } });
    for (const cookie of [owner, employee]) {
      const response = await call(`/api/brands/${brandId}/edit`, { cookie });
      expect([response.status, await response.json()]).toEqual([200, { brand_id: brandId, status: "live", template_version_id: "tv-1", microsoft_ads_account: "123456789" }]);
    }
    const bare = await liveBrand("live", { keyword_default: "Quick Loan" });
    expect(await (await call(`/api/brands/${bare.brandId}/edit`, { cookie: owner })).json()).toMatchObject({ microsoft_ads_account: null });
  });

  it("answers 404 for an unknown brand and 401 without a session", async () => {
    expect((await call("/api/brands/no-such/edit", { cookie: owner })).status).toBe(404);
    expect((await call("/api/brands/no-such/edit")).status).toBe(401);
  });
});

describe("PATCH /api/brands/:id/microsoft-ads", () => {
  const patch = (cookie: string | undefined, brandId: string, body: unknown) => call(`/api/brands/${brandId}/microsoft-ads`, { cookie, method: "PATCH", body });

  it("lets the Owner set the account in the profile without touching the rest of the config or core", async () => {
    const { brandId, revisionId } = await liveBrand();
    const response = await patch(owner, brandId, { microsoft_ads_account: "987654321" });
    expect([response.status, await response.json()]).toEqual([200, { brand_id: brandId, microsoft_ads_account: "987654321", changed: true }]);
    const stored = await config(revisionId);
    expect(stored.profile).toEqual({ ...CONFIG.profile, ads: { google_ads_account: "1234567890", microsoft_ads_account: "987654321" } });
    expect({ ...stored, profile: undefined }).toEqual({ ...CONFIG, profile: undefined });
    expect(await auditActions(brandId)).toEqual(["brand.profile.ads"]);
    const row = await env.FACTORY.prepare("SELECT actor_role,before_json,after_json FROM audit_log WHERE entity_id=?").bind(brandId).first<{ actor_role: string; before_json: string; after_json: string }>();
    expect([row!.actor_role, JSON.parse(row!.before_json), JSON.parse(row!.after_json)]).toEqual(["owner", { microsoft_ads_account: null }, { microsoft_ads_account: "987654321" }]);
  });

  it("creates the profile for a brand that has none, and clears the account again", async () => {
    const { brandId, revisionId } = await liveBrand("paused", { keyword_default: "Quick Loan" });
    expect((await patch(owner, brandId, { microsoft_ads_account: "123456" })).status).toBe(200);
    expect((await config(revisionId)).profile).toEqual({ ads: { microsoft_ads_account: "123456" } });
    expect((await patch(owner, brandId, { microsoft_ads_account: null })).status).toBe(200);
    expect(await config(revisionId)).toEqual({ keyword_default: "Quick Loan", profile: {} });
    expect(await auditActions(brandId)).toEqual(["brand.profile.ads", "brand.profile.ads"]);
  });

  it("is a no-op without an audit row when the value is the same", async () => {
    const { brandId } = await liveBrand();
    expect(await (await patch(owner, brandId, { microsoft_ads_account: null })).json()).toMatchObject({ changed: false });
    expect(await auditActions(brandId)).toEqual([]);
  });

  it("refuses an Employee, a bad account number, a draft and an active install, leaving the config as it was", async () => {
    const { brandId, revisionId } = await liveBrand();
    const forbidden = await patch(employee, brandId, { microsoft_ads_account: "987654321" });
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: "forbidden_role", required_role: "owner" }]);
    for (const bad of ["12345", "1234567890123", "12a456", 123456, undefined]) expect((await patch(owner, brandId, { microsoft_ads_account: bad })).status).toBe(422);
    expect((await patch(owner, brandId, { microsoft_ads_account: "987654321", extra: true })).status).toBe(422);
    const draft = await liveBrand("draft");
    expect((await patch(owner, draft.brandId, { microsoft_ads_account: "987654321" })).status).toBe(409);
    await activeInstall(brandId, revisionId);
    expect((await patch(owner, brandId, { microsoft_ads_account: "987654321" })).status).toBe(409);
    expect(await config(revisionId)).toEqual(CONFIG);
    expect(await auditActions(brandId)).toEqual([]);
    expect((await patch(owner, "no-such", { microsoft_ads_account: "987654321" })).status).toBe(404);
    expect((await patch(undefined, brandId, { microsoft_ads_account: "987654321" })).status).toBe(401);
  });

  it("carries the account into the next redeploy", async () => {
    const { brandId } = await liveBrand();
    await patch(owner, brandId, { microsoft_ads_account: "987654321" });
    expect((await call(`/api/brands/${brandId}/redeploy`, { cookie: owner, method: "POST", body: {}, env: testEnv() })).status).toBe(201);
    const next = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id=? AND revision=2").bind(brandId).first<{ config_json: string }>();
    expect(JSON.parse(next!.config_json).profile.ads.microsoft_ads_account).toBe("987654321");
  });
});

describe("logo and favicon", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 104, 4]);
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`;
  const upload = (cookie: string | undefined, brandId: string, kind: string, bytes: BlobPart, name = "file.bin") => {
    const form = new FormData();
    form.set("file", new File([bytes], name));
    return call(`/api/brands/${brandId}/assets/${kind}`, { cookie, method: "PUT", body: form });
  };
  const rows = async (brandId: string) => (await env.FACTORY.prepare("SELECT kind,content_type,byte_length FROM brand_assets WHERE brand_id=? ORDER BY kind").bind(brandId).all()).results;

  it("stores a PNG logo and an ICO favicon uploaded by an Employee, lists them and returns the same bytes", async () => {
    const { brandId } = await liveBrand();
    const logo = await upload(employee, brandId, "logo", PNG);
    expect(logo.status).toBe(200);
    expect(await logo.json()).toEqual({ asset: { kind: "logo", content_type: "image/png", byte_length: PNG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), updated_at: expect.any(String) } });
    expect((await upload(employee, brandId, "favicon", ICO)).status).toBe(200);
    expect(await rows(brandId)).toEqual([{ kind: "favicon", content_type: "image/x-icon", byte_length: ICO.length }, { kind: "logo", content_type: "image/png", byte_length: PNG.length }]);
    const list = await call(`/api/brands/${brandId}/assets`, { cookie: employee });
    expect((await list.json() as { assets: unknown[] }).assets).toHaveLength(2);
    const bytes = await call(`/api/brands/${brandId}/assets/logo`, { cookie: owner });
    expect([bytes.status, bytes.headers.get("content-type"), bytes.headers.get("x-content-type-options"), bytes.headers.get("cache-control")]).toEqual([200, "image/png", "nosniff", "private, no-store"]);
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([...PNG]);
    expect(await auditActions(brandId)).toEqual(["brand.asset.put", "brand.asset.put"]);
  });

  it("takes the type from the bytes, not from the file name, and replaces an earlier upload", async () => {
    const { brandId } = await liveBrand();
    await upload(owner, brandId, "logo", PNG, "logo.svg");
    expect(await rows(brandId)).toEqual([{ kind: "logo", content_type: "image/png", byte_length: PNG.length }]);
    const logo = svg("<rect width='8' height='8'/>");
    expect((await upload(owner, brandId, "logo", logo, "logo.png")).status).toBe(200);
    expect(await rows(brandId)).toEqual([{ kind: "logo", content_type: "image/svg+xml", byte_length: logo.length }]);
  });

  it("rejects a logo that contains another brand's name, in text or in a PNG comment, and stores nothing", async () => {
    await liveBrand("live", CONFIG, "Level Lending");
    const { brandId } = await liveBrand();
    const named = await upload(owner, brandId, "logo", svg("<text x='1' y='5'>LEVEL LENDING</text>"));
    expect(named.status).toBe(422);
    expect(await named.json()).toMatchObject({ error: "invalid_asset", code: "brand_clean", issues: [expect.stringContaining("level lending")] });
    const png = Uint8Array.from([...PNG, ...new TextEncoder().encode("tEXtComment\0Level Lending")]);
    expect((await upload(owner, brandId, "favicon", png)).status).toBe(422);
    expect(await rows(brandId)).toEqual([]);
    expect(await auditActions(brandId)).toEqual([]);
  });

  it("rejects another brand's domain and id, the platform names and an analytics key", async () => {
    const other = await liveBrand();
    const { brandId } = await liveBrand();
    for (const inner of [`<desc>${other.brandId}.test</desc>`, `<desc>${other.brandId}</desc>`, "<desc>Anjuna</desc>", "<desc>AURUM</desc>", "<desc>phc_abcdefghijklmnop</desc>"]) {
      const response = await upload(owner, brandId, "logo", svg(inner));
      expect([response.status, (await response.json() as { code: string }).code], inner).toEqual([422, "brand_clean"]);
    }
    expect(await rows(brandId)).toEqual([]);
  });

  it("does not count the brand's own name as another brand's", async () => {
    const { brandId } = await liveBrand("live", CONFIG, "Harbor Cash");
    expect((await upload(owner, brandId, "logo", svg("<text>Harbor Cash</text>"))).status).toBe(200);
  });

  it("rejects an SVG with script or outside references, unknown bytes and an empty file", async () => {
    const { brandId } = await liveBrand();
    for (const bytes of [svg("<script>alert(1)</script>"), svg("<image href='https://x.test/a.png'/>"), "GIF89a....", new Uint8Array()]) {
      const response = await upload(owner, brandId, "logo", bytes);
      expect(response.status, String(bytes)).toBe(422);
      expect(await response.json()).toMatchObject({ error: "invalid_asset" });
    }
    expect(await rows(brandId)).toEqual([]);
  });

  it("enforces the size cap per kind", async () => {
    const { brandId } = await liveBrand();
    const png = (size: number) => { const bytes = new Uint8Array(size); bytes.set(PNG); return bytes; };
    const faviconTooBig = await upload(owner, brandId, "favicon", png(BRAND_ASSET_MAX_BYTES.favicon + 1));
    expect([faviconTooBig.status, (await faviconTooBig.json() as { code: string }).code]).toEqual([422, "too_large"]);
    expect((await upload(owner, brandId, "logo", png(BRAND_ASSET_MAX_BYTES.favicon + 1))).status).toBe(200);
    expect((await upload(owner, brandId, "logo", png(BRAND_ASSET_MAX_BYTES.logo))).status).toBe(200);
    const huge = await upload(owner, brandId, "logo", png(BRAND_ASSET_MAX_BYTES.logo + 64 * 1024));
    expect([huge.status, (await huge.json() as { code: string }).code]).toEqual([413, "too_large"]);
    const oversize = await upload(owner, brandId, "logo", png(BRAND_ASSET_MAX_BYTES.logo + 1));
    expect([oversize.status, (await oversize.json() as { code: string }).code]).toEqual([422, "too_large"]);
  });

  it("removes an asset, so the brand serves the generated icon again", async () => {
    const { brandId } = await liveBrand();
    await upload(employee, brandId, "favicon", ICO);
    const removed = await call(`/api/brands/${brandId}/assets/favicon`, { cookie: employee, method: "DELETE" });
    expect([removed.status, await removed.json()]).toEqual([200, { brand_id: brandId, kind: "favicon", removed: true }]);
    expect(await rows(brandId)).toEqual([]);
    expect((await call(`/api/brands/${brandId}/assets/favicon`, { cookie: employee, method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/brands/${brandId}/assets/favicon`, { cookie: employee })).status).toBe(404);
    expect(await auditActions(brandId)).toEqual(["brand.asset.put", "brand.asset.delete"]);
  });

  it("answers 400, 404, 415-style errors and 401 for bad requests", async () => {
    const { brandId } = await liveBrand();
    expect((await upload(undefined, brandId, "logo", PNG)).status).toBe(401);
    expect((await upload(owner, "no-such", "logo", PNG)).status).toBe(404);
    expect((await upload(owner, brandId, "banner", PNG)).status).toBe(404);
    expect((await call(`/api/brands/${brandId}/assets/logo`, { cookie: owner, method: "PUT", body: { file: "x" } })).status).toBe(422);
    const noFile = new FormData();
    noFile.set("other", "x");
    expect((await call(`/api/brands/${brandId}/assets/logo`, { cookie: owner, method: "PUT", body: noFile })).status).toBe(422);
    expect((await call(`/api/brands/${brandId}/assets/logo`, { cookie: owner, method: "POST", body: {} })).status).toBe(404);
    expect((await call("/api/brands/%E0%A4%A/assets", { cookie: owner })).status).toBe(400);
  });

  it("does not store for a retired brand", async () => {
    const { brandId } = await liveBrand("retired");
    expect((await upload(owner, brandId, "logo", PNG)).status).toBe(409);
  });
});
