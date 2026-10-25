/**
 * Audit list (spec polish D2.1): core's rows (brand/config) merged with the panel's own (sign-in,
 * users, lifecycle). Every source is queried with the same cursor on every page, so the merged
 * sequence is one list ordered by id.
 *   GET /api/audit?limit=&cursor=&actor_id=&target_type=&target_id=  -> AuditListResponse
 */
import { AuditListResponse, AuditQuery, authorize, type AdminRequestContext, type AuditEntry } from "@anjuna/contracts";
import { decodeAuditCursor, encodeAuditCursor, listLifecycleAudit, listPanelAudit } from "./audit.js";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

// Core and the panel share the audit_log table in production: show each row once.
const isPanelRow = (e: AuditEntry) => e.action.startsWith("auth.") || e.action.startsWith("user.");

export async function handleAuditRoute(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  ctx: AdminRequestContext,
): Promise<Response | null> {
  if (request.method !== "GET" || path !== "/api/audit") return null;
  const rid = ctx.request_id;

  const g = authorize("listAudit", ctx.actor_role);
  if (!g.ok) return json(403, { ...g.error, request_id: rid });
  const q = AuditQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!q.success) {
    return json(422, { error: "invalid", request_id: rid, issues: q.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) });
  }
  const ownOnly = g.scope === "own";
  if (ownOnly && q.data.actor_id && q.data.actor_id !== ctx.actor_id) {
    return json(403, { error: "forbidden_role", required_role: "owner", request_id: rid });
  }
  const beforeId = q.data.cursor === undefined ? undefined : decodeAuditCursor(q.data.cursor) ?? null;
  if (beforeId === null) {
    return json(422, { error: "invalid", request_id: rid, issues: [{ path: "cursor", message: "Invalid cursor" }] });
  }

  const limit = q.data.limit ?? 50;
  const query = new URLSearchParams(url.searchParams);
  if (ownOnly) query.set("actor_id", ctx.actor_id);
  const core = await callCore(env, ctx, { endpoint: "listAudit", query });
  if (core.status !== 200) return fromCore(core);
  const coreList = AuditListResponse.parse(core.body);

  const actorId = ownOnly ? ctx.actor_id : q.data.actor_id;
  const skipLocal = q.data.target_type && q.data.target_type !== "user";
  // One extra local row tells whether the panel has more beyond this page.
  const localOpts = { actorId, targetType: q.data.target_type, targetId: q.data.target_id, limit: limit + 1, beforeId };
  // Users' rows are panel rows; lifecycle rows never target a user.
  const local = skipLocal ? [] : [
    ...await listPanelAudit(env.FACTORY, localOpts),
    ...(q.data.target_type === "user" ? [] : await listLifecycleAudit(env.FACTORY, localOpts)),
  ];
  const merged = [...coreList.entries.filter((e) => !isPanelRow(e)), ...local];
  const all = [...new Map(merged.map((entry) => [entry.id, entry])).values()].sort((a, b) => b.id - a.id);
  const entries = all.slice(0, limit);
  const last = entries[entries.length - 1];
  const more = all.length > limit || coreList.next_cursor !== null;
  const next_cursor = !more ? null : last ? encodeAuditCursor(last.id) : coreList.next_cursor;
  return json(200, { entries, next_cursor });
}
