import {
  AdminRole,
  BackfillPayloadVersionRequest,
  VerifySoldLeadResponse,
  adminContextToHeaders,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { z } from "zod";
import type { Env } from "./env.js";
import { writeFactoryAudit } from "./audit.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const Id = z.string().min(1).max(128);
const Artifact = z.strictObject({
  form_artifact_id: Id, template_version_id: Id,
  git_sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  bundle_form_version: z.string().regex(/^form@[A-Za-z0-9._-]+$/),
  payload_version: z.literal("2026-01"),
});
const Draft = z.strictObject({
  domain: z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}$/),
  keyword_default: z.string().min(1).max(60), template_version_id: Id,
});
const Upgrade = z.strictObject({
  from_template_version_id: Id, to_template_version_id: Id, form_artifact_id: Id,
  canary_brand_id: Id,
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

async function createDraft(request: Request, env: Env, ctx: AdminRequestContext): Promise<Response> {
  const parsed = Draft.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
  const { domain, keyword_default, template_version_id } = parsed.data;
  const template = await env.FACTORY.prepare("SELECT template_version_id FROM template_versions WHERE template_version_id = ?1 AND status = 'sealed'").bind(template_version_id).first();
  if (!template) return json(422, { error: "template_not_sealed" });
  const artifact = await env.FACTORY.prepare("SELECT form_artifact_id, bundle_form_version, payload_version FROM form_artifacts WHERE payload_version = '2026-01' AND bundle_form_version GLOB 'form@*' ORDER BY created_at DESC LIMIT 1").first<{ form_artifact_id: string; bundle_form_version: string; payload_version: string }>();
  if (!artifact) return json(422, { error: "compatible_form_artifact_missing" });
  const existing = await env.FACTORY.prepare("SELECT brand_id FROM brands WHERE domain = ?1").bind(domain).first();
  if (existing) return json(409, { error: "conflict", message: "Domain is already registered" });
  const brandId = `brand_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const revisionId = `${brandId}_rev_1`;
  const now = new Date().toISOString();
  const config = JSON.stringify({ amount_buckets: [500, 1000, 1500, 2500, 3000], aid: env.DEFAULT_AID ?? "30003", prepop_base: env.DEFAULT_PREPOP_BASE ?? "https://prepop.invalid", form_route: "/apply", keyword_default, form_version: artifact.bundle_form_version });
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT INTO brands (brand_id,name,account,domain,keyword_default,status,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'draft',?6,?7,?7)").bind(brandId, domain.split(".")[0]!.replaceAll("-", " "), env.DEFAULT_ACCOUNT ?? "default", domain, keyword_default, ctx.actor_id, now),
    env.FACTORY.prepare("INSERT INTO brand_revisions (revision_id,brand_id,revision,template_version_id,form_artifact_id,config_json,created_by,created_at) VALUES (?1,?2,1,?3,?4,?5,?6,?7)").bind(revisionId, brandId, template_version_id, artifact.form_artifact_id, config, ctx.actor_id, now),
    env.FACTORY.prepare("INSERT INTO audit_log (actor_id,actor_role,action,entity_type,entity_id,after_json,created_at) VALUES (?1,?2,'brand.create','brand',?3,?4,?5)").bind(ctx.actor_id, ctx.actor_role, brandId, JSON.stringify({ domain, template_version_id, form_artifact_id: artifact.form_artifact_id }), now),
  ]);
  return json(201, { brand: { brand_id: brandId, name: domain.split(".")[0], domain, keyword_default, status: "draft" }, revision: { revision_id: revisionId, revision: 1, template_version_id, form_artifact_id: artifact.form_artifact_id } });
}

async function startInstall(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT brand_id,status,current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first<{ brand_id: string; status: string; current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  const body = await request.json().catch(() => ({})) as { revision_id?: string };
  const revision = await env.FACTORY.prepare("SELECT revision_id FROM brand_revisions WHERE revision_id = ?1 AND brand_id = ?2").bind(body.revision_id ?? `${brandId}_rev_1`, brandId).first<{ revision_id: string }>();
  if (!revision) return json(422, { error: "revision_missing" });
  const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = new Date().toISOString();
  await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at) VALUES (?1,?2,'install','queued',?3,?4,?5,?6,?7)").bind(installId, brandId, brand.current_revision_id, revision.revision_id, ctx.actor_id, ctx.actor_role, now).run();
  await audit(env.FACTORY, ctx, "install.start", "install", installId, { brand_id: brandId, revision_id: revision.revision_id });
  return dispatch(env, ctx, installId, brandId, "/install", { install_id: installId, brand_id: brandId, revision_id: revision.revision_id, started_by: ctx.actor_id, started_role: ctx.actor_role });
}

async function rollback(request: Request, env: Env, ctx: AdminRequestContext, brandId: string): Promise<Response> {
  const brand = await env.FACTORY.prepare("SELECT current_revision_id FROM brands WHERE brand_id = ?1").bind(brandId).first<{ current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  const body = await request.json().catch(() => ({})) as { to_revision_id?: string | null };
  let target = body.to_revision_id ?? null;
  if (body.to_revision_id === undefined && brand.current_revision_id) {
    const previous = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE brand_id = ?1 AND kind IN ('install','upgrade','rollback') AND status = 'ready' AND to_revision_id IS NOT ?2 ORDER BY finished_at DESC LIMIT 1").bind(brandId, brand.current_revision_id).first<{ to_revision_id: string | null }>();
    target = previous?.to_revision_id ?? null;
  }
  const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = new Date().toISOString();
  await env.FACTORY.prepare("INSERT INTO installs (install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at) VALUES (?1,?2,'rollback','queued',?3,?4,?5,?6,?7)").bind(installId, brandId, brand.current_revision_id, target, ctx.actor_id, ctx.actor_role, now).run();
  await audit(env.FACTORY, ctx, "install.start", "install", installId, { brand_id: brandId, kind: "rollback", to_revision_id: target });
  return dispatch(env, ctx, installId, brandId, "/rollback", { install_id: installId, brand_id: brandId, to_revision_id: target, started_by: ctx.actor_id, started_role: ctx.actor_role });
}

async function artifactRoute(request: Request, env: Env, ctx: AdminRequestContext, path: string): Promise<Response> {
  if (ctx.actor_role !== "owner") return forbidden(ctx.actor_role);
  if (path === "/api/form-artifacts") {
    const parsed = Artifact.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
    try {
      await env.FACTORY.prepare("INSERT INTO form_artifacts (form_artifact_id,git_sha,r2_key,manifest_sha256,payload_version,bundle_form_version,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(parsed.data.form_artifact_id, parsed.data.git_sha, `forms/${parsed.data.form_artifact_id}`, "registered", parsed.data.payload_version, parsed.data.bundle_form_version, new Date().toISOString()).run();
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
  await env.FACTORY.prepare("UPDATE form_artifacts SET payload_version = ?1 WHERE form_artifact_id = ?2 AND payload_version IS NULL").bind(parsed.data.payload_version, parsed.data.form_artifact_id).run();
  await audit(env.FACTORY, ctx, "form_artifact.backfill", "form_artifact", parsed.data.form_artifact_id, { payload_version: parsed.data.payload_version });
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
    const response = await env.CORE_LIFECYCLE.fetch(new Request("https://core/lifecycle/test-sold", { method: "POST", headers: adminContextToHeaders(ctx), body: JSON.stringify({ brand_id: brandId, lead_id: body.lead_id }) }));
    const parsed = VerifySoldLeadResponse.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) return json(response.status || 502, { error: "test_sold_not_verified" });
    evidence = { ...evidence, event_id: parsed.data.event_id };
  }
  await env.FACTORY.prepare("INSERT INTO brand_checklist (brand_id,item,evidence_json,confirmed_by,confirmed_role,confirmed_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(brandId, item, JSON.stringify(evidence), ctx.actor_id, ctx.actor_role, evidence.verified_at).run();
  await audit(env.FACTORY, ctx, "checklist.attest", "brand", brandId, { item });
  return json(200, { brand_id: brandId, item, evidence });
}

export async function handleLifecycleRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  const method = request.method;
  let m: RegExpMatchArray | null;
  if (path === "/api/form-artifacts" && method === "POST") return artifactRoute(request, env, ctx, path);
  if (path.startsWith("/api/form-artifacts/") && method === "POST") return artifactRoute(request, env, ctx, path);
  if (path === "/api/brands/drafts" && method === "POST") {
    const g = authorizePanel("createBrand", ctx.actor_role); return g.ok ? createDraft(request, env, ctx) : forbidden(ctx.actor_role);
  }
  if ((path === "/api/lifecycle/brands" || path === "/api/brands/lifecycle") && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const { results } = await env.FACTORY.prepare("SELECT b.brand_id,b.name,b.account,b.domain,b.keyword_default,b.status,b.current_revision_id,r.template_version_id,r.form_artifact_id,fa.bundle_form_version,fa.payload_version FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=b.current_revision_id LEFT JOIN form_artifacts fa ON fa.form_artifact_id=r.form_artifact_id ORDER BY b.created_at DESC").all();
    return json(200, { brands: results });
  }
  m = path.match(/^\/api\/lifecycle\/brands\/([^/]+)$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const row = await env.FACTORY.prepare("SELECT b.brand_id,b.name,b.account,b.domain,b.keyword_default,b.status,b.current_revision_id,r.template_version_id,r.form_artifact_id,fa.bundle_form_version,fa.payload_version FROM brands b LEFT JOIN brand_revisions r ON r.revision_id=b.current_revision_id LEFT JOIN form_artifacts fa ON fa.form_artifact_id=r.form_artifact_id WHERE b.brand_id=?1").bind(m[1]).first();
    return row ? json(200, { brand: row }) : json(404, { error: "not_found", resource: "brand" });
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/(install|rollback|checklist)$/);
  if (m && method === "POST") {
    const brandId = decodeURIComponent(m[1]!);
    if (m[2] === "checklist") return checklist(request, env, ctx, brandId);
    const g = authorizePanel(m[2] === "install" ? "installBrand" : "rollbackBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    return m[2] === "install" ? startInstall(request, env, ctx, brandId) : rollback(request, env, ctx, brandId);
  }
  m = path.match(/^\/api\/installs\/([^/]+)\/retry$/);
  if (m && method === "POST") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const row = await env.FACTORY.prepare("SELECT install_id,brand_id,kind,from_revision_id,to_revision_id,started_by,started_role,status FROM installs WHERE install_id = ?1").bind(m[1]).first<{ install_id: string; brand_id: string; kind: string; from_revision_id: string | null; to_revision_id: string | null; started_by: string; started_role: AdminRole; status: string }>();
    if (!row) return json(404, { error: "not_found", resource: "install" });
    if (row.status !== "failed") return json(409, { error: "conflict", message: "Only failed installs can be retried" });
    const payload = row.kind === "rollback"
      ? { install_id: row.install_id, brand_id: row.brand_id, to_revision_id: row.to_revision_id, started_by: row.started_by, started_role: row.started_role }
      : { install_id: row.install_id, brand_id: row.brand_id, revision_id: row.to_revision_id, started_by: row.started_by, started_role: row.started_role };
    await env.FACTORY.prepare("UPDATE installs SET status='queued',error=NULL,finished_at=NULL WHERE install_id=?1").bind(row.install_id).run();
    return dispatch(env, ctx, row.install_id, row.brand_id, row.kind === "rollback" ? "/rollback" : "/install", payload);
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/installs$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const { results } = await env.FACTORY.prepare("SELECT install_id,brand_id,kind,status,from_revision_id,to_revision_id,started_by,started_role,started_at,finished_at,error FROM installs WHERE brand_id=?1 ORDER BY started_at DESC LIMIT 50").bind(m[1]).all();
    return json(200, { brand_id: m[1], installs: results });
  }
  m = path.match(/^\/api\/brands\/([^/]+)\/checklist$/);
  if (m && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const { results } = await env.FACTORY.prepare("SELECT item,evidence_json,confirmed_by,confirmed_role,confirmed_at FROM brand_checklist WHERE brand_id=?1 ORDER BY item").bind(m[1]).all();
    return json(200, { brand_id: m[1], checklist: results.map((r) => ({ ...r, evidence: JSON.parse(r.evidence_json as string), evidence_json: undefined })) });
  }
  m = path.match(/^\/api\/installs\/([^/]+)$/);
  if (m && method === "GET") {
    const row = await env.FACTORY.prepare("SELECT install_id,brand_id,to_revision_id,status FROM installs WHERE install_id=?1").bind(m[1]).first<{ install_id: string; brand_id: string; to_revision_id: string; status: string }>();
    if (!row) return json(404, { error: "not_found", resource: "install" });
    const { results } = await env.FACTORY.prepare("SELECT step,status,output_json FROM install_receipts WHERE install_id=?1 ORDER BY id").bind(m[1]).all<{ step: string; status: string; output_json: string | null }>();
    return json(200, { install_id: row.install_id, brand_id: row.brand_id, revision_id: row.to_revision_id, status: row.status, receipts: results.map((r) => ({ step: r.step, status: r.status === "ok" ? "ready" : r.status === "failed" ? "failed" : "queued", ...(r.output_json ? { output: JSON.parse(r.output_json) } : {}) })) });
  }
  if (path === "/api/upgrade-all" && method === "POST") {
    const g = authorizePanel("upgradeAll", ctx.actor_role); if (!g.ok) return forbidden(ctx.actor_role);
    const parsed = Upgrade.safeParse(await request.json().catch(() => null)); if (!parsed.success) return json(422, { error: "invalid", issues: parsed.error.issues });
    if (!env.FACTORY_WORKER) return json(502, { error: "factory_dispatch_failed", message: "Factory Worker binding is missing" });
    const payload = { ...parsed.data, started_by: ctx.actor_id, started_role: "owner" as const };
    await audit(env.FACTORY, ctx, "upgrade.start", "upgrade", `${ctx.actor_id}:${parsed.data.canary_brand_id}`, { ...parsed.data, started_role: "owner" });
    try {
      const response = await env.FACTORY_WORKER.fetch(new Request("https://factory/upgrade-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
      const body = await response.json().catch(() => ({}));
      return json(response.status, body);
    } catch { return json(502, { error: "factory_dispatch_failed" }); }
  }
  void url;
  return undefined;
}
