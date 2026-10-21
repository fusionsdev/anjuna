/**
 * Routes of the brand edit page (the config panel of a live brand). The template version change is the existing
 * POST /api/brands/:id/redeploy with a template_version_id (lifecycle.ts); these add what the page needs around it:
 *   GET    /api/brands/:id/edit             template version and Microsoft Ads account of the current revision
 *   PATCH  /api/brands/:id/microsoft-ads    Owner: set or clear profile.ads.microsoft_ads_account (config only, no drain change)
 *   GET    /api/brands/:id/assets           the stored favicon and logo (type, size, hash)
 *   GET    /api/brands/:id/assets/:kind     the stored bytes, for the panel preview
 *   PUT    /api/brands/:id/assets/:kind     upload a favicon or logo (multipart `file`); bytes pass the brand-clean scan first
 *   DELETE /api/brands/:id/assets/:kind     remove it; the brand serves the generated initial-letter icon again
 * The brand Worker reads the stored bytes through core's brandAsset RPC (factory brand_assets).
 */
import {
  BRAND_ASSET_MAX_BASE64, BRAND_ASSET_MAX_BYTES, BrandAssetKind, BrandAssetListResponse, BrandAssetSummary, BrandId, BrandProfile,
  base64ToBytes, bytesToBase64, checkBrandAssetBytes, type AdminRequestContext,
} from "@anjuna/contracts";
import { scanBrandFile } from "@anjuna/template-cert/brand-scan";
import { BrandEditState, MicrosoftAdsRequest } from "../shared/brand-edit.js";
import { writeFactoryAudit } from "./audit.js";
import type { Env } from "./env.js";
import { decodePathSegment, storedProfile } from "./lifecycle.js";
import { authorizePanel, type PanelAction } from "./panel-roles.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const forbidden = (action: PanelAction, role: AdminRequestContext["actor_role"]): Response | null => {
  const g = authorizePanel(action, role);
  return g.ok ? null : json(403, g.error);
};
const notFound = (resource: string) => json(404, { error: "not_found", resource });

/** Multipart overhead allowed on top of the largest file. */
const FORM_OVERHEAD_BYTES = 16 * 1024;
const MAX_FORM_BYTES = BRAND_ASSET_MAX_BYTES.logo + FORM_OVERHEAD_BYTES;
class TooLarge extends Error {}

/** Bound the multipart bytes before formData() buffers them, including chunked requests. */
async function readAssetForm(request: Request): Promise<File | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType) || !request.body) return null;
  if (Number(request.headers.get("content-length")) > MAX_FORM_BYTES) throw new TooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORM_BYTES) { await reader.cancel(); throw new TooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "content-type": contentType } }).formData(); } catch { return null; }
  const file = form.get("file");
  return file && typeof file !== "string" ? file : null;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface AssetRow { kind: string; content_type: string; byte_length: number; sha256: string; updated_at: string }

async function listAssets(env: Env, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT brand_id FROM brands WHERE brand_id = ?1").bind(brandId).first();
  if (!brand) return notFound("brand");
  const { results } = await env.FACTORY.prepare("SELECT kind, content_type, byte_length, sha256, updated_at FROM brand_assets WHERE brand_id = ?1 ORDER BY kind").bind(brandId).all<AssetRow>();
  return json(200, BrandAssetListResponse.parse({ brand_id: brandId, assets: results.map((row) => BrandAssetSummary.parse(row)) }));
}

async function readAsset(env: Env, brandId: string, kind: BrandAssetKind): Promise<Response> {
  const row = await env.FACTORY.prepare("SELECT content_type, sha256, body_base64 FROM brand_assets WHERE brand_id = ?1 AND kind = ?2").bind(brandId, kind)
    .first<{ content_type: string; sha256: string; body_base64: string }>();
  if (!row) return notFound("asset");
  return new Response(base64ToBytes(row.body_base64), { status: 200, headers: {
    "content-type": row.content_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", etag: `"${row.sha256}"`,
  } });
}

