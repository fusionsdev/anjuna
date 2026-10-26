/**
 * Routes of the brand wizard screen. Creating and editing a draft, and install, are the existing lifecycle routes;
 * these add what the wizard needs around them:
 *   GET  /api/wizard/defaults        tenant amount buckets and form route (read-only in the Review summary)
 *   POST /api/wizard/zone-check      Cloudflare zone pre-check through the factory Worker (read-only)
 *   GET  /api/wizard/drafts/:id      a draft as the wizard resumes it
 *   GET  /api/wizard/preview/:id     the draft's template rendered with its site text (iframe source)
 *   POST /api/brands/:id/duplicate   a new draft from a brand's template, keyword, profile and site text
 */
import { TEMPLATE_ZIP_LIMITS, TemplateTextDefaults, themeCss, themeStyleTag, type AdminRequestContext } from "@anjuna/contracts";
import { effectiveThemeVarsSql } from "@anjuna/factory-db";
import { unzipSync } from "fflate";
import { DuplicateBrandRequest, WizardDefaultsResponse, WizardDraft, ZoneCheckRequest, ZoneCheckResponse } from "../shared/wizard.js";
import { PageCopyError, renderPageText, templateBrandName, type PageTextData } from "@anjuna/brand-runtime/page-text";
import { applySiteText, type EffectiveSiteText } from "@anjuna/brand-runtime/site-text";
import { writeFactoryAudit } from "./audit.js";
import type { Env } from "./env.js";
import { createDraft, decodePathSegment, storedProfile, tenantDefaults } from "./lifecycle.js";
import { authorizePanel, type PanelAction } from "./panel-roles.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const forbidden = (action: PanelAction, role: AdminRequestContext["actor_role"]): Response | null => {
  const g = authorizePanel(action, role);
  return g.ok ? null : json(403, g.error);
};
const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  json(422, { error: "invalid", issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });

interface DraftRow { brand_id: string; name: string; domain: string; keyword_default: string | null; status: string; revision_id: string; revision: number; template_version_id: string; form_artifact_id: string; config_json: string }

/** The brand and its latest revision. Null when the brand does not exist. */
async function readDraft(env: Env, brandId: string): Promise<DraftRow | null> {
  return env.FACTORY.prepare(`SELECT b.brand_id, b.name, b.domain, b.keyword_default, b.status, r.revision_id, r.revision, r.template_version_id, r.form_artifact_id, r.config_json
    FROM brands b JOIN brand_revisions r ON r.revision_id = (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1)
    WHERE b.brand_id = ?1`).bind(brandId).first<DraftRow>();
}
const editable = (row: DraftRow): row is DraftRow & { status: "draft" | "failed" } => row.status === "draft" || row.status === "failed";
const notEditable = () => json(409, { error: "conflict", message: "Only draft or failed brands can be edited" });
const missingBrand = () => json(404, { error: "not_found", resource: "brand" });

function draftBody(row: DraftRow & { status: "draft" | "failed" }) {
  const profile = storedProfile(row.config_json);
  return WizardDraft.parse({
    brand: { brand_id: row.brand_id, name: row.name, domain: row.domain, keyword_default: row.keyword_default, status: row.status },
    revision: { revision_id: row.revision_id, revision: row.revision, template_version_id: row.template_version_id, form_artifact_id: row.form_artifact_id },
    ...(profile ? { profile } : {}),
  });
}

async function zoneCheck(request: Request, env: Env): Promise<Response> {
  const parsed = ZoneCheckRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return issues(parsed.error);
  if (!env.FACTORY_WORKER) return json(502, { error: "zone_check_unavailable", message: "Factory Worker binding is missing" });
  let response: Response;
  try {
    response = await env.FACTORY_WORKER.fetch(new Request("https://factory/zone-check", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data),
    }));
  } catch {
    return json(502, { error: "zone_check_unavailable", message: "Factory Worker transport failed" });
  }
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  if (!response.ok) return json(502, { error: "zone_check_failed", message: typeof body?.message === "string" ? body.message : `Factory Worker returned ${response.status}` });
  const result = ZoneCheckResponse.safeParse(body);
  return result.success ? json(200, result.data) : json(502, { error: "zone_check_failed", message: "Factory Worker answered with an unexpected shape" });
}

