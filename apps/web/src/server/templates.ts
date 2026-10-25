/**
 * Templates screen API: versions from the factory D1, screenshots from R2, Approve through the factory
 * Worker (it seals with the owner's user id), URL and ZIP imports through the template MCP service binding.
 */
import {
  TEMPLATE_VERSION_REVIEW_STATUS,
  TemplateApproveRequest,
  TemplateApproveResponse,
  TemplateDetailResponse,
  TemplateImportRequest,
  TemplateZipImportRequest,
  TemplateListResponse,
  TemplateSubmitResult,
  SiteTextDefaultsResponse,
  TemplateTextDefaults,
  TemplateThemeVars,
  authorize,
  templateSlug,
  type AdminRequestContext,
  type TemplateVersionStatusName,
} from "@anjuna/contracts";
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
}

const SUMMARY_COLUMNS = `v.template_version_id, v.template_id, t.name, v.version, v.status, v.submitted_by_label, v.created_at, v.sealed_at,
  EXISTS(SELECT 1 FROM certifications c WHERE c.template_version_id = v.template_version_id
    AND c.check_name = 'screenshot_desktop' AND c.result = 'pass' AND c.artifact_r2_key IS NOT NULL) AS has_thumbnail,
  (SELECT COUNT(DISTINCT b.brand_id) FROM brands b
    JOIN brand_revisions r ON r.brand_id = b.brand_id
    JOIN template_versions used ON used.template_version_id = r.template_version_id
    WHERE b.status != 'retired' AND used.template_id = v.template_id) AS brands_using`;

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
});

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
    const { results } = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM template_versions v JOIN templates t ON t.template_id = v.template_id
       ORDER BY v.created_at DESC, v.template_version_id LIMIT 200`,
    ).all<VersionRow>();
    return json(200, TemplateListResponse.parse({ templates: results.map(summary) }));
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
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const approveRequest = TemplateApproveRequest.safeParse({ theme_vars: raw?.theme_vars });
    if (!approveRequest.success) return json(422, { error: "invalid_theme_vars" });
    if (approveRequest.data.theme_vars) {
      // A sealed version is immutable (trigger in migration 0001), so the corrected map is stored only before the seal.
      await env.FACTORY.prepare("UPDATE template_versions SET theme_vars_json = ?2 WHERE template_version_id = ?1 AND status <> 'sealed'")
        .bind(id, JSON.stringify(approveRequest.data.theme_vars)).run();
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

  m = path.match(/^\/api\/templates\/([^/]+)$/);
  if (m && method === "GET") {
    if (!authorizePanel("listTemplates", ctx.actor_role).ok) return forbidden("employee");
    const id = decodePathSegment(m[1]!);
    if (id === null) return notFound("template");
    const row = await env.FACTORY.prepare(
      `SELECT ${SUMMARY_COLUMNS}, v.sha256, v.sealed_by, v.text_defaults_json, v.theme_vars_json
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
  return undefined;
}
