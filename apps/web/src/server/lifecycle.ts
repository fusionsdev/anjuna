import {
  AdminRole,
  BackfillPayloadVersionRequest,
  VerifySoldLeadResponse,
  RuntimeListResponse,
  PrepopBase,
  BrandDraftKeyword,
  BrandId,
  BrandName,
  BrandProfile,
  UpdateBrandDraftRequest,
  type UpdateBrandDraftResponse,
  isBrandClean,
  withTextDefaults,
  LifecycleBrandSummary,
  SealedTemplatesResponse,
  adminContextToHeaders,
  type AdminRequestContext,
  type CoreListError,
  type CoreListErrorCode,
  type InstallOperation,
  type BrandConfig,
  type GetBrandResponse,
} from "@anjuna/contracts";
import { z } from "zod";
import { DraftDomain } from "../shared/wizard.js";
import type { Env } from "./env.js";
import { writeFactoryAudit } from "./audit.js";
import { callCore } from "./core.js";
import { drainRouteRow, smokeFinalUrlRow } from "./drain-route-checklist.js";
import { generateBrand } from "./generate.js";
import { authorizePanel } from "./panel-roles.js";
import { queueInstallRetry } from "./retry-install.js";
import { latestUpgrade } from "./upgrade-outcomes.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const Id = z.string().min(1).max(128);
const Artifact = z.strictObject({
  form_artifact_id: Id, template_version_id: Id,
  git_sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  bundle_form_version: z.string().regex(/^form@[A-Za-z0-9._-]+$/),
  payload_version: z.literal("2026-01"),
  // SHA-256 of the released form ZIP, printed by the lead-form workflow. Absent keeps the "registered" placeholder.
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/i, "Must be 64 hex characters").transform((value) => value.toLowerCase()).optional(),
});
const Draft = z.strictObject({
  domain: DraftDomain,
  keyword_default: BrandDraftKeyword, template_version_id: Id,
  name: BrandName.optional(),
  profile: BrandProfile.optional(),
});
// Absent form_artifact_id keeps the form the brand runs; absent template_version_id keeps its template version.
const Redeploy = z.strictObject({ form_artifact_id: Id.optional(), template_version_id: Id.optional() });
// The artifact rule shared by draft creation, the redeploy choice and the "newer form" offer: the tenant's payload version
// (bound as ?1) and a form@ bundle id.
const COMPATIBLE_FORM = "payload_version = ?1 AND bundle_form_version GLOB 'form@*'";
const Upgrade = z.strictObject({
  from_template_version_id: Id, to_template_version_id: Id, form_artifact_id: Id,
  canary_brand_id: BrandId,
}).refine((v) => v.from_template_version_id !== v.to_template_version_id, { message: "source and target must differ" });

type Db = D1Database;

function forbidden(role: AdminRole): Response {
  void role;
  return json(403, { error: "forbidden_role", required_role: "owner" });
}

async function audit(db: Db, ctx: AdminRequestContext, action: string, type: string, id: string, after?: Record<string, unknown>): Promise<void> {
  await writeFactoryAudit(db, { actor_id: ctx.actor_id, actor_role: ctx.actor_role, action, entity_type: type, entity_id: id, after });
}

async function setFailed(db: Db, installId: string, message: string): Promise<void> {
  await db.prepare("UPDATE installs SET status = 'failed', error = ?1, finished_at = ?2 WHERE install_id = ?3 AND status IN ('queued','failed')")
    .bind(message.slice(0, 500), new Date().toISOString(), installId).run();
}

async function activeLifecycleOperation(db: Db, brandId: string): Promise<{ install_id: string; kind: string; status: string } | null> {
  return db.prepare("SELECT install_id,kind,status FROM installs WHERE brand_id = ?1 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1")
    .bind(brandId).first<{ install_id: string; kind: string; status: string }>();
}

export function tenantDefaults(env: Env): { account: string; aid: string; prepop_base: string; form_route: string; amount_buckets: number[]; payload_version: string } | null {
  const account = env.DEFAULT_ACCOUNT?.trim();
  const aid = env.DEFAULT_AID?.trim();
  const prepop = env.DEFAULT_PREPOP_BASE?.trim();
  const formRoute = env.DEFAULT_FORM_ROUTE?.trim();
  const payloadVersion = env.DEFAULT_PAYLOAD_VERSION?.trim();
  const placeholder = /(?:<[^>]+>|REPLACE|PLACEHOLDER|TODO|CHANGE_ME|\.invalid|example\.com)/i;
  const reservedRoutes = ["/go", "/_f", "/api", "/privacy", "/terms", "/do-not-sell", "/disclosures"];
  if (!account || !aid || !prepop || !formRoute || !payloadVersion || [account, aid, prepop, formRoute, payloadVersion].some((v) => placeholder.test(v))) return null;
  let amountBuckets: number[];
  try { amountBuckets = JSON.parse(env.DEFAULT_AMOUNT_BUCKETS ?? "") as number[]; } catch { return null; }
  if (!/^[a-z][a-z0-9-]*$/.test(account) || !/^[A-Za-z0-9_-]{1,32}$/.test(aid)) return null;
  if (!Array.isArray(amountBuckets) || amountBuckets.length === 0 || amountBuckets.length > 32 || amountBuckets.some((v) => !Number.isInteger(v) || v < 100 || v > 5000) || amountBuckets.some((v, i) => i > 0 && v <= amountBuckets[i - 1]!)) return null;
  if (!PrepopBase.safeParse(prepop).success) return null;
  if (!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(formRoute) || reservedRoutes.some((route) => formRoute === route || formRoute.startsWith(`${route}/`)) || !/^\d{4}-\d{2}$/.test(payloadVersion)) return null;
  return { account, aid, prepop_base: prepop.replace(/\/$/, ""), form_route: formRoute, amount_buckets: amountBuckets, payload_version: payloadVersion };
}