async function duplicate(request: Request, env: Env, ctx: AdminRequestContext, sourceId: string): Promise<Response> {
  const parsed = DuplicateBrandRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return issues(parsed.error);
  const source = await env.FACTORY.prepare(`SELECT b.brand_id, b.keyword_default, r.template_version_id, r.config_json
    FROM brands b JOIN brand_revisions r ON r.revision_id = COALESCE(b.current_revision_id, (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1))
    WHERE b.brand_id = ?1`).bind(sourceId).first<{ brand_id: string; keyword_default: string | null; template_version_id: string; config_json: string }>();
  if (!source) return missingBrand();
  // Only these three things are copied. The domain, ids, checklist, tokens, install state and the rest of config_json stay behind.
  let configKeyword: unknown;
  try { configKeyword = (JSON.parse(source.config_json) as { keyword_default?: unknown }).keyword_default; } catch { configKeyword = undefined; }
  const keyword = source.keyword_default ?? (typeof configKeyword === "string" ? configKeyword : null);
  if (!keyword) return json(422, { error: "invalid", issues: [{ path: "keyword_default", message: "The source brand has no keyword" }] });
  const profile = storedProfile(source.config_json);
  const created = await createDraft(new Request("https://panel/api/brands/drafts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: parsed.data.domain, keyword_default: keyword, template_version_id: source.template_version_id, ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(profile ? { profile } : {}) }),
  }), env, ctx);
  if (created.status !== 201) return created;
  const body = await created.json() as { brand: { brand_id: string }; revision: { revision_id: string } };
  await writeFactoryAudit(env.FACTORY, { actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "brand.duplicate", entity_type: "brand", entity_id: body.brand.brand_id, after: { source_brand_id: sourceId } });
  const row = await readDraft(env, body.brand.brand_id);
  return json(201, { ...draftBody(row as DraftRow & { status: "draft" | "failed" }), duplicated_from: sourceId });
}

