// spec brands (FUS-377): the cross-brand deploy timeline. Read-only over the factory D1 and core listAudit.
import {
  AuditListResponse,
  BrandId,
  BrandRevisionsResponse,
  DeployHistoryQuery,
  DeployHistoryResponse,
  type AdminRequestContext,
  type DeployEvent,
  type DeployUnavailableSource,
} from "@anjuna/contracts";
import { callCore } from "./core.js";
import type { Env } from "./env.js";
import { decodePathSegment, installOperation, rollbackTargetRevisionId } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";
import { asTimestamp } from "./timestamps.js";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/**
 * Factory audit actions that belong on the timeline, each matched whole or as a prefix followed by ".".
 * install.start, install.failed, redeploy.* and upgrade.* are left out: the install row already carries them.
 */
export const DEPLOY_AUDIT_ACTIONS: readonly string[] = [
  "brand.create", "brand.duplicate", "brand.draft_update", "brand.profile", "brand.asset", "checklist.attest",
];
/** The only brand actions core writes (workers/core/src/admin/index.ts); matched by exact name. */
export const CORE_DEPLOY_AUDIT_ACTIONS = ["brand.update", "brand.pause", "brand.resume"] as const;
const isCoreDeployAuditAction = (action: string): boolean =>
  (CORE_DEPLOY_AUDIT_ACTIONS as readonly string[]).includes(action);

const DEFAULT_LIMIT = 50;
const CORE_AUDIT_MAX = 200;
// installs.to_revision_id of a redeploy is `<brand_id>_redeploy_<install_id>` (see installOperation); "_redeploy_" is 10 characters.
const IS_REDEPLOY = "(to_revision_id IS NOT NULL AND substr(to_revision_id, 1, length(brand_id) + 10) = brand_id || '_redeploy_')";

interface InstallRow {
  install_id: string; brand_id: string; kind: string; status: DeployEvent["status"];
  from_revision_id: string | null; to_revision_id: string | null; is_canary: number;
  started_by: string; started_role: DeployEvent["started_role"]; started_at: string; finished_at: string | null; error: string | null;
}
interface AuditRow {
  id: number; actor_id: string; actor_role: DeployEvent["started_role"]; action: string; entity_id: string; created_at: string;
}

async function installEvents(db: D1Database, q: DeployHistoryQuery, limit: number): Promise<DeployEvent[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.brand) { where.push("brand_id = ?"); binds.push(q.brand); }
  if (q.status) { where.push("status = ?"); binds.push(q.status); }
  if (q.operation === "install" || q.operation === "rollback") { where.push("kind = ?"); binds.push(q.operation); }
  if (q.operation === "upgrade") where.push(`kind = 'upgrade' AND NOT ${IS_REDEPLOY}`);
  if (q.operation === "redeploy") where.push(`kind = 'upgrade' AND ${IS_REDEPLOY}`);
  // julianday() reads the offset in "+07:00", so the LIMIT cuts at the same instant order the merge sorts by.
  const { results } = await db.prepare(
    `SELECT install_id, brand_id, kind, status, from_revision_id, to_revision_id, is_canary, started_by, started_role, started_at, finished_at, error
       FROM installs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY julianday(started_at) DESC, install_id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<InstallRow>();
  // A row whose started_at is not a date at all cannot be placed on the timeline: drop it, keep the rest.
  return results.flatMap((r): DeployEvent[] => {
    const startedAt = asTimestamp(r.started_at);
    if (startedAt === null) return [];
    return [{
      source: "install" as const,
      event_id: r.install_id,
      brand_id: r.brand_id,
      operation: installOperation(r.kind, r.brand_id, r.to_revision_id),
      action: null,
      status: r.status,
      from_revision_id: r.from_revision_id,
      to_revision_id: r.to_revision_id,
      is_canary: r.is_canary === 1,
      started_by: r.started_by,
      started_role: r.started_role,
      started_at: startedAt,
      finished_at: r.finished_at === null ? null : asTimestamp(r.finished_at),
      error: r.error === null ? null : r.error.slice(0, 500),
    }];
  });
}

// The factory and core audit tables are separate, so their numeric ids can collide: core rows get their own prefix.
const auditEvent = (eventId: string, brandId: string, action: string, actorId: string, role: DeployEvent["started_role"], at: string): DeployEvent | null => {
  const startedAt = asTimestamp(at);
  if (startedAt === null) return null;
  return {
    source: "audit",
    event_id: eventId,
    brand_id: brandId,
    operation: null,
    action,
    status: "done",
    from_revision_id: null,
    to_revision_id: null,
    is_canary: false,
    started_by: actorId,
    started_role: role,
    started_at: startedAt,
    finished_at: null,
    error: null,
  };
};

async function factoryAuditEvents(db: D1Database, q: DeployHistoryQuery, limit: number, onlyActor: string | null): Promise<DeployEvent[]> {
  const actions = DEPLOY_AUDIT_ACTIONS.map(() => "(action = ? OR substr(action, 1, ?) = ?)").join(" OR ");
  const binds: unknown[] = DEPLOY_AUDIT_ACTIONS.flatMap((a) => [a, a.length + 1, `${a}.`]);
  const where = ["entity_type = 'brand'", `(${actions})`];
  if (q.brand) { where.push("entity_id = ?"); binds.push(q.brand); }
  if (onlyActor) { where.push("actor_id = ?"); binds.push(onlyActor); }
  const { results } = await db.prepare(
    `SELECT id, actor_id, actor_role, action, entity_id, created_at FROM audit_log
       WHERE ${where.join(" AND ")} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<AuditRow>();
  return results.flatMap((r) => auditEvent(`audit-${r.id}`, r.entity_id, r.action, r.actor_id, r.actor_role, r.created_at) ?? []);
}