/** Other brands whose names, ids and domains a brand's bytes must not carry (the identity scan of template certification). */
async function otherBrands(env: Env, brandId: string): Promise<{ denyDomains: string[]; denyIdentifiers: string[] }> {
  const { results } = await env.FACTORY.prepare("SELECT brand_id, name, domain FROM brands WHERE brand_id != ?1 AND status != 'retired'")
    .bind(brandId).all<{ brand_id: string; name: string; domain: string }>();
  return { denyDomains: results.map((row) => row.domain), denyIdentifiers: results.flatMap((row) => [row.name, row.brand_id]) };
}

async function putAsset(request: Request, env: Env, ctx: AdminRequestContext, brandId: string, kind: BrandAssetKind): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT status FROM brands WHERE brand_id = ?1").bind(brandId).first<{ status: string }>();
  if (!brand) return notFound("brand");
  if (brand.status === "retired") return json(409, { error: "conflict", message: "A retired brand cannot be edited" });
  let file: File | null;
  try { file = await readAssetForm(request); } catch (error) {
    if (error instanceof TooLarge) return json(413, { error: "invalid_asset", code: "too_large", message: `The ${kind} must be at most ${BRAND_ASSET_MAX_BYTES[kind]} bytes.` });
    throw error;
  }
  if (!file) return json(422, { error: "invalid_asset", code: "file_required", message: "Send the image as multipart/form-data in the field `file`." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkBrandAssetBytes(kind, bytes);
  if (!checked.ok) return json(422, { error: "invalid_asset", code: checked.code, message: checked.message });
  // The bytes are brand bytes: they pass the same identity scan as a template, including every other brand's name and domain.
  const scan = scanBrandFile({ name: kind, bytes, ...(await otherBrands(env, brandId)) });
  if (scan.length > 0) return json(422, { error: "invalid_asset", code: "brand_clean", message: "The file contains a platform or other-brand identifier. Remove it and upload again.", issues: scan.slice(0, 5) });

  const body_base64 = bytesToBase64(bytes);
  if (body_base64.length > BRAND_ASSET_MAX_BASE64) return json(413, { error: "invalid_asset", code: "too_large", message: "The file is too large." });
  const sha256 = await sha256Hex(bytes);
  const now = new Date().toISOString();
  const after = { kind, content_type: checked.content_type, byte_length: bytes.byteLength, sha256 };
  await env.FACTORY
    .prepare(`INSERT INTO brand_assets (brand_id,kind,content_type,byte_length,sha256,body_base64,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
      ON CONFLICT(brand_id,kind) DO UPDATE SET content_type=excluded.content_type, byte_length=excluded.byte_length, sha256=excluded.sha256, body_base64=excluded.body_base64, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(brandId, kind, checked.content_type, bytes.byteLength, sha256, body_base64, ctx.actor_id, now).run();
  await writeFactoryAudit(env.FACTORY, { actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "brand.asset.put", entity_type: "brand", entity_id: brandId, after });
  return json(200, { asset: BrandAssetSummary.parse({ ...after, updated_at: now }) });
}

async function deleteAsset(env: Env, ctx: AdminRequestContext, brandId: string, kind: BrandAssetKind): Promise<Response> {
  const removed = await env.FACTORY.prepare("DELETE FROM brand_assets WHERE brand_id = ?1 AND kind = ?2").bind(brandId, kind).run();
  if (removed.meta.changes !== 1) return notFound("asset");
  await writeFactoryAudit(env.FACTORY, { actor_id: ctx.actor_id, actor_role: ctx.actor_role, action: "brand.asset.delete", entity_type: "brand", entity_id: brandId, after: { kind } });
  return json(200, { brand_id: brandId, kind, removed: true });
}

interface CurrentRevision { status: string; revision_id: string; template_version_id: string; config_json: string }

/** The brand's current revision (the latest one before its first install). */
async function currentRevision(env: Env, brandId: string): Promise<CurrentRevision | null> {
  return env.FACTORY.prepare(`SELECT b.status, r.revision_id, r.template_version_id, r.config_json FROM brands b
    JOIN brand_revisions r ON r.revision_id = COALESCE(b.current_revision_id, (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1))
    WHERE b.brand_id = ?1`).bind(brandId).first<CurrentRevision>();
}

async function editState(env: Env, brandId: string): Promise<Response> {
  const row = await currentRevision(env, brandId);
  if (!row) return notFound("brand");
  return json(200, BrandEditState.parse({
    brand_id: brandId, status: row.status, template_version_id: row.template_version_id,
    microsoft_ads_account: storedProfile(row.config_json)?.ads?.microsoft_ads_account ?? null,
  }));
}

// A running install or rollback copies the current revision's config, so an edit made meanwhile would be lost: the gate refuses it.
const NO_ACTIVE_OPERATION = "NOT EXISTS (SELECT 1 FROM installs WHERE brand_id = ?4 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running'))";

async function setMicrosoftAds(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const parsed = MicrosoftAdsRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  const row = await currentRevision(env, brandId);
  if (!row) return notFound("brand");
  if (row.status !== "live" && row.status !== "paused") return json(409, { error: "conflict", message: "Edit a draft in the wizard; only a live brand is edited here" });
  const config = JSON.parse(row.config_json) as Record<string, unknown>;
  const profile = storedProfile(row.config_json);
  if (config.profile !== undefined && !profile) return json(409, { error: "conflict", message: "The stored profile is not valid; fix it in the wizard first" });
  const before = profile?.ads?.microsoft_ads_account ?? null;
  const next = parsed.data.microsoft_ads_account;
  if (before === next) return json(200, { brand_id: brandId, microsoft_ads_account: next, changed: false });

  const { microsoft_ads_account: _drop, ...otherAds } = profile?.ads ?? {};
  const ads = next === null ? otherAds : { ...otherAds, microsoft_ads_account: next };
  const { ads: _oldAds, ...otherGroups } = profile ?? {};
  const nextProfile = BrandProfile.parse(Object.keys(ads).length > 0 ? { ...otherGroups, ads } : otherGroups);
  const nextConfig = JSON.stringify({ ...config, profile: nextProfile });
  const now = new Date().toISOString();
  // ?1 new config, ?2 revision, ?3 config as read, ?4 brand
  const [update] = await env.FACTORY.batch([
    env.FACTORY.prepare(`UPDATE brand_revisions SET config_json = ?1 WHERE revision_id = ?2 AND config_json = ?3 AND ${NO_ACTIVE_OPERATION}`).bind(nextConfig, row.revision_id, row.config_json, brandId),
    env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at)
      SELECT ?5,?6,'brand.profile.ads','brand',?4,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM brand_revisions WHERE revision_id = ?2 AND config_json = ?1 AND ?1 != ?3)`).bind(nextConfig, row.revision_id, row.config_json, brandId, ctx.actor_id, ctx.actor_role,
      JSON.stringify({ microsoft_ads_account: before }), JSON.stringify({ microsoft_ads_account: next }), now),
  ]);
  if (update!.meta.changes !== 1) return json(409, { error: "conflict", message: "The brand changed or an install is running; reload and try again" });
  return json(200, { brand_id: brandId, microsoft_ads_account: next, changed: true });
}