async function dispatch(
  env: Env, ctx: AdminRequestContext, installId: string, brandId: string,
  path: "/install" | "/rollback", payload: Record<string, unknown>,
): Promise<Response> {
  if (!env.FACTORY_WORKER) {
    await setFailed(env.FACTORY, installId, "Factory Worker binding is missing");
    await audit(env.FACTORY, ctx, "install.failed", "install", installId, { error: "factory_binding_missing" });
    return json(502, { error: "factory_dispatch_failed", install_id: installId, message: "Factory Worker binding is missing" });
  }
  let response: Response;
  try {
    response = await env.FACTORY_WORKER.fetch(new Request(`https://factory${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
  } catch {
    await setFailed(env.FACTORY, installId, "Factory Worker transport failed");
    await audit(env.FACTORY, ctx, "install.failed", "install", installId, { error: "factory_transport_failed" });
    return json(502, { error: "factory_dispatch_failed", install_id: installId, message: "Factory Worker transport failed" });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : `Factory Worker returned ${response.status}`;
    await setFailed(env.FACTORY, installId, message);
    await audit(env.FACTORY, ctx, "install.failed", "install", installId, { error: message, status: response.status });
    if (response.status >= 500) return json(502, { error: "factory_dispatch_failed", install_id: installId, message });
    return json(response.status, { ...body, install_id: installId });
  }
  await env.FACTORY.prepare("UPDATE installs SET status = 'running' WHERE install_id = ?1 AND status = 'queued'").bind(installId).run();
  return json(201, { install_id: installId, brand_id: brandId, status: "running", workflow: body });
}

export async function createDraft(request: Request, env: Env, ctx: AdminRequestContext): Promise<Response> {
  const parsed = Draft.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
  const { domain, keyword_default, template_version_id, profile } = parsed.data;
  if (profile?.ads && !authorizePanel("setDraftTracking", ctx.actor_role).ok) return forbidden(ctx.actor_role);
  const name = parsed.data.name ?? domain.split(".")[0]!.replaceAll("-", " ");
  if (parsed.data.name === undefined && (!isBrandClean(name) || name.length > 60)) {
    const message = isBrandClean(name) ? "ชื่อแบรนด์ที่สร้างจากโดเมนยาวเกิน 60 ตัวอักษร กรุณาระบุชื่อแบรนด์" : "ชื่อแบรนด์มีคำที่ไม่อนุญาต";
    return json(422, { error: "invalid", issues: [{ code: "custom", path: ["name"], message }] });
  }
  const defaults = tenantDefaults(env);
  if (!defaults) return json(503, { error: "tenant_configuration_missing", message: "Tenant runtime defaults are not configured" });
  const template = await env.FACTORY.prepare("SELECT template_version_id, text_defaults_json FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'")
    .bind(template_version_id).first<{ template_version_id: string; text_defaults_json: string | null }>();
  if (!template) return json(422, { error: "template_not_sealed" });
  const artifact = await env.FACTORY.prepare(`SELECT form_artifact_id, bundle_form_version, payload_version FROM form_artifacts WHERE ${COMPATIBLE_FORM} ORDER BY created_at DESC, form_artifact_id DESC LIMIT 1`).bind(defaults.payload_version).first<{ form_artifact_id: string; bundle_form_version: string; payload_version: string }>();
  if (!artifact) return json(422, { error: "compatible_form_artifact_missing" });
  const existing = await env.FACTORY.prepare("SELECT brand_id FROM brands WHERE domain = ?1").bind(domain).first();
  if (existing) return json(409, { error: "conflict", message: "Domain is already registered" });
  const brandId = `brand_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const revisionId = `${brandId}_rev_1`;
  const now = new Date().toISOString();
  const config = withTextDefaults(JSON.stringify({ keyword_default, ...(profile ? { profile } : {}) }), template.text_defaults_json);
  try { await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'draft',?6,?7,?7)").bind(brandId, name, defaults.account, domain, keyword_default, ctx.actor_id, now),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,1,?3,?4,?5,?6,?7)").bind(revisionId, brandId, template_version_id, artifact.form_artifact_id, config, ctx.actor_id, now),
    env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES (?1,?2,'brand.create','brand',?3,?4,?5)").bind(ctx.actor_id, ctx.actor_role, brandId, JSON.stringify({ domain, name, template_version_id, form_artifact_id: artifact.form_artifact_id }), now),
  ]); } catch (error) {
    if (String(error).toLowerCase().includes("unique") || String(error).toLowerCase().includes("domain")) return json(409, { error: "conflict", message: "Domain is already registered" });
    throw error;
  }
  return json(201, { brand: { brand_id: brandId, name, domain, keyword_default, status: "draft" }, revision: { revision_id: revisionId, revision: 1, template_version_id, form_artifact_id: artifact.form_artifact_id } });
}

// Every statement of the draft edit batch carries this gate, so a draft that an install claimed, or that another edit
// changed, since the read is left untouched. ?1 brand, ?2 revision, ?3 its template version, ?4 its config_json as read.
const DRAFT_EDIT_GATE = `EXISTS (
    SELECT 1 FROM brands b JOIN brand_revisions r ON r.brand_id = b.brand_id
    WHERE b.brand_id = ?1 AND b.status IN ('draft','failed') AND r.revision_id = ?2 AND r.template_version_id = ?3 AND r.config_json = ?4)
  AND NOT EXISTS (SELECT 1 FROM installs WHERE brand_id = ?1 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running'))`;
const PROFILE_GROUPS = ["contact", "disclosures", "copy", "ads"] as const;

