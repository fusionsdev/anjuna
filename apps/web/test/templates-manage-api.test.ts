import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrandThemeVarsResponse, SealedTemplatesResponse, TemplateArchiveResponse, TemplateCategoryAssignResponse, TemplateCategoryCreateResponse, TemplateListResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-11-01T00:00:00.000Z";
const EARLIER = "2026-10-01T00:00:00.000Z";
const THEME = JSON.stringify({ primary: ["--brand"], primary_dark: [], secondary: [] });
type VersionStatus = "draft" | "certified" | "rejected" | "sealed";
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

/**
 * A template with one version per status, oldest first. Every version has a certification row and a fingerprint row, as the
 * certifier writes them for a pass and for a fail. A sealed version carries a color map so a brand can resolve it.
 */
async function seedTemplate(statuses: VersionStatus | VersionStatus[]): Promise<{ templateId: string; versionId: string; versionIds: string[] }> {
  const n = ++seq;
  const list = Array.isArray(statuses) ? statuses : [statuses];
  const templateId = `tpl-m${n}`;
  const versionIds = list.map((_, i) => `tv-m${n}-${i + 1}`);
  await env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES (?1, ?2, 'react_spa', 'u', ?3)").bind(templateId, `Manage ${n}`, NOW).run();
  for (const [i, status] of list.entries()) {
    const sealed = status === "sealed";
    await env.FACTORY.batch([
      env.FACTORY.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'u', ?9, ?10)`)
        .bind(versionIds[i], templateId, i + 1, `${n}-${i}`.padStart(64, "0"), `templates/${versionIds[i]}.zip`, status, sealed ? "owner" : null, sealed ? NOW : null, NOW, sealed ? THEME : null),
      env.FACTORY.prepare("INSERT INTO certifications (template_version_id, check_name, result, details_json, created_at) VALUES (?1, 'lint', ?2, '{}', ?3)")
        .bind(versionIds[i], status === "rejected" ? "fail" : "pass", NOW),
      env.FACTORY.prepare("INSERT INTO template_fingerprints (template_version_id, fingerprint_json, created_at) VALUES (?1, '{}', ?2)").bind(versionIds[i], NOW),
    ]);
  }
  return { templateId, versionId: versionIds[0]!, versionIds };
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
const mapOf = async (templateId: string) => (await env.FACTORY.prepare("SELECT category_id FROM template_category_map WHERE template_id = ?1").bind(templateId).first<{ category_id: string }>())?.category_id ?? null;
const seal = (versionId: string) => env.FACTORY.prepare("UPDATE template_versions SET status = 'sealed', sealed_by = 'owner', sealed_at = ?2 WHERE template_version_id = ?1").bind(versionId, NOW).run();

/**
 * The route with a hook that runs once, right before its first batch: after every read of the route and before its writes.
 * It stands in for another request that lands between the two.
 */
const racing = (beforeBatch: () => Promise<unknown>) => {
  let fired = false;
  return makeEnv({
    FACTORY: {
      prepare: (sql: string) => env.FACTORY.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!fired) { fired = true; await beforeBatch(); }
        return env.FACTORY.batch(statements);
      },
    } as unknown as D1Database,
  });
};

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

  it("refuses an employee for category create (403) and creates nothing", async () => {
    const denied = await post(employee, "/api/templates/categories", { name: "พนักงานสร้าง" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden_role", required_role: "owner" });
    expect(await count("SELECT COUNT(*) AS n FROM template_categories WHERE name = 'พนักงานสร้าง'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template_category.create' AND after_json LIKE '%พนักงานสร้าง%'")).toBe(0);
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

  it("writes nothing and no audit row when the category changed between the read and the write", async () => {
    const { templateId } = await seedTemplate("certified");
    const a = await createCategory("แข่ง A");
    const b = await createCategory("แข่ง B");
    const c = await createCategory("แข่ง C");
    const patch = (to: string | null, testEnv = makeEnv()) => call(`/api/templates/${templateId}/category`, { cookie: owner, method: "PATCH", body: { category_id: to }, env: testEnv });
    const setMap = (to: string) => env.FACTORY.prepare("INSERT OR REPLACE INTO template_category_map (template_id, category_id) VALUES (?1, ?2)").bind(templateId, to).run();
    const clearMap = () => env.FACTORY.prepare("DELETE FROM template_category_map WHERE template_id = ?1").bind(templateId).run();

    // No category when read, another request sets one before this write: the insert must not overwrite it.
    const lostInsert = await patch(a.id, racing(() => setMap(b.id)));
    expect(lostInsert.status).toBe(409);
    expect(await lostInsert.json()).toEqual({ error: "conflict" });
    expect(await mapOf(templateId)).toBe(b.id);

    // Category b when read, another request moves it to c: the update must not overwrite it.
    const lostUpdate = await patch(a.id, racing(() => setMap(c.id)));
    expect(lostUpdate.status).toBe(409);
    expect(await mapOf(templateId)).toBe(c.id);

    // Category c when read, another request clears it: the delete changes nothing.
    const lostDelete = await patch(null, racing(clearMap));
    expect(lostDelete.status).toBe(409);
    expect(await mapOf(templateId)).toBeNull();

    expect(await audits("template.category", templateId)).toBe(0);
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

  it("answers the stored stamp, with no second audit row, when a concurrent archive won", async () => {
    const { templateId } = await seedTemplate("certified");
    const raced = await call(`/api/templates/${templateId}/archive`, {
      cookie: owner, method: "POST", body: {},
      env: racing(() => env.FACTORY.prepare("UPDATE templates SET archived_at = ?2 WHERE template_id = ?1").bind(templateId, EARLIER).run()),
    });
    expect(raced.status).toBe(200);
    expect(TemplateArchiveResponse.parse(await raced.json()).archived_at).toBe(EARLIER);
    expect(await count("SELECT COUNT(*) AS n FROM templates WHERE template_id = ?1 AND archived_at = ?2", templateId, EARLIER)).toBe(1);
    expect(await audits("template.archive", templateId)).toBe(0);
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
  const del = (cookie: string, id: string, testEnv = makeEnv()) => call(`/api/templates/${id}`, { cookie, method: "DELETE", env: testEnv });
  /** Counts of the template row, its versions, certifications, fingerprints and category link. */
  const snapshot = (templateId: string, versionIds: string[]) => {
    const marks = versionIds.map((_, i) => `?${i + 1}`).join(", ");
    return Promise.all([
      count("SELECT COUNT(*) AS n FROM templates WHERE template_id = ?1", templateId),
      count(`SELECT COUNT(*) AS n FROM template_versions WHERE template_version_id IN (${marks})`, ...versionIds),
      count(`SELECT COUNT(*) AS n FROM certifications WHERE template_version_id IN (${marks})`, ...versionIds),
      count(`SELECT COUNT(*) AS n FROM template_fingerprints WHERE template_version_id IN (${marks})`, ...versionIds),
      count("SELECT COUNT(*) AS n FROM template_category_map WHERE template_id = ?1", templateId),
    ]);
  };

  it("refuses a template that a brand uses with template_in_use", async () => {
    const { templateId, versionIds } = await seedTemplate("sealed");
    await seedBrand(versionIds[0]!);
    const refused = await del(owner, templateId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "template_in_use" });
    expect(await snapshot(templateId, versionIds)).toEqual([1, 1, 1, 1, 0]);
    expect(await audits("template.delete", templateId)).toBe(0);
  });

  it("refuses a template that a brand uses even when its version was never sealed", async () => {
    const { templateId, versionIds } = await seedTemplate("certified");
    await seedBrand(versionIds[0]!);
    expect(await (await del(owner, templateId)).json()).toEqual({ error: "template_in_use" });
    expect(await snapshot(templateId, versionIds)).toEqual([1, 1, 1, 1, 0]);
  });

  it("refuses a sealed template that no brand uses with template_was_approved", async () => {
    const { templateId, versionIds } = await seedTemplate("sealed");
    const refused = await del(owner, templateId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "template_was_approved" });
    expect(await snapshot(templateId, versionIds)).toEqual([1, 1, 1, 1, 0]);
  });

  it("lists was_approved for a draft whose sealed version is cut from the 200 newest rows, and the delete is refused", async () => {
    const { templateId, versionIds } = await seedTemplate(["certified", "certified"]);
    const [sealedId, draftId] = versionIds as [string, string];
    // The sealed version is the oldest of 201 versions, so the list (newest 200) does not return it.
    await env.FACTORY.prepare("UPDATE template_versions SET created_at = ?2 WHERE template_version_id = ?1").bind(sealedId, EARLIER).run();
    await env.FACTORY.prepare("UPDATE template_versions SET created_at = ?2 WHERE template_version_id = ?1").bind(draftId, "2026-11-02T00:00:00.000Z").run();
    // A sealed version cannot be edited, so it is sealed after its created_at is set.
    await seal(sealedId);
    await env.FACTORY.prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-filler', 'Filler', 'react_spa', 'u', ?1)").bind(NOW).run();
    const fillers = Array.from({ length: 199 }, (_, i) => env.FACTORY.prepare(`INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at)
      VALUES (?1, 'tpl-filler', ?2, ?3, ?4, 'certified', 'u', ?5)`).bind(`tv-filler-${i}`, i + 1, `f${i}`.padStart(64, "0"), `templates/tv-filler-${i}.zip`, NOW));
    await env.FACTORY.batch(fillers);

    const rows = (await list(owner)).templates;
    expect(rows).toHaveLength(200);
    expect(rows.some((t) => t.template_version_id === sealedId)).toBe(false);
    const draft = rows.find((t) => t.template_version_id === draftId)!;
    expect(draft).toMatchObject({ status: "awaiting_approval", sealed_at: null, was_approved: true });
    expect(rows.filter((t) => t.template_id === "tpl-filler").every((t) => !t.was_approved)).toBe(true);
    expect(await (await del(owner, templateId)).json()).toEqual({ error: "template_was_approved" });
  });

  it("refuses a template whose older version was sealed, while its newest version never was", async () => {
    const { templateId, versionIds } = await seedTemplate(["sealed", "certified"]);
    expect(await (await del(owner, templateId)).json()).toEqual({ error: "template_was_approved" });
    expect(await snapshot(templateId, versionIds)).toEqual([1, 2, 2, 2, 0]);
  });

  it("deletes a never-approved unused template with its certifications, fingerprints, versions and category link (204)", async () => {
    // A rejected and a certified version: the certifier wrote a fingerprint row for each, and each references its version.
    const draft = await seedTemplate(["rejected", "certified"]);
    const other = await seedTemplate("certified");
    const category = await createCategory("ลบได้");
    for (const id of [draft.templateId, other.templateId]) await call(`/api/templates/${id}/category`, { cookie: owner, method: "PATCH", body: { category_id: category.id } });
    expect(await snapshot(draft.templateId, draft.versionIds)).toEqual([1, 2, 2, 2, 1]);

    const refused = await del(employee, draft.templateId);
    expect(refused.status).toBe(403);
    expect(await snapshot(draft.templateId, draft.versionIds)).toEqual([1, 2, 2, 2, 1]);

    const deleted = await del(owner, draft.templateId);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await snapshot(draft.templateId, draft.versionIds)).toEqual([0, 0, 0, 0, 0]);
    expect(await audits("template.delete", draft.templateId)).toBe(1);
    // The other template and the category stay.
    expect(await snapshot(other.templateId, other.versionIds)).toEqual([1, 1, 1, 1, 1]);
    expect(await count("SELECT COUNT(*) AS n FROM template_categories WHERE id = ?1", category.id)).toBe(1);

    expect((await del(owner, draft.templateId)).status).toBe(404);
  });

  describe("when the state changes after the read and before the batch", () => {
    // Every race starts from a template the first read accepts: certified versions, no brand, nothing sealed.
    it("a seal of the older version lands: 409 template_was_approved, nothing deleted, no audit row", async () => {
      const { templateId, versionIds } = await seedTemplate(["certified", "certified"]);
      const category = await createCategory("แข่งลบ");
      await call(`/api/templates/${templateId}/category`, { cookie: owner, method: "PATCH", body: { category_id: category.id } });
      const raced = await del(owner, templateId, racing(() => seal(versionIds[0]!)));
      expect(raced.status).toBe(409);
      expect(await raced.json()).toEqual({ error: "template_was_approved" });
      expect(await snapshot(templateId, versionIds)).toEqual([1, 2, 2, 2, 1]);
      expect(await audits("template.delete", templateId)).toBe(0);
    });

    it("a brand revision on the older version lands: 409 template_in_use, nothing deleted, no audit row", async () => {
      const { templateId, versionIds } = await seedTemplate(["certified", "certified"]);
      const raced = await del(owner, templateId, racing(() => seedBrand(versionIds[0]!)));
      expect(raced.status).toBe(409);
      expect(await raced.json()).toEqual({ error: "template_in_use" });
      expect(await snapshot(templateId, versionIds)).toEqual([1, 2, 2, 2, 0]);
      expect(await audits("template.delete", templateId)).toBe(0);
    });

    it("a seal of the only version lands: 409 template_was_approved, nothing deleted, no audit row", async () => {
      const { templateId, versionIds } = await seedTemplate("certified");
      const raced = await del(owner, templateId, racing(() => seal(versionIds[0]!)));
      expect(raced.status).toBe(409);
      expect(await raced.json()).toEqual({ error: "template_was_approved" });
      expect(await snapshot(templateId, versionIds)).toEqual([1, 1, 1, 1, 0]);
      expect(await audits("template.delete", templateId)).toBe(0);
    });
  });
});