async function coreAuditEvents(env: Env, ctx: AdminRequestContext, q: DeployHistoryQuery, limit: number, onlyActor: string | null): Promise<{ events: DeployEvent[]; more: boolean } | null> {
  // Core rejects a limit above 200 (AUDIT_PAGE_LIMIT), so at limit=200 it cannot be asked for one extra row;
  // next_cursor tells us it holds more.
  const query = new URLSearchParams({ target_type: "brand", limit: String(Math.min(limit + 1, CORE_AUDIT_MAX)) });
  if (q.brand) query.set("target_id", q.brand);
  if (onlyActor) query.set("actor_id", onlyActor);
  const result = await callCore(env, ctx, { endpoint: "listAudit", query });
  if (result.status !== 200) return null;
  const parsed = AuditListResponse.safeParse(result.body);
  if (!parsed.success) return null;
  const events = parsed.data.entries
    .filter((e) => e.target.type === "brand" && isCoreDeployAuditAction(e.action) && BrandId.safeParse(e.target.id).success)
    .filter((e) => (!q.brand || e.target.id === q.brand) && (!onlyActor || e.actor_id === onlyActor))
    .flatMap((e) => auditEvent(`core-audit-${e.id}`, e.target.id, e.action, e.actor_id, e.actor_role, e.at) ?? []);
  // Below the cap the extra row already makes the merged length exceed limit; only the capped request needs the cursor.
  return { events, more: limit + 1 > CORE_AUDIT_MAX && parsed.data.next_cursor !== null };
}

// Newest instant first; the text of the timestamp is no guide because offsets differ between rows.
const byInstantDesc = (a: DeployEvent, b: DeployEvent): number =>
  Date.parse(b.started_at) - Date.parse(a.started_at) || (a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0);

interface RevisionRow {
  revision_id: string; revision: number; template_version_id: string; form_artifact_id: string;
  bundle_form_version: string | null; worker_version_id: string | null; created_by: string; created_at: string;
}

async function brandRevisions(env: Env, ctx: AdminRequestContext, rawBrandId: string): Promise<Response> {
  const gate = authorizePanel("installBrand", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const brandId = decodePathSegment(rawBrandId);
  if (brandId === null) return json(400, { error: "invalid_brand_id" });
  const brand = await env.FACTORY.prepare("SELECT brand_id, current_revision_id FROM brands WHERE brand_id = ?1")
    .bind(brandId).first<{ brand_id: string; current_revision_id: string | null }>();
  if (!brand) return json(404, { error: "not_found", resource: "brand" });
  const { results } = await env.FACTORY.prepare(
    `SELECT r.revision_id, r.revision, r.template_version_id, r.form_artifact_id, fa.bundle_form_version, r.worker_version_id, r.created_by, r.created_at
       FROM brand_revisions r LEFT JOIN form_artifacts fa ON fa.form_artifact_id = r.form_artifact_id
       WHERE r.brand_id = ?1 ORDER BY r.revision DESC LIMIT 100`,
  ).bind(brandId).all<RevisionRow>();
  const rollbackTarget = await rollbackTargetRevisionId(env.FACTORY, brandId, brand.current_revision_id);
  return json(200, BrandRevisionsResponse.parse({
    brand_id: brand.brand_id,
    current_revision_id: brand.current_revision_id,
    rollback_target_revision_id: rollbackTarget,
    revisions: results.flatMap((r) => {
      const createdAt = asTimestamp(r.created_at);
      return createdAt === null ? [] : [{ ...r, created_at: createdAt, is_current: r.revision_id === brand.current_revision_id }];
    }),
  }));
}

export async function handleDeployRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const revisions = path.match(/^\/api\/brands\/([^/]+)\/revisions$/);
  if (revisions) return brandRevisions(env, ctx, revisions[1]!);
  if (path !== "/api/deploys") return undefined;
  const gate = authorizePanel("installBrand", ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const parsed = DeployHistoryQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return json(422, {
      error: "invalid", request_id: ctx.request_id,
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  const q = parsed.data;
  const limit = q.limit ?? DEFAULT_LIMIT;
  // Install rows are visible to both roles. Audit rows follow /api/audit: an employee sees only their own.
  const onlyActor = ctx.actor_role === "owner" ? null : ctx.actor_id;
  const wantsAudit = q.source !== "install" && q.operation === undefined && (q.status === undefined || q.status === "done");
  const wantsInstalls = q.source !== "audit" && q.status !== "done";

  const unavailable: DeployUnavailableSource[] = [];
  const installs = wantsInstalls ? await installEvents(env.FACTORY, q, limit) : [];
  const factoryAudit = wantsAudit ? await factoryAuditEvents(env.FACTORY, q, limit, onlyActor) : [];
  let coreAudit: DeployEvent[] = [];
  let coreMore = false;
  if (wantsAudit) {
    const fetched = await coreAuditEvents(env, ctx, q, limit, onlyActor);
    if (fetched === null) unavailable.push("core_audit");
    else { coreAudit = fetched.events; coreMore = fetched.more; }
  }

  // No dedupe: install ids, `audit-<id>` and `core-audit-<id>` are disjoint, and the factory and core action
  // allowlists are disjoint, so no source can return the same row twice.
  const merged = [...installs, ...factoryAudit, ...coreAudit].sort(byInstantDesc);
  return json(200, DeployHistoryResponse.parse({ events: merged.slice(0, limit), has_more: merged.length > limit || coreMore, unavailable }));
}