/** The profile stored on a revision's config_json. Undefined when absent or not a valid profile. */
export function storedProfile(configJson: string): BrandProfile | undefined {
  try {
    const parsed = BrandProfile.safeParse((JSON.parse(configJson) as { profile?: unknown } | null)?.profile);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

type ActiveOperation = { install_id: string; kind: string; status: string };
const operationActive = (active: ActiveOperation): Response =>
  json(409, { error: "lifecycle_operation_active", active_install_id: active.install_id, active_kind: active.kind, active_status: active.status });

async function updateDraft(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const parsed = UpdateBrandDraftRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
  const body = parsed.data;
  const brand = await env.FACTORY.prepare("SELECT brand_id,name,domain,keyword_default,status FROM brands WHERE brand_id = ?1").bind(brandId)
    .first<{ brand_id: string; name: string; domain: string; keyword_default: string | null; status: string }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  if (brand.status !== "draft" && brand.status !== "failed") return json(409, { error: "conflict", message: "Only draft or failed brands can be edited" });
  const active = await activeLifecycleOperation(env.FACTORY, brandId);
  if (active) return operationActive(active);
  const revision = await env.FACTORY.prepare("SELECT revision_id,revision,template_version_id,form_artifact_id,config_json FROM brand_revisions WHERE brand_id = ?1 ORDER BY revision DESC LIMIT 1").bind(brandId)
    .first<{ revision_id: string; revision: number; template_version_id: string; form_artifact_id: string; config_json: string }>();
  if (!revision) return json(422, { error: "revision_missing" });

  // Only keyword_default, text_defaults and profile are touched in config_json; every other key stays as stored.
  let config = JSON.parse(revision.config_json) as Record<string, unknown>;
  let templateVersionId = revision.template_version_id;
  const templateChanged = body.template_version_id !== undefined && body.template_version_id !== revision.template_version_id;
  if (templateChanged) {
    const template = await env.FACTORY.prepare("SELECT template_version_id, text_defaults_json FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'")
      .bind(body.template_version_id).first<{ template_version_id: string; text_defaults_json: string | null }>();
    if (!template) return json(422, { error: "template_not_sealed" });
    templateVersionId = template.template_version_id;
    config = JSON.parse(withTextDefaults(JSON.stringify(config), template.text_defaults_json)) as Record<string, unknown>;
  }
  if (body.keyword_default !== undefined) config.keyword_default = body.keyword_default;
  const before = storedProfile(revision.config_json);
  if (body.profile !== undefined && JSON.stringify(body.profile.ads ?? null) !== JSON.stringify(before?.ads ?? null) && !authorizePanel("setDraftTracking", ctx.actor_role).ok) return forbidden(ctx.actor_role);
  if (body.profile !== undefined) config.profile = body.profile;

  // Key names only: the audit row never carries the contact or disclosure text itself.
  const changed: string[] = [];
  if (body.name !== undefined && body.name !== brand.name) changed.push("name");
  if (body.keyword_default !== undefined && body.keyword_default !== brand.keyword_default) changed.push("keyword_default");
  if (templateChanged) changed.push("template_version_id");
  if (body.profile !== undefined) {
    for (const group of PROFILE_GROUPS) if (JSON.stringify(body.profile[group] ?? null) !== JSON.stringify(before?.[group] ?? null)) changed.push(`profile.${group}`);
  }

  const name = body.name ?? brand.name;
  const keywordDefault = body.keyword_default ?? brand.keyword_default;
  if (changed.length > 0) {
    const now = new Date().toISOString();
    const gate = [brandId, revision.revision_id, revision.template_version_id, revision.config_json] as const;
    const [claim] = await env.FACTORY.batch([
      env.FACTORY.prepare(`UPDATE brands SET name = ?5, keyword_default = ?6, updated_at = ?7 WHERE brand_id = ?1 AND ${DRAFT_EDIT_GATE}`).bind(...gate, name, keywordDefault, now),
      env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at)
        SELECT ?5,?6,'brand.draft_update','brand',?1,?7,?8 WHERE ${DRAFT_EDIT_GATE}`).bind(...gate, ctx.actor_id, ctx.actor_role, JSON.stringify({ changed }), now),
      env.FACTORY.prepare(`UPDATE brand_revisions SET template_version_id = ?5, config_json = ?6 WHERE revision_id = ?2 AND ${DRAFT_EDIT_GATE}`).bind(...gate, templateVersionId, JSON.stringify(config)),
    ]);
    if (claim!.meta.changes !== 1) {
      const raced = await activeLifecycleOperation(env.FACTORY, brandId);
      if (raced) return operationActive(raced);
      return json(409, { error: "conflict", message: "The draft changed or was installed while saving; reload and try again" });
    }
  }
  const profile = storedProfile(JSON.stringify(config));
  return json(200, {
    brand: { brand_id: brand.brand_id, name, domain: brand.domain, keyword_default: keywordDefault, status: brand.status },
    revision: { revision_id: revision.revision_id, revision: revision.revision, template_version_id: templateVersionId, form_artifact_id: revision.form_artifact_id },
    ...(profile ? { profile } : {}),
    changed,
  } satisfies UpdateBrandDraftResponse);
}

async function startInstall(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT brand_id,status,current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first<{ brand_id: string; status: string; current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  if (brand.status !== "draft" && brand.status !== "failed") return json(409, { error: "conflict", message: "Only draft or failed brands can be installed" });
  const body = await request.json().catch(() => ({})) as { revision_id?: string };
  const revision = await env.FACTORY.prepare("SELECT revision_id FROM brand_revisions WHERE revision_id = ?1 AND brand_id = ?2").bind(body.revision_id ?? `${brandId}_rev_1`, brandId).first<{ revision_id: string }>();
  if (!revision) return json(422, { error: "revision_missing" });
  const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = new Date().toISOString();
  const claim = await env.FACTORY.prepare(`INSERT INTO installs
    (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at)
    SELECT ?1,?2,'install','queued',?3,?4,?5,?6,?7
    WHERE EXISTS (SELECT 1 FROM brands WHERE brand_id = ?2 AND status IN ('draft','failed'))
    AND NOT EXISTS (
      SELECT 1 FROM installs
      WHERE brand_id = ?2 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running')
    )`).bind(installId, brandId, brand.current_revision_id, revision.revision_id, ctx.actor_id, ctx.actor_role, now).run();
  if (claim.meta.changes !== 1) {
    const active = await activeLifecycleOperation(env.FACTORY, brandId);
    if (active) return json(409, { error: "lifecycle_operation_active", active_install_id: active.install_id, active_kind: active.kind, active_status: active.status });
    return json(409, { error: "lifecycle_operation_active", message: "Lifecycle operation claim was not admitted" });
  }
  await audit(env.FACTORY, ctx, "install.start", "install", installId, { brand_id: brandId, revision_id: revision.revision_id });
  return dispatch(env, ctx, installId, brandId, "/install", { install_id: installId, brand_id: brandId, revision_id: revision.revision_id, started_by: ctx.actor_id, started_role: ctx.actor_role });
}

async function rollback(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first<{ current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  let target: string | null = null;
  if (brand.current_revision_id) {
    const previous = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE brand_id = ?1 AND kind IN ('install','upgrade','rollback') AND status = 'ready' AND to_revision_id IS NOT ?2 ORDER BY finished_at DESC LIMIT 1").bind(brandId, brand.current_revision_id).first<{ to_revision_id: string | null }>();
    target = previous?.to_revision_id ?? null;
  }
  const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = new Date().toISOString();
  const claim = await env.FACTORY.prepare(`INSERT INTO installs
    (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at)
    SELECT ?1,?2,'rollback','queued',?3,?4,?5,?6,?7
    WHERE NOT EXISTS (
      SELECT 1 FROM installs
      WHERE brand_id = ?2 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running')
    )`).bind(installId, brandId, brand.current_revision_id, target, ctx.actor_id, ctx.actor_role, now).run();
  if (claim.meta.changes !== 1) {
    const active = await activeLifecycleOperation(env.FACTORY, brandId);
    if (active) return json(409, { error: "lifecycle_operation_active", active_install_id: active.install_id, active_kind: active.kind, active_status: active.status });
    return json(409, { error: "lifecycle_operation_active", message: "Lifecycle operation claim was not admitted" });
  }
  await audit(env.FACTORY, ctx, "install.start", "install", installId, { brand_id: brandId, kind: "rollback", to_revision_id: target });
  return dispatch(env, ctx, installId, brandId, "/rollback", { install_id: installId, brand_id: brandId, to_revision_id: target, started_by: ctx.actor_id, started_role: ctx.actor_role });
}

// installs.kind has no redeploy value, so a redeploy is an 'upgrade' row. It is told apart by its revision id,
// `<brand_id>_redeploy_<install_id>`, which the redeploy route writes. A retry copies to_revision_id, so a retried
// redeploy keeps the id; the redeploy.start audit row would not survive that, because a retry audits install.start.
// Only an upgrade row counts: a later install of the redeployed revision is kind 'install'.
export function installOperation(kind: string, brandId: string, toRevisionId: string | null): InstallOperation {
  if (kind === "upgrade" && toRevisionId?.startsWith(`${brandId}_redeploy_`)) return "redeploy";
  return kind === "rollback" || kind === "upgrade" ? kind : "install";
}

// A live brand re-installs at its current template version and form artifact. It is an upgrade-kind
// install (from_revision_id set, so smoke, sync_runtime and compensation all apply) onto a copy of the
// current revision, which lets the existing Workflow upload the current runtime bundle again.
// With form_artifact_id the copy carries that artifact instead, so the brand moves to a newer registered form;
// the install Workflow stays the authority on it (validateInstallInputs) and a rollback returns to the old revision.
// With template_version_id the copy carries that sealed template version and its text defaults (withTextDefaults, as upgrade-all does),
// so the owner moves one live brand to another template through the same install Workflow, rollback included.
async function redeploy(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT status,current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first<{ status: string; current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  if (brand.status !== "live" || !brand.current_revision_id) return json(409, { error: "conflict", message: "Only live brands can be redeployed" });
  const parsed = Redeploy.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
  const formArtifactId = parsed.data.form_artifact_id ?? null;
  if (formArtifactId) {
    const defaults = tenantDefaults(env);
    if (!defaults) return json(503, { error: "tenant_configuration_missing", message: "Tenant runtime defaults are not configured" });
    const artifact = await env.FACTORY.prepare(`SELECT (${COMPATIBLE_FORM}) AS compatible FROM form_artifacts WHERE form_artifact_id = ?2`).bind(defaults.payload_version, formArtifactId).first<{ compatible: number | null }>();
    if (!artifact) return json(422, { error: "form_artifact_not_found" });
    if (!artifact.compatible) return json(422, { error: "form_artifact_incompatible", message: "Form artifact does not match the tenant payload version" });
  }
  const templateVersionId = parsed.data.template_version_id ?? null;
  // The new config is computed from the config read here; the insert below is gated on that config still being current,
  // so a profile edit that lands in between is refused instead of lost.
  let newConfig: string | null = null;
  let readConfig: string | null = null;
  if (templateVersionId) {
    const template = await env.FACTORY.prepare("SELECT template_version_id, text_defaults_json FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'")
      .bind(templateVersionId).first<{ template_version_id: string; text_defaults_json: string | null }>();
    if (!template) return json(422, { error: "template_not_sealed" });
    const current = await env.FACTORY.prepare("SELECT r.template_version_id, r.config_json FROM brand_revisions r WHERE r.revision_id = ?1")
      .bind(brand.current_revision_id).first<{ template_version_id: string; config_json: string }>();
    if (!current) return json(422, { error: "revision_missing" });
    if (current.template_version_id === templateVersionId) return json(422, { error: "template_unchanged", message: "The brand already runs this template version" });
    readConfig = current.config_json;
    newConfig = withTextDefaults(current.config_json, template.text_defaults_json);
  }
  const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const revisionId = `${brandId}_redeploy_${installId}`;
  const now = new Date().toISOString();
  // One batch: the revision is admitted only when no lifecycle operation is active, and the install only when
  // that revision exists, so a refused request leaves neither row and a double click claims one install.
  const [revisionClaim, installClaim] = await env.FACTORY.batch([
    env.FACTORY.prepare(`INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at)
      SELECT ?1,?2,(SELECT MAX(revision) + 1 FROM brand_revisions WHERE brand_id = ?2),COALESCE(?6,r.template_version_id),COALESCE(?5,r.form_artifact_id),COALESCE(?7,r.config_json),?3,?4
      FROM brands b JOIN brand_revisions r ON r.revision_id = b.current_revision_id
      WHERE b.brand_id = ?2 AND b.status = 'live'
      AND (?8 IS NULL OR r.config_json = ?8)
      AND NOT EXISTS (
        SELECT 1 FROM installs
        WHERE brand_id = ?2 AND kind IN ('install','rollback','upgrade') AND status IN ('queued','running')
      )`).bind(revisionId, brandId, ctx.actor_id, now, formArtifactId, templateVersionId, newConfig, readConfig),
    env.FACTORY.prepare(`INSERT INTO installs
      (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at)
      SELECT ?1,?2,'upgrade','queued',b.current_revision_id,?3,?4,?5,?6
      FROM brands b WHERE b.brand_id = ?2 AND EXISTS (SELECT 1 FROM brand_revisions WHERE revision_id = ?3)`)
      .bind(installId, brandId, revisionId, ctx.actor_id, ctx.actor_role, now),
  ]);
  if (revisionClaim!.meta.changes !== 1 || installClaim!.meta.changes !== 1) {
    const active = await activeLifecycleOperation(env.FACTORY, brandId);
    if (active) return json(409, { error: "lifecycle_operation_active", active_install_id: active.install_id, active_kind: active.kind, active_status: active.status });
    if (readConfig !== null) return json(409, { error: "conflict", message: "The brand changed while the template was being chosen; reload and try again" });
    return json(409, { error: "lifecycle_operation_active", message: "Lifecycle operation claim was not admitted" });
  }
  await audit(env.FACTORY, ctx, "redeploy.start", "install", installId, { brand_id: brandId, from_revision_id: brand.current_revision_id, revision_id: revisionId, ...(formArtifactId ? { form_artifact_id: formArtifactId } : {}), ...(templateVersionId ? { template_version_id: templateVersionId } : {}) });
  return dispatch(env, ctx, installId, brandId, "/install", { install_id: installId, brand_id: brandId, revision_id: revisionId, started_by: ctx.actor_id, started_role: ctx.actor_role });
}

async function recover(env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  if (!env.FACTORY_WORKER) return json(502, { error: "factory_dispatch_failed" });
  try {
    const response = await env.FACTORY_WORKER.fetch(new Request("https://factory/recover", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ brand_id: brandId, started_by: ctx.actor_id, started_role: ctx.actor_role }),
    }));
    return json(response.status, await response.json());
  } catch {
    return json(502, { error: "factory_dispatch_failed", message: "Recovery dispatch could not be confirmed; refresh before retrying" });
  }
}

async function artifactRoute(request: Request, env: Env, ctx: AdminRequestContext, path: string): Promise<Response> {
  if (ctx.actor_role !== "owner") return forbidden(ctx.actor_role);
  if (path === "/api/form-artifacts") {
    const parsed = Artifact.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
    try {
      await env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(parsed.data.form_artifact_id, parsed.data.git_sha, `forms/${parsed.data.form_artifact_id}`, parsed.data.manifest_sha256 ?? "registered", parsed.data.payload_version, parsed.data.bundle_form_version, new Date().toISOString()).run();
    } catch { return json(409, { error: "conflict" }); }
    await audit(env.FACTORY, ctx, "form_artifact.register", "form_artifact", parsed.data.form_artifact_id, { template_version_id: parsed.data.template_version_id, payload_version: parsed.data.payload_version });
    return json(201, { form_artifact: parsed.data });
  }
  const m = path.match(/^\/api\/form-artifacts\/([^/]+)\/backfill$/);
  if (!m) return undefined as unknown as Response;
  const parsed = BackfillPayloadVersionRequest.safeParse({ form_artifact_id: m[1], ...(await request.json().catch(() => null) as object) });
  if (!parsed.success || parsed.data.payload_version !== "2026-01") return json(422, { error: "invalid", issues: parsed.success ? [] : parsed.error.issues });
  const row = await env.FACTORY.prepare("SELECT payload_version FROM form_artifacts WHERE form_artifact_id = ?1").bind(parsed.data.form_artifact_id).first<{ payload_version: string | null }>();
  if (!row) return json(404, { error: "not_found", resource: "form_artifact" });
  if (row.payload_version !== null) return json(409, { error: "conflict", message: "payload_version is already set" });
  const timestamp = new Date().toISOString();
  const update = await env.FACTORY.batch([
    env.FACTORY.prepare("UPDATE form_artifacts SET payload_version = ?1 WHERE form_artifact_id = ?2 AND payload_version IS NULL").bind(parsed.data.payload_version, parsed.data.form_artifact_id),
    env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at)
      SELECT ?1,?2,'form_artifact.backfill','form_artifact',?3,?4,?5
      WHERE EXISTS (SELECT 1 FROM form_artifacts WHERE form_artifact_id=?3 AND payload_version=?6)
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action='form_artifact.backfill' AND entity_id=?3)`).bind(ctx.actor_id, ctx.actor_role, parsed.data.form_artifact_id, JSON.stringify({ payload_version: parsed.data.payload_version }), timestamp, parsed.data.payload_version),
  ]);
  if (update[0]?.meta.changes !== 1) return json(409, { error: "conflict", message: "payload_version is already set" });
  return json(200, { form_artifact_id: parsed.data.form_artifact_id, payload_version: parsed.data.payload_version });
}

