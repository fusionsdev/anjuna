import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WizardDraft } from "../src/shared/wizard";
import { rollbackTargetRevisionId } from "../src/server/lifecycle";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-11-01T00:00:00.000Z";
const CONTACT = { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@livewiz.test" };
const PROFILE = { contact: CONTACT, copy: { brand_name: "Live Cash" } };
const CONFIG = JSON.stringify({ keyword_default: "Quick Loan", profile: PROFILE });
const INDEX = "<!doctype html><html><head><title>Harbor | Funding Options</title></head><body><header data-brand>Harbor</header><h1>Funding</h1></body></html>";

let owner: string;
let employee: string;
let seq = 0;
let dispatches: Array<{ path: string; body: Record<string, unknown> }>;
const factory = { fetch: async (request: Request) => {
  dispatches.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
  return Response.json({ ok: true, instance_id: "wf" });
} } as unknown as Fetcher;
const testEnv = () => makeEnv({ FACTORY_WORKER: factory });

beforeAll(setupDatabases, 60_000);
beforeEach(async () => {
  resetState();
  dispatches = [];
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.ARTIFACTS.put("templates/tv-live-a.zip", zipSync({ "index.html": new TextEncoder().encode(INDEX) }));
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id,name,framework,created_by,created_at) VALUES ('tpl-live','Live','astro','owner',?1)").bind(NOW),
    env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at,text_defaults_json) VALUES ('tv-live-a','tpl-live',1,?2,'templates/tv-live-a.zip','sealed','owner',?1,'owner',?1,?3)")
      .bind(NOW, "a".repeat(64), JSON.stringify({ brand_name: "Harbor", title: "Harbor | Funding Options", description: "Check your options." })),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES ('fa-live','abcdef8','forms/fa-live','manifest','2026-01','form@abcdef8',?1)").bind(NOW),
  ]);
});

/** A brand that finished its first install: live on revision 1. */
async function liveBrand(status = "live"): Promise<{ brandId: string; revisionId: string }> {
  const brandId = `livewiz-${++seq}`;
  const revisionId = `${brandId}-rev-1`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,current_revision_id,created_by,created_at,updated_at) VALUES (?1,'Live Cash','test-account',?2,'Quick Loan',?3,?4,'owner',?5,?5)").bind(brandId, `${brandId}.test`, status, revisionId, NOW),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,1,'tv-live-a','fa-live',?3,'owner',?4)").bind(revisionId, brandId, CONFIG, NOW),
    env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at,finished_at) VALUES (?1,?2,'install','ready',NULL,?3,'owner','owner',?4,?4)").bind(`${brandId}-first`, brandId, revisionId, NOW),
  ]);
  return { brandId, revisionId };
}