// ---- Preview ---------------------------------------------------------------------------------------------------

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
/** Total size of stylesheets, images and fonts folded into one preview document. */
const MAX_INLINE_BYTES = 6 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
const PREVIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A reference from the template, as a path inside the archive. Null for data:, remote and fragment references. */
function archivePath(ref: string, fromDir = ""): string | null {
  const value = ref.trim();
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
  let path = value.split(/[?#]/)[0]!;
  try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
  const out: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${fromDir}${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return out.join("/");
}

/**
 * The template's index.html as the brand serves it: renderPageText (the install render: copy, contact, template brand
 * name) and then applySiteText (the brand Worker: brand name in [data-brand], title, description, the template brand
 * name replaced in an unedited title). It needs no core runtime row. Scripts are removed; stylesheets, images and
 * fonts of the archive are folded into the document, so the page makes no request and renders under the sandbox CSP.
 * Throws PageCopyError when the saved copy breaks the copy rules, as the install does.
 */
async function previewHtml(files: Record<string, Uint8Array>, input: { site: EffectiveSiteText; page: PageTextData; theme: string | null }): Promise<string | null> {
  if (!files["index.html"]) return null;
  const pages = new Map(Object.entries(files).filter(([path]) => /\.html?$/i.test(path)).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
  const index = (await renderPageText(pages, input.page)).get("index.html")!;
  let inlined = 0;
  const take = (path: string | null): Uint8Array | null => {
    const bytes = path ? files[path] : undefined;
    if (!bytes || inlined + bytes.length > MAX_INLINE_BYTES) return null;
    inlined += bytes.length;
    return bytes;
  };
  const dataUri = (path: string | null): string | null => {
    const mime = path ? MIME[path.split(".").pop()!.toLowerCase()] : undefined;
    const bytes = mime ? take(path) : null;
    return bytes && mime ? `data:${mime};base64,${toBase64(bytes)}` : null;
  };
  const css = (path: string): string => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const text = new TextDecoder().decode(files[path]!).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, _quote: string, ref: string) => {
      const uri = dataUri(archivePath(ref, dir));
      return uri ? `url("${uri}")` : match;
    });
    return text.replace(/<\/style/gi, "<\\/style");
  };
  const rewriter = applySiteText(new HTMLRewriter(), input.site, "index")
    .on("script", { element(el) { el.remove(); } })
    .on('link[rel~="stylesheet"][href]', { element(el) {
      const path = archivePath(el.getAttribute("href") ?? "");
      if (path && files[path] && take(path)) el.replace(`<style>${css(path)}</style>`, { html: true });
      else el.remove();
    } })
    .on('link[href]:not([rel~="stylesheet"])', { element(el) { el.remove(); } })
    .on("img[src]", { element(el) {
      const uri = dataUri(archivePath(el.getAttribute("src") ?? ""));
      if (uri) el.setAttribute("src", uri); else el.removeAttribute("src");
      el.removeAttribute("srcset");
    } })
    .on("source[srcset]", { element(el) { el.removeAttribute("srcset"); } });
  if (input.theme !== null) {
    const tag = themeStyleTag(input.theme);
    rewriter.on("head", { element(el) { el.append(tag, { html: true }); } });
  }
  return rewriter.transform(new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
}

async function preview(env: Env, brandId: string): Promise<Response> {
  const row = await readDraft(env, brandId);
  if (!row) return missingBrand();
  if (!editable(row)) return notEditable();
  const template = await env.FACTORY.prepare(`SELECT tv.r2_key, tv.text_defaults_json, ${effectiveThemeVarsSql("tv")} AS theme_vars_json, t.name AS template_name
    FROM template_versions tv LEFT JOIN templates t ON t.template_id = tv.template_id WHERE tv.template_version_id = ?1 AND tv.status = 'sealed'`)
    .bind(row.template_version_id).first<{ r2_key: string; text_defaults_json: string | null; theme_vars_json: string | null; template_name: string | null }>();
  if (!template) return json(422, { error: "template_not_sealed" });
  const object = env.ARTIFACTS ? await env.ARTIFACTS.get(template.r2_key) : null;
  if (!object) return json(503, { error: "preview_unavailable", message: "Template archive is not available" });
  if (object.size > TEMPLATE_ZIP_LIMITS.maxArchiveBytes) return json(422, { error: "preview_unavailable", message: "Template archive is too large to preview" });
  let files: Record<string, Uint8Array>;
  try {
    let total = 0;
    const raw = unzipSync(new Uint8Array(await object.arrayBuffer()), { filter: (file) => {
      if (file.originalSize > MAX_FILE_BYTES) return false;
      total += file.originalSize;
      return total <= MAX_UNZIPPED_BYTES;
    } });
    files = Object.fromEntries(Object.entries(raw).map(([name, bytes]) => [name.replace(/^\/+/, ""), bytes]));
  } catch {
    return json(422, { error: "preview_unavailable", message: "Template archive could not be read" });
  }
  let defaults: TemplateTextDefaults | null = null;
  try {
    const parsedDefaults = TemplateTextDefaults.safeParse(JSON.parse(template.text_defaults_json ?? "null"));
    if (parsedDefaults.success) defaults = parsedDefaults.data;
  } catch { /* invalid JSON: no defaults */ }
  const profile = storedProfile(row.config_json);
  const copy = profile?.copy ?? {};
  const brand = copy.brand_name ?? (row.name.trim() || defaults?.brand_name) ?? row.name;
  // The install render takes the same inputs: profile.copy.brand_name else brands.name, and brands.keyword_default.
  const page: PageTextData = {
    brand_name: copy.brand_name ?? row.name, profile,
    template_brand: templateBrandName(template.text_defaults_json, template.template_name), keyword_default: row.keyword_default,
  };
  const site: EffectiveSiteText = { brand, title: copy.site_title ?? null, description: copy.site_description ?? null, templateBrand: defaults?.brand_name ?? null };
  let themeVars: unknown = null;
  try { themeVars = JSON.parse(template.theme_vars_json ?? "null"); } catch { /* invalid JSON: no color variables */ }
  let html: string | null;
  try {
    html = await previewHtml(files, { site, page, theme: themeCss(profile?.theme, themeVars) });
  } catch (error) {
    if (error instanceof PageCopyError) return json(422, { error: "invalid_copy", message: error.message });
    throw error;
  }
  if (html === null) return json(422, { error: "preview_unavailable", message: "Template has no index.html" });
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": PREVIEW_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}

export async function handleWizardRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const method = request.method;
  let m: RegExpMatchArray | null;
  if (path === "/api/wizard/defaults" && method === "GET") {
    const denied = forbidden("createBrand", ctx.actor_role); if (denied) return denied;
    const defaults = tenantDefaults(env);
    if (!defaults) return json(503, { error: "tenant_configuration_missing", message: "Tenant runtime defaults are not configured" });
    return json(200, WizardDefaultsResponse.parse({ amount_buckets: defaults.amount_buckets, form_route: defaults.form_route }));
  }
  if (path === "/api/wizard/zone-check" && method === "POST") {
    const denied = forbidden("createBrand", ctx.actor_role); if (denied) return denied;
    return zoneCheck(request, env);
  }
  if ((m = path.match(/^\/api\/wizard\/(drafts|preview)\/([^/]+)$/)) && method === "GET") {
    const denied = forbidden("createBrand", ctx.actor_role); if (denied) return denied;
    const brandId = decodePathSegment(m[2]!);
    if (brandId === null) return json(400, { error: "invalid_brand_id" });
    if (m[1] === "preview") return preview(env, brandId);
    const row = await readDraft(env, brandId);
    if (!row) return missingBrand();
    return editable(row) ? json(200, draftBody(row)) : notEditable();
  }
  if ((m = path.match(/^\/api\/brands\/([^/]+)\/duplicate$/)) && method === "POST") {
    const denied = forbidden("duplicateBrand", ctx.actor_role); if (denied) return denied;
    const brandId = decodePathSegment(m[1]!);
    if (brandId === null) return json(400, { error: "invalid_brand_id" });
    return duplicate(request, env, ctx, brandId);
  }
  return undefined;
}
