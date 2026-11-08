/**
 * Templates screen API: versions from the factory D1, screenshots from R2, Approve through the factory
 * Worker (it seals with the owner's user id), URL and ZIP imports through the template MCP service binding.
 */
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  TemplateApproveRequest,
  TemplateApproveResponse,
  TemplateArchiveResponse,
  TemplateCategory,
  TemplateCategoryAssignRequest,
  TemplateCategoryAssignResponse,
  TemplateCategoryCreateRequest,
  TemplateCategoryCreateResponse,
  TemplateDeleteRefusal,
  TemplateDetailResponse,
  TemplateImportRequest,
  TemplateZipImportRequest,
  TemplateListResponse,
  TemplateSubmitResult,
  SiteTextDefaultsResponse,
  TemplateTextDefaults,
  TemplateThemeVars,
  TemplateThemeVarsRequest,
  TemplateThemeVarsResponse,
  BrandThemeVarsResponse,
  isEmptyThemeVars,
  authorize,
  templateSlug,
  type AdminRequestContext,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
import { effectiveThemeVarsSql } from "@anjuna/factory-db";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { readZipForm } from "./zip-form.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const forbidden = (required: "owner" | "employee") => json(403, { error: "forbidden_role", required_role: required });
const notFound = (resource: string) => json(404, { error: "not_found", resource });

interface VersionRow {
  template_version_id: string;
  template_id: string;
  name: string;
  version: number;
  status: TemplateVersionStatusName;
  submitted_by_label: string | null;
  created_at: string;
  sealed_at: string | null;
  has_thumbnail: number;
  brands_using: number;
  archived: number;
  category_id: string | null;
}

const SUMMARY_COLUMNS = `v.template_version_id, v.template_id, t.name, v.version, v.status, v.submitted_by_label, v.created_at, v.sealed_at,
  EXISTS(SELECT 1 FROM certifications c WHERE c.template_version_id = v.template_version_id
    AND c.check_name = 'screenshot_desktop' AND c.result = 'pass' AND c.artifact_r2_key IS NOT NULL) AS has_thumbnail,
  (SELECT COUNT(DISTINCT b.brand_id) FROM brands b
    JOIN brand_revisions r ON r.brand_id = b.brand_id
    JOIN template_versions used ON used.template_version_id = r.template_version_id
    WHERE b.status != 'retired' AND used.template_id = v.template_id) AS brands_using,
  (t.archived_at IS NOT NULL) AS archived,
  (SELECT m.category_id FROM template_category_map m WHERE m.template_id = v.template_id) AS category_id`;

const summary = (row: VersionRow) => ({
  template_version_id: row.template_version_id,
  template_id: row.template_id,
  name: row.name,
  version: row.version,
  status: TEMPLATE_VERSION_REVIEW_STATUS[row.status],
  submitted_by_label: row.submitted_by_label,
  created_at: row.created_at,
  sealed_at: row.sealed_at,
  thumbnail_url: row.has_thumbnail ? `/api/templates/${encodeURIComponent(row.template_version_id)}/screenshots/desktop` : null,
  brands_using: row.brands_using,
  archived: row.archived === 1,
  category_id: row.category_id,
});

/**
 * True while a template may be hard deleted: no version was ever sealed and no brand revision points at any version.
 * `p` is the placeholder that holds the template id.
 */
const deletable = (p: string) => `NOT EXISTS (SELECT 1 FROM template_versions s WHERE s.template_id = ${p} AND s.status = 'sealed')
  AND NOT EXISTS (SELECT 1 FROM brand_revisions r JOIN template_versions u ON u.template_version_id = r.template_version_id WHERE u.template_id = ${p})`;

