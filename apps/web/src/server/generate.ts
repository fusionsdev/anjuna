/**
 * POST /api/brands/:id/generate: one call that checks the draft is complete and then starts the install through the same
 * code as POST /api/brands/:id/install. Idempotent: while the brand's install is queued or running, a second call answers
 * 200 with that install's id and starts nothing. Two calls that race both reach the install claim, which admits one; the
 * other gets the winner's id the same way.
 */
import { BrandProfile, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";

export type StartInstall = (request: Request, env: Env, ctx: AdminRequestContext, brandId: string) => Promise<Response>;

/** A field Generate needs, with a Thai + English message for the panel. */
export interface GenerateIssue {
  field: string;
  message: string;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// The apex rule of draft creation (lifecycle.ts, Draft.domain).
const APEX_DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/;

/**
 * What a draft needs before Generate: an apex domain, a sealed template, a keyword, and the contact phone, address and email
 * the legal pages print. Term, APR and the other loan rules are not asked: the template carries its own text and the lender
 * sets the real rate at review. Ads routing is optional: the owner can set it after go-live. Empty means the draft can install.
 */
export function draftIssues(draft: { domain: string; template_status: string | null; keyword_default: string | null; config_json: string }): GenerateIssue[] {
  const issues: GenerateIssue[] = [];
  if (draft.domain.startsWith("www.") || !APEX_DOMAIN.test(draft.domain)) issues.push({ field: "domain", message: "โดเมนต้องเป็น apex domain ที่ถูกต้อง (Domain must be a valid apex domain)" });
  if (draft.template_status !== "sealed") issues.push({ field: "template_version_id", message: "เทมเพลตยังไม่ถูก seal (Template version is not sealed)" });
  if (!draft.keyword_default?.trim()) issues.push({ field: "keyword_default", message: "ต้องระบุคีย์เวิร์ด (Keyword is required)" });
  let raw: unknown;
  try { raw = (JSON.parse(draft.config_json) as { profile?: unknown } | null)?.profile; } catch { raw = undefined; }
  const parsed = BrandProfile.safeParse(raw ?? {});
  if (!parsed.success) {
    issues.push({ field: "profile", message: "ข้อมูลโปรไฟล์แบรนด์ไม่ถูกต้อง (Brand profile is invalid)" });
    return issues;
  }
  const { contact } = parsed.data;
  const required: Array<[string, unknown, string]> = [
    ["profile.contact.phone", contact?.phone, "ต้องระบุเบอร์โทรศัพท์ (Phone is required)"],
    ["profile.contact.address", contact?.address, "ต้องระบุที่อยู่ (Address is required)"],
    ["profile.contact.email", contact?.email, "ต้องระบุอีเมล (Email is required)"],
  ];
  for (const [field, value, message] of required) if (value === undefined) issues.push({ field, message });
  return issues;
}

async function activeOperation(db: D1Database, brandId: string) {
  return db.prepare("SELECT install_id,kind,status FROM installs WHERE brand_id = ?1 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1")
    .bind(brandId).first<{ install_id: string; kind: string; status: string }>();
}

const running = (brandId: string, active: { install_id: string; status: string }) =>
  json(200, { install_id: active.install_id, brand_id: brandId, status: active.status, idempotent: true });

export async function generateBrand(request: Request, env: Env, ctx: AdminRequestContext, brandId: string, startInstall: StartInstall): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT brand_id,domain,keyword_default,status FROM brands WHERE brand_id = ?1").bind(brandId)
    .first<{ brand_id: string; domain: string; keyword_default: string | null; status: string }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  const active = await activeOperation(env.FACTORY, brandId);
  if (active?.kind === "install") return running(brandId, active);
  if (active) return json(409, { error: "lifecycle_operation_active", active_install_id: active.install_id, active_kind: active.kind, active_status: active.status });
  if (brand.status !== "draft" && brand.status !== "failed") return json(409, { error: "conflict", message: "Only draft or failed brands can be generated" });

  const revision = await env.FACTORY.prepare(`SELECT r.revision_id, r.config_json, v.status AS template_status
    FROM brand_revisions r LEFT JOIN template_versions v ON v.template_version_id = r.template_version_id
    WHERE r.brand_id = ?1 ORDER BY r.revision DESC LIMIT 1`).bind(brandId)
    .first<{ revision_id: string; config_json: string; template_status: string | null }>();
  if (!revision) return json(422, { error: "revision_missing" });
  const issues = draftIssues({ domain: brand.domain, keyword_default: brand.keyword_default, ...revision });
  if (issues.length > 0) return json(422, { error: "draft_incomplete", issues });

  const response = await startInstall(new Request(request.url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision_id: revision.revision_id }),
  }), env, ctx, brandId);
  if (response.status !== 409) return response;
  // Lost the claim to a concurrent Generate or Install: answer with the install that won.
  const body = await response.clone().json().catch(() => null) as { active_install_id?: unknown; active_kind?: unknown; active_status?: unknown } | null;
  if (body?.active_kind === "install" && typeof body.active_install_id === "string") {
    return running(brandId, { install_id: body.active_install_id, status: String(body.active_status) });
  }
  return response;
}