async function checklist(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const body = await request.json().catch(() => null) as { item?: string; lead_id?: string } | null;
  const item = body?.item;
  if (!["drain_route", "leadsgate_postbacks", "test_sold", "final_url"].includes(item ?? "")) return json(422, { error: "invalid_checklist_item" });
  const existing = await env.FACTORY.prepare("SELECT evidence_json FROM brand_checklist WHERE brand_id = ?1 AND item = ?2").bind(brandId, item).first<{ evidence_json: string }>();
  if (existing) return json(200, { brand_id: brandId, item, evidence: JSON.parse(existing.evidence_json), idempotent: true });
  let evidence: Record<string, unknown> = { brand_id: brandId, item, actor_id: ctx.actor_id, verified_at: new Date().toISOString() };
  if (item === "test_sold") {
    if (!env.CORE_LIFECYCLE || !body?.lead_id) return json(422, { error: "test_sold_verification_required" });
    let response: Response;
    try { response = await env.CORE_LIFECYCLE.fetch(new Request("https://core/lifecycle/test-sold", { method: "POST", headers: adminContextToHeaders(ctx), body: JSON.stringify({ brand_id: brandId, lead_id: body.lead_id }) })); }
    catch { return json(502, { error: "test_sold_verification_failed", message: "Core lifecycle service is unavailable; no checklist evidence was recorded" }); }
    const parsed = VerifySoldLeadResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) return json(response.status || 502, { error: "test_sold_not_verified" });
    evidence = { ...evidence, event_id: parsed.data.event_id };
  }
  const evidenceJson = JSON.stringify(evidence);
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO brand_checklist (brand_id,item,evidence_json,confirmed_by,confirmed_role,confirmed_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(brandId, item, evidenceJson, ctx.actor_id, ctx.actor_role, evidence.verified_at),
    env.FACTORY.prepare(`INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at)
      SELECT ?1,?2,'checklist.attest','brand',?3,?4,?5
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action='checklist.attest' AND entity_id=?3
        AND after_json = ?4)`).bind(ctx.actor_id, ctx.actor_role, brandId, JSON.stringify({ item }), evidence.verified_at),
  ]);
  const winner = await env.FACTORY.prepare("SELECT evidence_json FROM brand_checklist WHERE brand_id = ?1 AND item = ?2").bind(brandId, item).first<{ evidence_json: string }>();
  if (winner && winner.evidence_json !== JSON.stringify(evidence)) return json(200, { brand_id: brandId, item, evidence: JSON.parse(winner.evidence_json), idempotent: true });
  return json(200, { brand_id: brandId, item, evidence });
}