/** One audit_log row. `gate` is an SQL condition (it may use ?5, the entity id), so a write that changed nothing leaves no row. */
const auditRow = (env: Env, ctx: AdminRequestContext, action: string, entityType: string, entityId: string, before: unknown, after: unknown, now: string, gate: string) =>
  env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE ${gate}`)
    .bind(ctx.actor_id, ctx.actor_role, action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);

async function deleteBlock(env: Env, id: string): Promise<TemplateDeleteRefusal["error"] | null> {
  const row = await env.FACTORY.prepare(`SELECT
    EXISTS(SELECT 1 FROM brand_revisions r JOIN template_versions u ON u.template_version_id = r.template_version_id WHERE u.template_id = ?1) AS used,
    EXISTS(SELECT 1 FROM template_versions s WHERE s.template_id = ?1 AND s.status = 'sealed') AS approved`)
    .bind(id).first<{ used: number; approved: number }>();
  return row?.used ? "template_in_use" : row?.approved ? "template_was_approved" : null;
}

const invalid = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  json(422, { error: "invalid", issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textDefaults(text: string | null) {
  const parsed = TemplateTextDefaults.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

function themeVars(text: string | null) {
  const parsed = TemplateThemeVars.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

export async function handleTemplateRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext, email: string): Promise<Response | undefined> {
  const method = request.method;

  if (path === "/api/templates" && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    // Archived templates are hidden unless the Templates screen asks for them; the brand picker and the to-do counts never do.
    const includeArchived = new URL(request.url).searchParams.get("include_archived") === "1";
    const { results } = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM template_versions v JOIN templates t ON t.template_id = v.template_id
       ${includeArchived ? "" : "WHERE t.archived_at IS NULL"}
       ORDER BY v.created_at DESC, v.template_version_id LIMIT 200`,
    ).all<VersionRow>();
    const { results: categories } = await env.FACTORY.prepare("SELECT id, name, sort FROM template_categories ORDER BY sort, name").all<TemplateCategory>();
    return json(200, TemplateListResponse.parse({ templates: results.map(summary), categories }));
  }

  if (path === "/api/templates/categories" && method === "POST") {
    if (!authorizePanel("manageTemplates", ctx.actor_role).ok) return forbidden("owner");
    const parsed = TemplateCategoryCreateRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const category = { id: `cat-${crypto.randomUUID()}`, name: parsed.data.name };
    // The name is unique: an existing name inserts nothing, so no audit row either.
    const [inserted] = await env.FACTORY.batch([
      env.FACTORY.prepare(`INSERT INTO template_categories (id, name, sort)
        SELECT ?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM template_categories) WHERE NOT EXISTS (SELECT 1 FROM template_categories WHERE name = ?2)`)
        .bind(category.id, category.name),
      auditRow(env, ctx, "template_category.create", "template_category", category.id, null, category, new Date().toISOString(), "changes() = 1"),
    ]);
    if (inserted!.meta.changes !== 1) return json(409, { error: "category_exists" });
    const row = await env.FACTORY.prepare("SELECT id, name, sort FROM template_categories WHERE id = ?1").bind(category.id).first<TemplateCategory>();
    return json(201, TemplateCategoryCreateResponse.parse({ category: row }));
  }

  if (path === "/api/templates/import-zip" && method === "POST") {
    if (!authorizePanel("importTemplate", ctx.actor_role).ok) return forbidden("employee");
    let form: FormData;
    try {
      form = await readZipForm(request);
    } catch (error) {
      return json(422, { error: "invalid", message: error instanceof Error ? error.message : "Invalid ZIP upload" });
    }
    const parsed = TemplateZipImportRequest.safeParse({ template_id: form.get("template_id"), template_name: form.get("template_name") });
    if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
    if (!env.TEMPLATE_MCP) return json(502, { error: "template_import_unavailable", message: "Template MCP binding is missing" });
    // Rebuild the payload so identity and extra fields cannot be supplied by the browser.
    const payload = new FormData();
    payload.set("template_id", parsed.data.template_id);
    payload.set("template_name", parsed.data.template_name);
    payload.set("file", form.get("file") as File);
    payload.set("submitted_by", JSON.stringify({ key_id: null, label: email }));
    payload.set("created_by", ctx.actor_id);
    let response: Response;
    try {
      response = await env.TEMPLATE_MCP.fetch(new Request("https://template-mcp/submit-zip", { method: "POST", body: payload }));
    } catch {
      return json(502, { error: "template_import_unavailable", message: "Template MCP transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const result = TemplateSubmitResult.safeParse(body);
      return result.success ? json(200, result.data) : json(502, { error: "bad_gateway" });
    }
    return json(response.status === 422 ? 422 : 502, body ?? { error: "template_import_unavailable" });
  }

  if (path === "/api/templates/import" && method === "POST") {
    if (!authorizePanel("importTemplate", ctx.actor_role).ok) return forbidden("employee");
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    // Only the two form fields are read; submitter identity comes from the session, never from the body.
    const parsed = TemplateImportRequest.safeParse({ url: raw?.url, template_name: raw?.template_name });
    if (!parsed.success) {
      return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
    }
    if (!env.TEMPLATE_MCP) return json(502, { error: "template_import_unavailable", message: "Template MCP binding is missing" });
    let response: Response;
    try {
      response = await env.TEMPLATE_MCP.fetch(new Request("https://template-mcp/submit-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: parsed.data.url,
          template_id: templateSlug(parsed.data.template_name),
          template_name: parsed.data.template_name,
          submitted_by: { key_id: null, label: email },
          created_by: ctx.actor_id,
        }),
      }));
    } catch {
      return json(502, { error: "template_import_unavailable", message: "Template MCP transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const result = TemplateSubmitResult.safeParse(body);
      return result.success ? json(200, result.data) : json(502, { error: "bad_gateway" });
    }
    return json(response.status === 422 ? 422 : 502, body ?? { error: "template_import_unavailable" });
  }

  let m = path.match(/^\/api\/templates\/([^/]+)\/screenshots\/(desktop|mobile)$/);
  if (m && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("screenshot");
    const check = await env.FACTORY.prepare(
      `SELECT artifact_r2_key FROM certifications WHERE template_version_id = ?1 AND check_name = ?2
       AND result = 'pass' AND artifact_r2_key IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).bind(id, `screenshot_${m[2]}`).first<{ artifact_r2_key: string }>();
    const object = check && env.ARTIFACTS ? await env.ARTIFACTS.get(check.artifact_r2_key) : null;
    if (!object) return notFound("screenshot");
    return new Response(object.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/approve$/);
  if (m && method === "POST") {
    if (!authorizePanel("approveTemplate", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    if (!env.FACTORY_WORKER) return json(502, { error: "factory_dispatch_failed", message: "Factory Worker binding is missing" });
    // An empty body or {} approves with the detected map; only theme_vars is read, identity comes from the session.
    const text = await request.text();
    let raw: Record<string, unknown> | null = null;
    if (text.length > 0) {
      try {
        raw = JSON.parse(text) as Record<string, unknown> | null;
      } catch {
        return json(400, { error: "invalid_json" });
      }
    }
    const approveRequest = TemplateApproveRequest.safeParse({ theme_vars: raw?.theme_vars });
    if (!approveRequest.success) return json(422, { error: "invalid_theme_vars" });
    if (approveRequest.data.theme_vars) {
      // A sealed version is immutable (trigger in migration 0001), so the corrected map is stored only on a certified
      // version, the one status the seal accepts. A changed map and its audit row are written in one batch.
      const nextJson = JSON.stringify(approveRequest.data.theme_vars);
      const stored = await env.FACTORY.prepare("SELECT theme_vars_json FROM template_versions WHERE template_version_id = ?1 AND status = 'certified'")
        .bind(id).first<{ theme_vars_json: string | null }>();
      if (stored && stored.theme_vars_json !== nextJson) {
        await env.FACTORY.batch([
          env.FACTORY.prepare("UPDATE template_versions SET theme_vars_json = ?2 WHERE template_version_id = ?1 AND status = 'certified'").bind(id, nextJson),
          env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at)
            SELECT ?3,?4,'template.theme_vars','template_version',?1,?5,?2,?6
            WHERE EXISTS (SELECT 1 FROM template_versions WHERE template_version_id = ?1 AND status = 'certified' AND theme_vars_json = ?2)`)
            .bind(id, nextJson, ctx.actor_id, ctx.actor_role, stored.theme_vars_json, new Date().toISOString()),
        ]);
      }
    }
    let response: Response;
    try {
      response = await env.FACTORY_WORKER.fetch(new Request("https://factory/seal-template", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_version_id: id, sealed_by: ctx.actor_id, sealed_role: ctx.actor_role }),
      }));
    } catch {
      return json(502, { error: "factory_dispatch_failed", message: "Factory Worker transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.ok) {
      const approved = TemplateApproveResponse.safeParse(body);
      return approved.success ? json(200, approved.data) : json(502, { error: "bad_gateway" });
    }
    return json(response.status >= 500 ? 502 : response.status, body ?? { error: "factory_dispatch_failed" });
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/detect-theme-vars$/);
  if (m && method === "POST") {
    if (!authorizePanel("approveTemplate", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    if (!env.TEMPLATE_MCP) return json(502, { error: "template_detect_unavailable", message: "Template MCP binding is missing" });
    // Detection reads the stored zip and writes nothing; the owner reviews the proposed map before saving it.
    let response: Response;
    try {
      response = await env.TEMPLATE_MCP.fetch(new Request("https://template-mcp/detect-theme-vars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_version_id: id }),
      }));
    } catch {
      return json(502, { error: "template_detect_unavailable", message: "Template MCP transport failed" });
    }
    const body = await response.json().catch(() => null);
    if (response.status === 200) {
      const result = TemplateThemeVarsResponse.safeParse(body);
      return result.success ? json(200, result.data) : json(502, { error: "bad_gateway" });
    }
    if (response.status === 404 || response.status === 422) return json(response.status, body ?? { error: "template_detect_unavailable" });
    return json(502, { error: "template_detect_unavailable" });
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/theme-vars$/);
  if (m && method === "PUT") {
    if (!authorizePanel("approveTemplate", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    // The body is strict: the actor comes from the session, so an extra key is refused.
    let raw: unknown;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const saveRequest = TemplateThemeVarsRequest.safeParse(raw);
    if (!saveRequest.success) return json(422, { error: "invalid_theme_vars" });
    const row = await env.FACTORY.prepare(`SELECT v.status, ${effectiveThemeVarsSql("v")} AS theme_vars_json FROM template_versions v WHERE v.template_version_id = ?1`)
      .bind(id).first<{ status: TemplateVersionStatusName; theme_vars_json: string | null }>();
    if (!row) return notFound("template");
    // A certified version saves its map through Approve; a sealed row is immutable, so its map goes to template_theme_vars.
    if (row.status !== "sealed") return json(409, { error: "not_sealed" });
    const nextJson = JSON.stringify(saveRequest.data.theme_vars);
    // Compare content, not text: the stored column may hold the same map in another key order or spacing.
    const storedMap = TemplateThemeVars.safeParse(parseJson(row.theme_vars_json));
    if (!storedMap.success || JSON.stringify(storedMap.data) !== nextJson) {
      const now = new Date().toISOString();
      // Both statements are gated on the map that was read: a save that lands in between changes the effective map,
      // so this one writes nothing and no audit row carries a before_json that was never the stored map.
      const [upsert] = await env.FACTORY.batch([
        env.FACTORY.prepare(`INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at)
          SELECT ?1,?2,?3,?4 WHERE (SELECT ${effectiveThemeVarsSql("v")} FROM template_versions v WHERE v.template_version_id = ?1) IS ?5
          ON CONFLICT(template_version_id) DO UPDATE SET theme_vars_json = excluded.theme_vars_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .bind(id, nextJson, ctx.actor_id, now, row.theme_vars_json),
        env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at)
          SELECT ?3,?4,'template.theme_vars','template_version',?1,?5,?2,?6
          WHERE changes() = 1 AND EXISTS (SELECT 1 FROM template_theme_vars WHERE template_version_id = ?1 AND theme_vars_json = ?2 AND updated_at = ?6)`)
          .bind(id, nextJson, ctx.actor_id, ctx.actor_role, row.theme_vars_json, now),
      ]);
      if (upsert!.meta.changes !== 1) return json(409, { error: "conflict", message: "The color map changed; reload and try again" });
    }
    return json(200, TemplateThemeVarsResponse.parse({ template_version_id: id, theme_vars: saveRequest.data.theme_vars }));
  }

  m = path.match(/^\/api\/templates\/([^/]+)$/);
  if (m && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const row = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS}, v.sha256, v.sealed_by, v.text_defaults_json, ${effectiveThemeVarsSql("v")} AS theme_vars_json
       FROM template_versions v JOIN templates t ON t.template_id = v.template_id WHERE v.template_version_id = ?1`,
    ).bind(id).first<VersionRow & { sha256: string; sealed_by: string | null; text_defaults_json: string | null; theme_vars_json: string | null }>();
    if (!row) return notFound("template");
    const { results: checks } = await env.FACTORY.prepare(
      `SELECT check_name, result, details_json, artifact_r2_key, created_at FROM certifications
       WHERE id IN (SELECT MAX(id) FROM certifications WHERE template_version_id = ?1 GROUP BY check_name) ORDER BY check_name`,
    ).bind(id).all<{ check_name: string; result: string; details_json: string | null; artifact_r2_key: string | null; created_at: string }>();
    const shot = (viewport: "desktop" | "mobile") =>
      checks.some((c) => c.check_name === `screenshot_${viewport}` && c.result === "pass" && c.artifact_r2_key)
        ? `/api/templates/${encodeURIComponent(id)}/screenshots/${viewport}`
        : null;
    return json(200, TemplateDetailResponse.parse({
      template: { ...summary(row), sha256: row.sha256, sealed_by: row.sealed_by, text_defaults: textDefaults(row.text_defaults_json), theme_vars: themeVars(row.theme_vars_json) },
      checks: checks.map((c) => ({ check_name: c.check_name, result: c.result, details: parseJson(c.details_json), created_at: c.created_at })),
      screenshots: { desktop: shot("desktop"), mobile: shot("mobile") },
    }));
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/category$/);
  if (m && method === "PATCH") {
    if (!authorizePanel("manageTemplates", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const parsed = TemplateCategoryAssignRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid(parsed.error);
    const categoryId = parsed.data.category_id;
    const row = await env.FACTORY.prepare("SELECT (SELECT category_id FROM template_category_map WHERE template_id = ?1) AS category_id FROM templates WHERE template_id = ?1")
      .bind(id).first<{ category_id: string | null }>();
    if (!row) return notFound("template");
    if (categoryId !== null && !(await env.FACTORY.prepare("SELECT 1 AS ok FROM template_categories WHERE id = ?1").bind(categoryId).first())) return notFound("category");
    const prior = row.category_id;
    if (prior !== categoryId) {
      // The write is gated on the category that was read, so a change that lands in between writes nothing and no audit
      // row carries a before value that was never stored. The caller reloads and tries again.
      const write = categoryId === null
        ? env.FACTORY.prepare("DELETE FROM template_category_map WHERE template_id = ?1 AND category_id = ?2").bind(id, prior)
        : prior === null
          ? env.FACTORY.prepare("INSERT INTO template_category_map (template_id, category_id) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM template_category_map WHERE template_id = ?1)").bind(id, categoryId)
          : env.FACTORY.prepare("UPDATE template_category_map SET category_id = ?2 WHERE template_id = ?1 AND category_id = ?3").bind(id, categoryId, prior);
      const [written] = await env.FACTORY.batch([
        write,
        auditRow(env, ctx, "template.category", "template", id, { category_id: prior }, { category_id: categoryId }, new Date().toISOString(), "changes() = 1"),
      ]);
      if (written!.meta.changes !== 1) return json(409, { error: "conflict" });
    }
    return json(200, TemplateCategoryAssignResponse.parse({ template_id: id, category_id: categoryId }));
  }

  m = path.match(/^\/api\/templates\/([^/]+)\/archive$/);
  if (m && method === "POST") {
    if (!authorizePanel("manageTemplates", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const row = await env.FACTORY.prepare("SELECT archived_at FROM templates WHERE template_id = ?1").bind(id).first<{ archived_at: string | null }>();
    if (!row) return notFound("template");
    if (row.archived_at !== null) return json(200, TemplateArchiveResponse.parse({ ok: true, template_id: id, archived_at: row.archived_at }));
    // Archive only sets templates.archived_at. Versions, brands and R2 objects stay, so brands on this template keep running.
    const now = new Date().toISOString();
    const [archived] = await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE templates SET archived_at = ?2 WHERE template_id = ?1 AND archived_at IS NULL").bind(id, now),
      auditRow(env, ctx, "template.archive", "template", id, { archived_at: null }, { archived_at: now }, now, "changes() = 1"),
    ]);
    // A concurrent archive that won keeps its stamp and its audit row; answer with the stored value.
    if (archived!.meta.changes === 1) return json(200, TemplateArchiveResponse.parse({ ok: true, template_id: id, archived_at: now }));
    const stored = await env.FACTORY.prepare("SELECT archived_at FROM templates WHERE template_id = ?1").bind(id).first<{ archived_at: string | null }>();
    return stored?.archived_at ? json(200, TemplateArchiveResponse.parse({ ok: true, template_id: id, archived_at: stored.archived_at })) : notFound("template");
  }

  m = path.match(/^\/api\/templates\/([^/]+)$/);
  if (m && method === "DELETE") {
    if (!authorizePanel("manageTemplates", ctx.actor_role).ok) return forbidden("owner");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const row = await env.FACTORY.prepare("SELECT name, (SELECT COUNT(*) FROM template_versions WHERE template_id = ?1) AS versions FROM templates WHERE template_id = ?1")
      .bind(id).first<{ name: string; versions: number }>();
    if (!row) return notFound("template");
    const block = await deleteBlock(env, id);
    if (block) return json(409, TemplateDeleteRefusal.parse({ error: block }));
    // One batch, every statement gated on the same rule, so a brand or a seal that lands after the read above deletes nothing.
    // R2 archives and screenshots of the removed versions stay in the bucket.
    const gate = deletable("?1");
    const results = await env.FACTORY.batch([
      auditRow(env, ctx, "template.delete", "template", id, { name: row.name, versions: row.versions }, null, new Date().toISOString(),
        `EXISTS (SELECT 1 FROM templates WHERE template_id = ?5) AND ${deletable("?5")}`),
      env.FACTORY.prepare(`DELETE FROM certifications WHERE template_version_id IN (SELECT template_version_id FROM template_versions WHERE template_id = ?1) AND ${gate}`).bind(id),
      // The certifier writes one fingerprint per version, pass or fail, and it references the version row.
      env.FACTORY.prepare(`DELETE FROM template_fingerprints WHERE template_version_id IN (SELECT template_version_id FROM template_versions WHERE template_id = ?1) AND ${gate}`).bind(id),
      env.FACTORY.prepare(`DELETE FROM template_category_map WHERE template_id = ?1 AND ${gate}`).bind(id),
      env.FACTORY.prepare(`DELETE FROM template_versions WHERE template_id = ?1 AND ${gate}`).bind(id),
      env.FACTORY.prepare(`DELETE FROM templates WHERE template_id = ?1 AND ${gate}`).bind(id),
    ]);
    if (results[results.length - 1]!.meta.changes !== 1) {
      const blockNow = await deleteBlock(env, id);
      return blockNow ? json(409, TemplateDeleteRefusal.parse({ error: blockNow })) : notFound("template");
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  m = path.match(/^\/api\/brands\/([^/]+)\/site-text$/);
  if (m && method === "GET") {
    // Site text defaults belong to the brand, so the brand read rule applies (as GET /api/brands/:id).
    const access = authorize("getBrand", ctx.actor_role);
    if (!access.ok) return json(access.status, access.error);
    const brandId = decodePathSegment(m[1]!);
    if (brandId === null) return notFound("brand");
    // The deployed revision's defaults; before the first install, the latest revision's.
    const row = await env.FACTORY.prepare(
      `SELECT r.config_json FROM brands b JOIN brand_revisions r ON r.revision_id = COALESCE(b.current_revision_id,
         (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1))
       WHERE b.brand_id = ?1`,
    ).bind(brandId).first<{ config_json: string }>();
    const stored = row ? (parseJson(row.config_json) as { text_defaults?: unknown } | null)?.text_defaults ?? null : null;
    const defaults = TemplateTextDefaults.safeParse(stored);
    return json(200, SiteTextDefaultsResponse.parse({ brand_id: brandId, defaults: defaults.success ? defaults.data : null }));
  }

  m = path.match(/^\/api\/brands\/([^/]+)\/theme-vars$/);
  if (m && method === "GET") {
    const access = authorize("getBrand", ctx.actor_role);
    if (!access.ok) return json(access.status, access.error);
    const brandId = decodePathSegment(m[1]!);
    if (brandId === null) return notFound("brand");
    // Same revision as /site-text: the deployed one; before the first install, the latest.
    const row = await env.FACTORY.prepare(
      `SELECT r.config_json, ${effectiveThemeVarsSql("tv")} AS theme_vars_json
       FROM brands b JOIN brand_revisions r ON r.revision_id = COALESCE(b.current_revision_id,
         (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1))
       LEFT JOIN template_versions tv ON tv.template_version_id = r.template_version_id
       WHERE b.brand_id = ?1`,
    ).bind(brandId).first<{ config_json: string; theme_vars_json: string | null }>();
    const baked = row ? TemplateThemeVars.safeParse((parseJson(row.config_json) as { theme_vars?: unknown } | null)?.theme_vars) : null;
    const template = row ? themeVars(row.theme_vars_json) : null;
    return json(200, BrandThemeVarsResponse.parse({
      brand_id: brandId,
      deployed: baked?.success ? baked.data : null,
      template: template && !isEmptyThemeVars(template) ? template : null,
    }));
  }
  return undefined;
}
