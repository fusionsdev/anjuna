import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrandThemeVarsResponse, SealedTemplatesResponse, TemplateArchiveResponse, TemplateCategoryAssignResponse, TemplateCategoryCreateResponse, TemplateListResponse } from "@anjuna/contracts";
import { call, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-11-01T00:00:00.000Z";
const THEME = JSON.stringify({ primary: ["--brand"], primary_dark: [], secondary: [] });
let owner: string;
let employee: string;
let seq = 0;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  await env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at) VALUES ('fa-manage', 'git-manage', 'forms/manage', 'manifest', ?1)").bind(NOW).run();
});

/** A template with one version in the given status; a sealed one carries a color map so a brand can resolve it. */
async function seedTemplate(status: "draft" | "certified" | "sealed", { certified = true } = {}): Promise<{ templateId: string; versionId: string }> {
  const n = ++seq;
  const templateId = `tpl-m${n}`;
  const versionId = `tv-m${n}`;
  const sealed = status === "sealed";
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, 'react_spa', 'u', ?3)").bind(templateId, `Manage ${n}`, NOW),
    env.FACTORY.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
      VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 'u', ?8, ?9)`)
      .bind(versionId, templateId, String(n).padStart(64, "0"), `templates/${templateId}.zip`, status, sealed ? "owner" : null, sealed ? NOW : null, NOW, sealed ? THEME : null),
    ...(certified ? [env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, created_at) VALUES (?1, 'lint', 'pass', '{}', ?2)").bind(versionId, NOW)] : []),
  ]);
  return { templateId, versionId };
}

async function seedBrand(versionId: string): Promise<string> {
  const brandId = `brand-m${++seq}`;
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id, name, account, domain, status, created_by, created_at, updated_at) VALUES (?1, ?1, 'test', ?2, 'live', 'u', ?3, ?3)").bind(brandId, `${brandId}.test`, NOW),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at) VALUES (?1, ?2, 1, ?3, 'fa-manage', '{}', 'u', ?4)").bind(`rev-${brandId}`, brandId, versionId, NOW),
  ]);
  return brandId;
}

const count = async (sql: string, ...binds: unknown[]) => (await env.FACTORY.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const audits = (action: string, entityId: string) => count("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1 AND entity_id = ?2", action, entityId);
const list = async (cookie: string, query = "") => TemplateListResponse.parse(await (await call(`/api/templates${query}`, { cookie })).json());
const post = (cookie: string, path: string, body: unknown = {}) => call(path, { cookie, method: "POST", body });
const createCategory = async (name: string) => TemplateCategoryCreateResponse.parse(await (await post(owner, "/api/templates/categories", { name })).json()).category;

describe("template categories", () => {
  it("creates a category for the owner, refuses a duplicate name, and audits once", async () => {
    const created = await post(owner, "/api/templates/categories", { name: "  เงินกู้  " });
    expect(created.status).toBe(201);
    const { category } = TemplateCategoryCreateResponse.parse(await created.json());
    expect(category.name).toBe("เงินกู้");
    expect(await audits("template_category.create", category.id)).toBe(1);

    const duplicate = await post(owner, "/api/templates/categories", { name: "เงินกู้" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "category_exists" });
    expect(await count("SELECT COUNT(*) AS n FROM template_categories WHERE name = 'เงินกู้'")).toBe(1);

    const second = await createCategory("บัตรเครดิต");
    expect(second.sort).toBeGreaterThan(category.sort);
    expect((await list(owner)).categories.map((c) => c.id)).toEqual(expect.arrayContaining([category.id, second.id]));
    expect((await post(owner, "/api/templates/categories", { name: "   " })).status).toBe(422);
    expect((await post(owner, "/api/templates/categories", { name: "x", extra: 1 })).status).toBe(422);
  });

  it("assigns, changes and clears a template's category with an audit row each time", async () => {
    const { templateId, versionId } = await seedTemplate("certified");
    const a = await createCategory("กลุ่ม A");
    const b = await createCategory("กลุ่ม B");
    const patch = (body: unknown, id = templateId, cookie = owner) => call(`/api/templates/${id}/category`, { cookie, method: "PATCH", body });
    const categoryOf = async () => (await list(owner)).templates.find((t) => t.template_version_id === versionId)!.category_id;

    expect(await categoryOf()).toBeNull();
    const set = await patch({ category_id: a.id });
    expect(set.status).toBe(200);
    expect(TemplateCategoryAssignResponse.parse(await set.json())).toEqual({ template_id: templateId, category_id: a.id });
    expect(await categoryOf()).toBe(a.id);
    await patch({ category_id: a.id });
    expect(await audits("template.category", templateId)).toBe(1);
    await patch({ category_id: b.id });
    expect(await categoryOf()).toBe(b.id);
    await patch({ category_id: null });
    expect(await categoryOf()).toBeNull();
    expect(await audits("template.category", templateId)).toBe(3);

    expect((await patch({ category_id: "cat-missing" })).status).toBe(404);
    expect((await patch({ category_id: a.id }, "tpl-missing")).status).toBe(404);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ category_id: a.id }, templateId, employee)).status).toBe(403);
    expect(await categoryOf()).toBeNull();
  });
});

describe("template archive", () => {
  it("hides an archived template from the brand picker and the default list, and keeps its brands working", async () => {
    const { templateId, versionId } = await seedTemplate("sealed");
    const brandId = await seedBrand(versionId);
    const pickerIds = async () => SealedTemplatesResponse.parse(await (await call("/api/templates/sealed", { cookie: employee })).json()).templates.map((t) => t.template_version_id);
    expect(await pickerIds()).toContain(versionId);

    const archived = await post(owner, `/api/templates/${templateId}/archive`);
    expect(archived.status).toBe(200);
    const body = TemplateArchiveResponse.parse(await archived.json());
    expect(body.template_id).toBe(templateId);
    expect(await count("SELECT COUNT(*) AS n FROM templates WHERE template_id = ?1 AND archived_at = ?2", templateId, body.archived_at)).toBe(1);
    expect(await audits("template.archive", templateId)).toBe(1);

    expect(await pickerIds()).not.toContain(versionId);
    expect((await list(employee)).templates.some((t) => t.template_version_id === versionId)).toBe(false);
    const withArchived = (await list(owner, "?include_archived=1")).templates.find((t) => t.template_version_id === versionId);
    expect(withArchived).toMatchObject({ archived: true, status: "approved", brands_using: 1 });

    // The version stays sealed and the brand still resolves it.
    expect(await count("SELECT COUNT(*) AS n FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'", versionId)).toBe(1);
    expect((await call(`/api/templates/${versionId}`, { cookie: owner })).status).toBe(200);
    const theme = BrandThemeVarsResponse.parse(await (await call(`/api/brands/${brandId}/theme-vars`, { cookie: employee })).json());
    expect(theme.template).toEqual({ primary: ["--brand"], primary_dark: [], secondary: [] });

    // A second archive changes nothing and writes no second audit row.
    expect((await post(owner, `/api/templates/${templateId}/archive`)).status).toBe(200);
    expect(await audits("template.archive", templateId)).toBe(1);
    expect((await post(owner, "/api/templates/tpl-missing/archive")).status).toBe(404);
  });

  it("refuses an employee for archive", async () => {
    const { templateId } = await seedTemplate("certified");
    const denied = await post(employee, `/api/templates/${templateId}/archive`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden_role", required_role: "owner" });
    expect(await count("SELECT COUNT(*) AS n FROM templates WHERE template_id = ?1 AND archived_at IS NOT NULL", templateId)).toBe(0);
  });
});

describe("guarded template delete", () => {
  const del = (cookie: string, id: string) => call(`/api/templates/${id}`, { cookie, method: "DELETE" });
  const rows = (templateId: string, versionId: string) => Promise.all([
    count("SELECT COUNT(*) AS n FROM templates WHERE template_id = ?1", templateId),
    count("SELECT COUNT(*) AS n FROM template_versions WHERE template_version_id = ?1", versionId),
    count("SELECT COUNT(*) AS n FROM certifications WHERE template_version_id = ?1", versionId),
  ]);

  it("refuses a template that a brand uses with template_in_use", async () => {
    const { templateId, versionId } = await seedTemplate("sealed");
    await seedBrand(versionId);
    const refused = await del(owner, templateId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "template_in_use" });
    expect(await rows(templateId, versionId)).toEqual([1, 1, 1]);
    expect(await audits("template.delete", templateId)).toBe(0);
  });

  it("refuses a template that a brand uses even when its version was never sealed", async () => {
    const { templateId, versionId } = await seedTemplate("certified");
    await seedBrand(versionId);
    expect(await (await del(owner, templateId)).json()).toEqual({ error: "template_in_use" });
    expect(await rows(templateId, versionId)).toEqual([1, 1, 1]);
  });

  it("refuses a sealed template that no brand uses with template_was_approved", async () => {
    const { templateId, versionId } = await seedTemplate("sealed");
    const refused = await del(owner, templateId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "template_was_approved" });
    expect(await rows(templateId, versionId)).toEqual([1, 1, 1]);
  });

  it("deletes a never-approved unused template with its certifications, versions and category link (204)", async () => {
    const draft = await seedTemplate("draft");
    const other = await seedTemplate("certified");
    const category = await createCategory("ลบได้");
    for (const id of [draft.templateId, other.templateId]) await call(`/api/templates/${id}/category`, { cookie: owner, method: "PATCH", body: { category_id: category.id } });

    const refused = await del(employee, draft.templateId);
    expect(refused.status).toBe(403);
    expect(await rows(draft.templateId, draft.versionId)).toEqual([1, 1, 1]);

    const deleted = await del(owner, draft.templateId);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await rows(draft.templateId, draft.versionId)).toEqual([0, 0, 0]);
    expect(await count("SELECT COUNT(*) AS n FROM template_category_map WHERE template_id = ?1", draft.templateId)).toBe(0);
    expect(await audits("template.delete", draft.templateId)).toBe(1);
    // The other template and the category stay.
    expect(await rows(other.templateId, other.versionId)).toEqual([1, 1, 1]);
    expect(await count("SELECT COUNT(*) AS n FROM template_category_map WHERE template_id = ?1", other.templateId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM template_categories WHERE id = ?1", category.id)).toBe(1);

    expect((await del(owner, draft.templateId)).status).toBe(404);
  });
});