export async function handleBrandEditRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const m = path.match(/^\/api\/brands\/([^/]+)\/(edit|microsoft-ads|assets)(?:\/([^/]+))?$/);
  if (!m) return undefined;
  const brandId = decodePathSegment(m[1]!);
  const id = brandId === null ? null : BrandId.safeParse(brandId);
  if (!id?.success) return json(400, { error: "invalid_brand_id" });
  const { method } = request;
  const part = m[2]!, sub = m[3];

  if (part === "edit" && sub === undefined && method === "GET") {
    return forbidden("viewBrandEdit", ctx.actor_role) ?? editState(env, id.data);
  }
  if (part === "microsoft-ads" && sub === undefined && method === "PATCH") {
    return forbidden("setBrandMicrosoftAds", ctx.actor_role) ?? setMicrosoftAds(request, env, ctx, id.data);
  }
  if (part === "assets") {
    const denied = forbidden("editBrandAssets", ctx.actor_role);
    if (sub === undefined && method === "GET") return denied ?? listAssets(env, id.data);
    const kind = BrandAssetKind.safeParse(sub !== undefined ? decodePathSegment(sub) : undefined);
    if (sub !== undefined && !kind.success) return denied ?? notFound("asset_kind");
    if (kind.success) {
      if (method === "GET") return denied ?? readAsset(env, id.data, kind.data);
      if (method === "PUT") return denied ?? putAsset(request, env, ctx, id.data, kind.data);
      if (method === "DELETE") return denied ?? deleteAsset(env, ctx, id.data, kind.data);
    }
  }
  return undefined;
}