const getDraft = (brandId: string, cookie = employee) => call(`/api/wizard/drafts/${brandId}`, { cookie });
/** The wizard sends back the revision it opened on: liveBrand's revision 1 unless the body names another base. */
const finish = (brandId: string, body: Record<string, unknown>, cookie = owner) => call(`/api/brands/${brandId}/wizard-redeploy`, { cookie, method: "POST", body: { base_revision_id: `${brandId}-rev-1`, ...body }, env: testEnv() });
const brandRow = (brandId: string) => env.FACTORY.prepare("SELECT name,domain,keyword_default,status,current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first();
const revisionCount = async (brandId: string) => (await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions WHERE brand_id = ?1").bind(brandId).first<{ n: number }>())!.n;

describe("GET /api/wizard/drafts/:id for a live brand", () => {
  it("answers the current revision with status live", async () => {
    const { brandId, revisionId } = await liveBrand();
    const response = await getDraft(brandId);
    expect(response.status).toBe(200);
    const body = WizardDraft.parse(await response.json());
    expect(body.brand).toEqual({ brand_id: brandId, name: "Live Cash", domain: `${brandId}.test`, keyword_default: "Quick Loan", status: "live" });
    expect(body.revision).toMatchObject({ revision_id: revisionId, revision: 1, template_version_id: "tv-live-a" });
    expect(body.profile).toEqual(PROFILE);
    expect(body.base_revision_id).toBe(revisionId);
  });

  it("answers no base_revision_id for a draft", async () => {
    const created = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: `draftwiz-${++seq}.test`, keyword_default: "Quick Loan", template_version_id: "tv-live-a" } });
    const { brand } = await created.json() as { brand: { brand_id: string } };
    const body = WizardDraft.parse(await (await getDraft(brand.brand_id)).json());
    expect(body).not.toHaveProperty("base_revision_id");
  });

  it("answers the current revision, not a later one, after a rollback", async () => {
    const { brandId, revisionId } = await liveBrand();
    await env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,2,'tv-live-a','fa-live','{}','owner',?3)")
      .bind(`${brandId}-rev-2`, brandId, NOW).run();
    const body = WizardDraft.parse(await (await getDraft(brandId)).json());
    expect(body.revision.revision_id).toBe(revisionId);
  });

  it("refuses paused and retired brands", async () => {
    for (const status of ["paused", "retired"]) {
      const { brandId } = await liveBrand(status);
      expect((await getDraft(brandId)).status).toBe(409);
    }
  });

  it("keeps PATCH /draft refused for a live brand: its revision is never edited in place", async () => {
    const { brandId } = await liveBrand();
    const response = await call(`/api/brands/${brandId}/draft`, { cookie: owner, method: "PATCH", body: { profile: { ...PROFILE, copy: { brand_name: "New" } } } });
    expect(response.status).toBe(409);
    expect(JSON.parse((await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1").bind(brandId).first<{ config_json: string }>())!.config_json)).toEqual(JSON.parse(CONFIG));
  });
});

describe("POST /api/wizard/preview/:id", () => {
  it("renders the posted profile over the live brand's current revision and stores nothing", async () => {
    const { brandId } = await liveBrand();
    const response = await call(`/api/wizard/preview/${brandId}`, { cookie: employee, method: "POST", body: { profile: { ...PROFILE, copy: { brand_name: "Bright Lend" } } } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Bright Lend");
    expect(html).not.toContain("Live Cash");
    // srcDoc drops the CSP header, so the same policy (less the meta-ignored sandbox) leads the document head.
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><title>`);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await revisionCount(brandId)).toBe(1);
  });

  it("refuses a draft brand: a draft previews what it saved", async () => {
    const created = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: `draftwiz-${++seq}.test`, keyword_default: "Quick Loan", template_version_id: "tv-live-a" } });
    const { brand } = await created.json() as { brand: { brand_id: string } };
    expect((await call(`/api/wizard/preview/${brand.brand_id}`, { cookie: employee, method: "POST", body: { profile: PROFILE } })).status).toBe(409);
  });
});

describe("POST /api/brands/:id/wizard-redeploy", () => {
  it("writes revision 2 with the edits and an upgrade install, and leaves revision 1 as the rollback target", async () => {
    const { brandId, revisionId } = await liveBrand();
    const edited = { ...PROFILE, copy: { brand_name: "Bright Lend", h1: "{{keyword}} Today" } };
    const response = await finish(brandId, { template_version_id: "tv-live-a", profile: edited });
    expect(response.status).toBe(201);
    const { install_id } = await response.json() as { install_id: string };
    const next = await env.FACTORY.prepare("SELECT revision_id,revision,template_version_id,form_artifact_id,config_json FROM brand_revisions WHERE brand_id = ?1 AND revision = 2").bind(brandId)
      .first<{ revision_id: string; revision: number; template_version_id: string; form_artifact_id: string; config_json: string }>();
    expect(next).toMatchObject({ revision_id: `${brandId}_redeploy_${install_id}`, template_version_id: "tv-live-a", form_artifact_id: "fa-live" });
    expect(JSON.parse(next!.config_json)).toMatchObject({ keyword_default: "Quick Loan", profile: edited });
    // Revision 1 and the brand row are untouched; the install Workflow moves current_revision_id.
    expect(JSON.parse((await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE revision_id = ?1").bind(revisionId).first<{ config_json: string }>())!.config_json)).toEqual(JSON.parse(CONFIG));
    expect(await brandRow(brandId)).toEqual({ name: "Live Cash", domain: `${brandId}.test`, keyword_default: "Quick Loan", status: "live", current_revision_id: revisionId });
    expect(await env.FACTORY.prepare("SELECT kind,status,from_revision_id,to_revision_id FROM installs WHERE install_id = ?1").bind(install_id).first())
      .toEqual({ kind: "upgrade", status: "running", from_revision_id: revisionId, to_revision_id: next!.revision_id });
    expect(dispatches).toEqual([{ path: "/install", body: { install_id, brand_id: brandId, revision_id: next!.revision_id, started_by: expect.any(String), started_role: "owner" } }]);
    const audit = await env.FACTORY.prepare("SELECT action,after_json FROM audit_log WHERE entity_id = ?1").bind(install_id).first<{ action: string; after_json: string }>();
    expect(audit!.action).toBe("redeploy.start");
    expect(JSON.parse(audit!.after_json)).toMatchObject({ source: "wizard", changed: ["profile.copy"] });
    // Once the install is ready, rollback picks revision 1.
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE installs SET status = 'ready', finished_at = '2026-11-02T00:00:00Z' WHERE install_id = ?1").bind(install_id),
      env.FACTORY.prepare("UPDATE brands SET current_revision_id = ?1 WHERE brand_id = ?2").bind(next!.revision_id, brandId),
    ]);
    expect(await rollbackTargetRevisionId(env.FACTORY, brandId, next!.revision_id)).toBe(revisionId);
  });

  it("answers 409 in Thai for a domain, hostnames or brand_id field and writes nothing", async () => {
    const { brandId } = await liveBrand();
    for (const body of [{ domain: "other.test" }, { hostnames: ["other.test"] }, { brand_id: "other" }]) {
      const response = await finish(brandId, { profile: PROFILE, ...body });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "live_locked", field: "domain", message: "เปลี่ยนโดเมนของแบรนด์ที่ออนไลน์อยู่ไม่ได้" });
    }
    expect(await revisionCount(brandId)).toBe(1);
    expect(dispatches).toEqual([]);
  });

  it("locks the brand name and keyword: a new value answers 409, the current value passes", async () => {
    const { brandId } = await liveBrand();
    const name = await finish(brandId, { name: "Other Name", profile: PROFILE });
    expect(name.status).toBe(409);
    expect(await name.json()).toMatchObject({ error: "live_locked", field: "name", message: "แก้ชื่อที่โชว์บนเว็บได้ที่ข้อความแบรนด์" });
    const keyword = await finish(brandId, { keyword_default: "Other Keyword", profile: PROFILE });
    expect(keyword.status).toBe(409);
    expect(await keyword.json()).toMatchObject({ error: "live_locked", field: "keyword_default" });
    expect(await revisionCount(brandId)).toBe(1);
    expect((await finish(brandId, { name: "Live Cash", keyword_default: "Quick Loan", profile: PROFILE })).status).toBe(201);
  });

  it("refuses paused, retired and draft brands with 409", async () => {
    for (const status of ["paused", "retired"]) {
      const { brandId } = await liveBrand(status);
      expect((await finish(brandId, { profile: PROFILE })).status).toBe(409);
      expect(await revisionCount(brandId)).toBe(1);
    }
    const created = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: `draftwiz-${++seq}.test`, keyword_default: "Quick Loan", template_version_id: "tv-live-a" } });
    const { brand } = await created.json() as { brand: { brand_id: string } };
    expect((await finish(brand.brand_id, { profile: PROFILE })).status).toBe(409);
  });

  it("answers lifecycle_operation_active while an install runs", async () => {
    const { brandId, revisionId } = await liveBrand();
    await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at) VALUES (?1,?2,'upgrade','running',?3,?3,'owner','owner',?4)")
      .bind(`${brandId}-busy`, brandId, revisionId, NOW).run();
    const response = await finish(brandId, { profile: PROFILE });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "lifecycle_operation_active", active_install_id: `${brandId}-busy` });
    expect(await revisionCount(brandId)).toBe(1);
  });

  it("locks tracking: a changed ads group answers 409 and writes nothing, the stored one passes", async () => {
    const { brandId } = await liveBrand();
    const ads = { google_ads_account: "1234567890", adkit_project: "proj-a" };
    const changed = await finish(brandId, { profile: { ...PROFILE, ads } });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "live_locked", field: "ads", message: "แก้การติดตามของแบรนด์ที่ออนไลน์อยู่ได้ที่หน้าตั้งค่า" });
    expect(await revisionCount(brandId)).toBe(1);
    expect(dispatches).toEqual([]);
    // CONFIG holds no ads group, so an empty one is the same tracking.
    expect((await finish(brandId, { profile: { ...PROFILE, ads: {} } })).status).toBe(201);
  });

  it("writes the new template_version_id when the wizard picked another template", async () => {
    const { brandId, revisionId } = await liveBrand();
    await env.FACTORY.prepare("INSERT OR IGNORE INTO template_versions (template_version_id,template_id,version,sha256,r2_key,status,sealed_by,sealed_at,created_by,created_at,text_defaults_json) VALUES ('tv-live-b','tpl-live',2,?2,'templates/tv-live-b.zip','sealed','owner',?1,'owner',?1,?3)")
      .bind(NOW, "b".repeat(64), JSON.stringify({ brand_name: "Harbor", title: "Harbor | New", description: "New look." })).run();
    const response = await finish(brandId, { template_version_id: "tv-live-b", profile: PROFILE });
    expect(response.status).toBe(201);
    const { install_id } = await response.json() as { install_id: string };
    const next = await env.FACTORY.prepare("SELECT revision_id,template_version_id,form_artifact_id FROM brand_revisions WHERE brand_id = ?1 AND revision = 2").bind(brandId).first();
    expect(next).toEqual({ revision_id: `${brandId}_redeploy_${install_id}`, template_version_id: "tv-live-b", form_artifact_id: "fa-live" });
    expect(await env.FACTORY.prepare("SELECT template_version_id FROM brand_revisions WHERE revision_id = ?1").bind(revisionId).first()).toEqual({ template_version_id: "tv-live-a" });
    const audit = await env.FACTORY.prepare("SELECT after_json FROM audit_log WHERE entity_id = ?1").bind(install_id).first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ changed: ["template_version_id"], template_version_id: "tv-live-b" });
  });

  it("answers 409 and writes nothing when the current revision or its config changed between the read and the batch", async () => {
    const races: Array<{ added: number; statements: (brandId: string, revisionId: string) => D1PreparedStatement[] }> = [
      // Another redeploy finished: the brand moved to a revision this request never read.
      { added: 1, statements: (brandId, revisionId) => [
        env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,2,'tv-live-a','fa-live',?3,'owner',?4)").bind(`${revisionId}-rival`, brandId, CONFIG, NOW),
        env.FACTORY.prepare("UPDATE brands SET current_revision_id = ?1 WHERE brand_id = ?2").bind(`${revisionId}-rival`, brandId),
      ] },
      // The current revision's config was rewritten in place.
      { added: 0, statements: (_brandId, revisionId) => [
        env.FACTORY.prepare("UPDATE brand_revisions SET config_json = ?1 WHERE revision_id = ?2").bind(JSON.stringify({ keyword_default: "Quick Loan", profile: { ...PROFILE, copy: { brand_name: "Rival" } } }), revisionId),
      ] },
    ];
    for (const race of races) {
      const { brandId, revisionId } = await liveBrand();
      let raced = false;
      const racing = new Proxy(env.FACTORY, { get: (target, prop) => prop === "batch"
        ? async (statements: D1PreparedStatement[]) => {
          if (!raced) { raced = true; await target.batch(race.statements(brandId, revisionId)); }
          return target.batch(statements);
        }
        : Reflect.get(target, prop).bind(target) });
      const response = await call(`/api/brands/${brandId}/wizard-redeploy`, { cookie: owner, method: "POST", body: { base_revision_id: revisionId, profile: { ...PROFILE, copy: { brand_name: "Bright Lend" } } }, env: makeEnv({ FACTORY_WORKER: factory, FACTORY: racing as unknown as D1Database }) });
      expect([response.status, await response.json()]).toEqual([409, { error: "conflict", message: "แบรนด์ถูกเปลี่ยนระหว่างบันทึก โหลดหน้าใหม่แล้วลองอีกครั้ง" }]);
      expect(raced).toBe(true);
      expect(await revisionCount(brandId)).toBe(1 + race.added);
      expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id = ?1 AND kind = 'upgrade'").bind(brandId).first<{ n: number }>())!.n).toBe(0);
    }
    expect(dispatches).toEqual([]);
  });

  it("answers 409 stale_revision and writes nothing when another redeploy moved the brand after the wizard opened", async () => {
    const { brandId, revisionId } = await liveBrand();
    // Owner A opens the wizard on revision 1.
    const opened = WizardDraft.parse(await (await getDraft(brandId, owner)).json());
    expect(opened.base_revision_id).toBe(revisionId);
    // Owner B redeploys and the install finishes: the brand now serves revision 2.
    const rival = await finish(brandId, { profile: { ...PROFILE, copy: { brand_name: "Rival" } } });
    expect(rival.status).toBe(201);
    const { install_id } = await rival.json() as { install_id: string };
    const rivalRevision = `${brandId}_redeploy_${install_id}`;
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE installs SET status = 'ready', finished_at = '2026-11-02T00:00:00Z' WHERE install_id = ?1").bind(install_id),
      env.FACTORY.prepare("UPDATE brands SET current_revision_id = ?1 WHERE brand_id = ?2").bind(rivalRevision, brandId),
    ]);
    // Owner A saves with base revision 1.
    const stale = await finish(brandId, { base_revision_id: opened.base_revision_id, profile: { ...PROFILE, copy: { brand_name: "Bright Lend" } } });
    expect([stale.status, await stale.json()]).toEqual([409, { error: "stale_revision", message: "มีคนติดตั้งแบรนด์นี้ไปแล้วหลังจากคุณเปิดวิซาร์ด โหลดใหม่แล้วแก้อีกครั้ง" }]);
    expect(await revisionCount(brandId)).toBe(2);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id = ?1 AND kind = 'upgrade'").bind(brandId).first<{ n: number }>())!.n).toBe(1);
    expect((await brandRow(brandId))!.current_revision_id).toBe(rivalRevision);
    expect(dispatches).toHaveLength(1);
  });

  it("answers 409 stale_revision and writes nothing when base_revision_id is missing", async () => {
    const { brandId } = await liveBrand();
    const response = await call(`/api/brands/${brandId}/wizard-redeploy`, { cookie: owner, method: "POST", body: { profile: PROFILE }, env: testEnv() });
    expect([response.status, await response.json()]).toMatchObject([409, { error: "stale_revision" }]);
    expect(await revisionCount(brandId)).toBe(1);
    expect(dispatches).toEqual([]);
  });

  it("is owner only and refuses a profile the install would reject", async () => {
    const { brandId } = await liveBrand();
    expect((await finish(brandId, { profile: PROFILE }, employee)).status).toBe(403);
    const incomplete = await finish(brandId, { profile: { copy: { brand_name: "No Contact" } } });
    expect(incomplete.status).toBe(422);
    expect(await incomplete.json()).toMatchObject({ error: "draft_incomplete" });
    expect(await revisionCount(brandId)).toBe(1);
  });
});