const GLOBAL_POSTBACK_ACTOR = "system:global-postback";

/** The brand as core stores it, for the computed checklist rows. Null when core fails. */
async function coreBrand(env: Env, ctx: AdminRequestContext, brandId: string): Promise<BrandConfig | null> {
  if (!BrandId.safeParse(brandId).success) return null;
  try {
    const result = await callCore(env, ctx, { endpoint: "getBrand", params: { id: brandId } });
    return result.status === 200 ? (result.body as GetBrandResponse).brand : null;
  } catch { return null; }
}

/** The tenant postback token covers a brand with no token of its own, so LeadsGate needs no entry for it. Computed per read, never stored. */
function globalPostbackRow(brand: BrandConfig, brandId: string): Record<string, unknown> | null {
  if (brand.postback_token !== "global") return null;
  const at = new Date().toISOString();
  return {
    item: "leadsgate_postbacks",
    evidence: { brand_id: brandId, item: "leadsgate_postbacks", actor_id: GLOBAL_POSTBACK_ACTOR, verified_at: at },
    confirmed_by: GLOBAL_POSTBACK_ACTOR, confirmed_role: "system", confirmed_at: at,
  };
}

type FactoryBrandRow = Record<string, unknown> & { brand_id: string; account: string; current_revision_id: string | null };

class CoreListFailure extends Error {
  constructor(readonly code: CoreListErrorCode, message: string) {
    super(message);
  }
}

async function runtimeBrands(env: Env, ctx: AdminRequestContext, account: string): Promise<Map<string, { hostnames: string[]; applied_revision_id: string | null; paused: boolean; bundle_form_version: string | null }>> {
  if (!env.CORE_LIFECYCLE) throw new CoreListFailure("core_binding_missing", "Core lifecycle binding is missing");
  let response: Response;
  try {
    response = await env.CORE_LIFECYCLE.fetch(new Request("https://core/lifecycle/runtime-list", {
      method: "POST", headers: { ...adminContextToHeaders(ctx), "content-type": "application/json", "x-lifecycle-account": account },
      body: JSON.stringify({ account }),
    }));
  } catch { throw new CoreListFailure("core_list_fetch_failed", "Core brand list fetch failed"); }
  if (!response.ok) throw new CoreListFailure("core_list_fetch_failed", "Core brand list fetch failed");
  const parsed = RuntimeListResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new CoreListFailure("core_list_response_invalid", "Core brand list response is invalid");
  return new Map(parsed.data.brands.map((brand) => [brand.brand_id, brand]));
}

type NewestForm = { form_artifact_id: string; bundle_form_version: string; created_at: string };

function withRuntimeState(row: FactoryBrandRow, runtime: ReturnType<typeof runtimeBrands> extends Promise<infer M> ? M : never, newest: NewestForm | null): LifecycleBrandSummary {
  const state = runtime.get(row.brand_id);
  return LifecycleBrandSummary.parse({
    brand_id: row.brand_id, name: typeof row.name === "string" && row.name ? row.name : undefined, account: row.account,
    hostnames: state?.hostnames ?? (String(row.domain).split(".").length === 2 ? [row.domain, `www.${row.domain}`] : [row.domain]), status: row.status,
    current_revision_id: row.current_revision_id,
    bundle_form_version: state?.bundle_form_version ?? row.bundle_form_version ?? null,
    payload_version: row.payload_version ?? null,
    newer_form: newest && newest.form_artifact_id !== row.form_artifact_id && (typeof row.form_created_at !== "string" || newest.created_at > row.form_created_at)
      ? { form_artifact_id: newest.form_artifact_id, bundle_form_version: newest.bundle_form_version } : undefined,
    runtime_sync_status: state ? (state.applied_revision_id === row.current_revision_id ? "ready" : "sync_error") : row.status === "draft" ? "queued" : "sync_error",
  });
}

async function lifecycleBrandRows(env: Env, ctx: AdminRequestContext): Promise<{ brands: LifecycleBrandSummary[]; core_error: CoreListError | null }> {
  const { results } = await env.FACTORY.prepare("SELECT b.brand_id,b.name,b.account,b.domain,b.keyword_default,b.status,b.current_revision_id,r.template_version_id,r.form_artifact_id,fa.bundle_form_version,fa.payload_version,fa.created_at AS form_created_at FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=COALESCE(b.current_revision_id, (SELECT revision_id FROM brand_revisions WHERE brand_id = b.brand_id ORDER BY revision DESC LIMIT 1)) LEFT JOIN form_artifacts fa ON fa.form_artifact_id=r.form_artifact_id ORDER BY b.created_at DESC").all<FactoryBrandRow>();
  const defaults = tenantDefaults(env);
  const newest = defaults ? await env.FACTORY.prepare(`SELECT form_artifact_id, bundle_form_version, created_at FROM form_artifacts WHERE ${COMPATIBLE_FORM} ORDER BY created_at DESC, form_artifact_id DESC LIMIT 1`).bind(defaults.payload_version).first<NewestForm>() : null;
  const account = env.DEFAULT_ACCOUNT ?? results[0]?.account;
  let runtime: Awaited<ReturnType<typeof runtimeBrands>> = new Map();
  let coreError: CoreListError | null = null;
  try {
    if (account) runtime = await runtimeBrands(env, ctx, account);
    else coreError = { code: "core_list_account_missing", message: "Core brand list account is not configured" };
  } catch (error) {
    coreError = error instanceof CoreListFailure
      ? { code: error.code, message: error.message }
      : { code: "core_list_fetch_failed", message: "Core brand list fetch failed" };
  }
  const factoryIds = new Set(results.map((row) => row.brand_id));
  const merged = results.map((row) => withRuntimeState(row, runtime, newest));
  for (const [brandId, state] of runtime) if (!factoryIds.has(brandId)) merged.push(LifecycleBrandSummary.parse({ brand_id: brandId, account, status: "unmanaged", current_revision_id: null, bundle_form_version: state.bundle_form_version, payload_version: null, hostnames: state.hostnames, runtime_sync_status: "ready" }));
  return { brands: merged, core_error: coreError };
}

export function decodePathSegment(raw: string): string | null {
  try { return decodeURIComponent(raw); } catch (error) { if (error instanceof URIError) return null; throw error; }
}

export async function handleLifecycleRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const method = request.method;
  let m: RegExpMatchArray | null;
  if (path === "/api/templates/sealed" && method === "GET") {
    const g = authorizePanel("createBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const { results } = await env.FACTORY.prepare("SELECT v.template_version_id,t.name,v.version,v.status FROM template_versions v JOIN templates t ON t.template_id=v.template_id WHERE v.status='sealed' ORDER BY t.name,v.version DESC,v.template_version_id").all();
    return json(200, SealedTemplatesResponse.parse({ templates: results }));
  }
  if (/^\/api\/brands\/[^/]+$/.test(path) && method === "DELETE") {
    const g = authorizePanel("deleteBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    return json(501, { error: "not_implemented" });
  }
  if (path === "/api/form-artifacts" && method === "POST") return artifactRoute(request, env, ctx, path);
  if (path.startsWith("/api/form-artifacts/") && method === "POST") return artifactRoute(request, env, ctx, path);
  if (path === "/api/brands/drafts" && method === "POST") {
    const g = authorizePanel("createBrand", ctx.actor_role); return g.ok ? createDraft(request, env, ctx) : forbidden(ctx.actor_role);
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/draft$/);
  if (m && method === "PATCH") {
    const g = authorizePanel("createBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const brandId = decodePathSegment(m[1]!); if (brandId === null) return json(400, { error: "invalid_brand_id" });
    return updateDraft(request, env, ctx, brandId);
  }
  if ((path === "/api/lifecycle/brands" || path === "/api/brands/lifecycle") && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    return json(200, await lifecycleBrandRows(env, ctx));
  }
  m = path.match(/^\/api\/lifecycle\/brands\/([^/]+)$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const result = await lifecycleBrandRows(env, ctx);
    const row = result.brands.find((candidate) => candidate.brand_id === m![1]);
    if (row) {
      const latest = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1 ORDER BY revision DESC LIMIT 1").bind(row.brand_id).first<{ config_json: string }>();
      const profile = latest ? storedProfile(latest.config_json) : undefined;
      return json(200, { brand: profile ? { ...row, profile } : row, core_error: result.core_error });
    }
    return result.core_error
      ? json(502, { error: "core_list_failed", code: result.core_error.code, message: result.core_error.message })
      : json(404, { error: "not_found", resource: "brand" });
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/generate$/);
  if (m && method === "POST") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const brandId = decodePathSegment(m[1]!); if (brandId === null) return json(400, { error: "invalid_brand_id" });
    return generateBrand(request, env, ctx, brandId, startInstall);
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/(install|rollback|recover|redeploy|checklist)$/);
  if (m && method === "POST") {
    const brandId = decodePathSegment(m[1]!);
    if (brandId === null) return json(400, { error: "invalid_brand_id" });
    if (m[2] === "checklist") {
      const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
      return checklist(request, env, ctx, brandId);
    }
    const g = authorizePanel(m[2] === "install" ? "installBrand" : m[2] === "recover" ? "recoverBrand" : m[2] === "redeploy" ? "redeployBrand" : "rollbackBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    if (m[2] === "recover") return recover(env, ctx, brandId);
    if (m[2] === "redeploy") return redeploy(request, env, ctx, brandId);
    return m[2] === "install" ? startInstall(request, env, ctx, brandId) : rollback(request, env, ctx, brandId);
  }
  m = path.match(/^\/api\/installs\/([^/]+)\/retry$/);
  if (m && method === "POST") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const row = await env.FACTORY.prepare("SELECT install_id,brand_id,kind,from_revision_id,to_revision_id,started_by,started_role,status FROM installs WHERE install_id = ?1").bind(m[1]).first<{ install_id: string; brand_id: string; kind: string; from_revision_id: string | null; to_revision_id: string | null; started_by: string; started_role: AdminRole; status: string }>();
    if (!row) return json(404, { error: "not_found", resource: "install" });
    if (row.status !== "failed") return json(409, { error: "conflict", message: "Only failed installs can be retried" });
    const recovery = await env.FACTORY.prepare(`SELECT 1 AS found FROM installs WHERE install_id=? AND (
      (CASE WHEN json_valid(error) THEN json_extract(error,'$.recovery_required')=1 ELSE 0 END)
      OR (CASE WHEN json_valid(rollback_record_json) THEN json_extract(rollback_record_json,'$.recovery_of') IS NOT NULL ELSE 0 END)
    )`).bind(row.install_id).first();
    if (recovery) {
      if (!authorizePanel("recoverBrand", ctx.actor_role).ok) return forbidden(ctx.actor_role);
      return json(409, { error: "recovery_required", message: "Use Recover to retry failed compensation" });
    }
    // A retry re-runs the original command, so it needs the role that command required (e.g. upgrade-all is owner-only).
    const kindAction = row.kind === "upgrade" ? "upgradeAll" : row.kind === "rollback" ? "rollbackBrand" : "installBrand";
    if (!authorizePanel(kindAction, ctx.actor_role).ok) return forbidden(ctx.actor_role);
    const active = await activeLifecycleOperation(env.FACTORY, row.brand_id);
    if (active) return json(409, { error: "conflict", message: `Brand already has an active ${active.kind} (${active.install_id})` });
    // The atomic claim also checks the brand lock: failure is persisted before
    // compensation is queued, so an active-install query alone misses that gap.
    const installId = await queueInstallRetry(env.FACTORY, row.install_id, ctx);
    if (!installId) return json(409, { error: "conflict", message: "Compensation or another lifecycle operation is unfinished, this attempt was already retried, or the brand revision changed" });
    const payload = row.kind === "rollback"
      ? { install_id: installId, brand_id: row.brand_id, to_revision_id: row.to_revision_id, started_by: row.started_by, started_role: row.started_role }
      : { install_id: installId, brand_id: row.brand_id, revision_id: row.to_revision_id, started_by: row.started_by, started_role: row.started_role };
    return dispatch(env, ctx, installId, row.brand_id, row.kind === "rollback" ? "/rollback" : "/install", payload);
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/installs$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const brandId = decodePathSegment(m[1]!); if (brandId === null) return json(400, { error: "invalid_brand_id" });
    const { results } = await env.FACTORY.prepare("SELECT install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at,finished_at,error FROM installs WHERE brand_id=?1 ORDER BY started_at DESC LIMIT 50").bind(brandId).all<{ kind: string; to_revision_id: string | null }>();
    return json(200, { brand_id: brandId, installs: results.map((row) => ({ ...row, operation: installOperation(row.kind, brandId, row.to_revision_id) })) });
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/checklist$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const brandId = decodePathSegment(m[1]!); if (brandId === null) return json(400, { error: "invalid_brand_id" });
    const { results } = await env.FACTORY.prepare("SELECT item,evidence_json,confirmed_by,confirmed_role,confirmed_at FROM brand_checklist WHERE brand_id=?1 ORDER BY item").bind(brandId).all();
    const rows: Array<Record<string, unknown>> = results.map((r) => ({ ...r, evidence: JSON.parse(r.evidence_json as string), evidence_json: undefined }));
    const open = (item: string) => !rows.some((r) => r.item === item);
    const finalUrl = open("final_url") ? await smokeFinalUrlRow(env.FACTORY, brandId) : null;
    if (finalUrl) rows.push(finalUrl);
    // One getBrand read serves every computed row; a stored attestation always wins.
    const brand = open("leadsgate_postbacks") || open("drain_route") ? await coreBrand(env, ctx, brandId) : null;
    if (brand) {
      const computed = [
        open("leadsgate_postbacks") ? globalPostbackRow(brand, brandId) : null,
        open("drain_route") ? drainRouteRow(brand) : null,
      ].filter((row): row is Record<string, unknown> => row !== null);
      rows.push(...computed);
    }
    rows.sort((a, b) => (String(a.item) < String(b.item) ? -1 : String(a.item) > String(b.item) ? 1 : 0));
    return json(200, { brand_id: brandId, checklist: rows });
  }
  m = path.match(/^\/api\/installs\/([^/]+)$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    // SQLite may evaluate both sides of AND. CASE keeps plain-text errors out of json_extract.
    const row = await env.FACTORY.prepare(`SELECT i.install_id,i.brand_id,i.kind,i.to_revision_id,i.status,
      (CASE WHEN json_valid(i.error) THEN COALESCE(json_extract(i.error,'$.recovery_required')=1,0) ELSE 0 END
       OR CASE WHEN json_valid(i.rollback_record_json) THEN json_extract(i.rollback_record_json,'$.recovery_of') IS NOT NULL ELSE 0 END) AS recovery_required
      FROM installs i WHERE i.install_id=?1`).bind(m[1]).first<{ install_id: string; brand_id: string; kind: string; to_revision_id: string | null; status: string; recovery_required: number }>();
    if (!row) return json(404, { error: "not_found", resource: "install" });
    const { results } = await env.FACTORY.prepare("SELECT step,status,output_json FROM install_receipts WHERE install_id=?1 ORDER BY id").bind(m[1]).all<{ step: string; status: string; output_json: string | null }>();
    const status = (value: string): "queued" | "running" | "ready" | "failed" => value === "ok" ? "ready" : value === "skipped" ? "queued" : value === "failed" ? "failed" : value === "running" ? "running" : "queued";
    const receipts = results.map((r) => { const output = r.output_json ? JSON.parse(r.output_json) as Record<string, unknown> : undefined; return { step: r.step, status: status(r.status), ...(typeof output?.error === "string" ? { error: output.error } : {}), ...(typeof output?.warning === "string" ? { warning: output.warning.slice(0, 500) } : {}) }; });
    const runtime_sync_status = receipts.some((r) => r.status === "failed") || row.status === "failed" ? "failed" : receipts.some((r) => r.status === "running") || row.status === "running" ? "running" : row.status === "ready" || row.status === "rolled_back" ? "ready" : "queued";
    const installStatus = ["queued", "running", "ready", "failed", "rolled_back"].includes(row.status) ? row.status : "queued";
    return json(200, { install_id: row.install_id, brand_id: row.brand_id, revision_id: row.to_revision_id, operation: installOperation(row.kind, row.brand_id, row.to_revision_id), status: installStatus, runtime_sync_status, receipts, recovery_required: row.recovery_required === 1 });
  }
  if (path === "/api/upgrade-all/latest" && method === "GET") {
    const g = authorizePanel("upgradeAll", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    return json(200, await latestUpgrade(env.FACTORY));
  }
  if (path === "/api/upgrade-all" && method === "POST") {
    const g = authorizePanel("upgradeAll", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const parsed = Upgrade.safeParse(await request.json().catch(() => null)); if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
    const auditId = `${ctx.actor_id}:${parsed.data.canary_brand_id}`;
    if (!env.FACTORY_WORKER) { await audit(env.FACTORY, ctx, "upgrade.failed", "upgrade", auditId, { error: "factory_binding_missing", ...parsed.data }); return json(502, { error: "factory_dispatch_failed", message: "Factory Worker binding is missing" }); }
    const payload = { ...parsed.data, started_by: ctx.actor_id, started_role: "owner" as const };
    try {
      const response = await env.FACTORY_WORKER.fetch(new Request("https://factory/upgrade-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { await audit(env.FACTORY, ctx, "upgrade.failed", "upgrade", auditId, { status: response.status, ...parsed.data }); return json(response.status >= 500 ? 502 : response.status, body); }
      await audit(env.FACTORY, ctx, "upgrade.start", "upgrade", auditId, { ...parsed.data, started_role: "owner" });
      return json(response.status, body);
    } catch { await audit(env.FACTORY, ctx, "upgrade.failed", "upgrade", auditId, { error: "factory_transport_failed", ...parsed.data }); return json(502, { error: "factory_dispatch_failed" }); }
  }
  void url;
  return undefined;
}
