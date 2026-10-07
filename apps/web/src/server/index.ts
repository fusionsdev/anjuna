/**
 * `anjuna-web` Worker: serves the SPA (static assets, run_worker_first) and the panel API under
 * /api/*. Request pipeline for /api/*:
 *   1. Cloudflare Access JWT                          -> 401 unauthorized
 *   2. better-auth session (except sign-in/out)       -> 401 unauthorized
 *   3. role check from ADMIN_ROLE_TABLE / PANEL_ROLE_TABLE (server is the gate) -> 403 forbidden_role
 *   4. call core over the admin API contract, or write a panel-only audit row
 */
import {
  AdminRole,
  type AuditEntry,
  AuditListResponse,
  AuditQuery,
  BrandId,
  BrandPatchRequest,
  BrandStatusChangeRequest,
  LeadAggregatesQuery,
  LeadId,
  authorize,
  type AdminError,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { AUTH_ROLES } from "@anjuna/auth-db";
import { z } from "zod";
import { verifyAccess } from "./access.js";
import { listLifecycleAudit, listPanelAudit, writePanelAudit } from "./audit.js";
import { createAuth, type Auth } from "./auth.js";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { authorizePanel } from "./panel-roles.js";
import { decodePathSegment, handleLifecycleRoute } from "./lifecycle.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fromCore = (r: CoreResult): Response => json(r.status, r.body);

const forbidden = (e: Extract<AdminError, { error: "forbidden_role" }>, requestId: string): Response =>
  json(403, { ...e, request_id: requestId });

const notFound = (resource: "brand" | "lead" | "route", requestId?: string): Response =>
  json(404, { error: "not_found", resource, ...(requestId ? { request_id: requestId } : {}) });

const invalid = (error: z.ZodError, requestId: string): Response =>
  json(422, {
    error: "invalid",
    request_id: requestId,
    issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });

/** Only these better-auth endpoints are reachable: the admin plugin's own routes would skip the panel's audit. */
const AUTH_ALLOWED = new Set(["/api/auth/sign-in/email", "/api/auth/sign-out", "/api/auth/get-session"]);

const readJson = async (req: Request): Promise<unknown> => req.json().catch(() => ({}));

const UserCreate = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(128),
  role: z.enum(AUTH_ROLES),
});
const UserSetRole = z.strictObject({ role: z.enum(AUTH_ROLES) });

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const access = await verifyAccess(request, env);
  if (!access.ok) return json(401, { error: "unauthorized" });

  const auth = createAuth(env);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.startsWith("/api/auth/")) {
    if (!AUTH_ALLOWED.has(path)) return notFound("route");
    return auth.handler(request);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const role = AdminRole.safeParse(session?.user.role);
  if (!session || !role.success) return json(401, { error: "unauthorized" });

  const ctx: AdminRequestContext = {
    actor_id: session.user.id,
    actor_role: role.data,
    request_id: `req_${crypto.randomUUID()}`,
  };
  return route(request, env, url, path, auth, ctx, session.user.email);
}

async function route(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  auth: Auth,
  ctx: AdminRequestContext,
  email: string,
): Promise<Response> {
  const { method } = request;
  const rid = ctx.request_id;
  let m: RegExpMatchArray | null;

  const lifecycle = await handleLifecycleRoute(request, env, url, path, ctx);
  if (lifecycle) return lifecycle;

  if (path === "/api/me" && method === "GET") {
    return json(200, { user: { id: ctx.actor_id, email, role: ctx.actor_role } });
  }

  // --- brands (core admin API + factory DB) ---
  if (path === "/api/brands" && method === "GET") {
    const g = authorize("listBrands", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "listBrands" }));
  }

  if (path === "/api/brands" && method === "POST") {
    return json(410, { error: "legacy_route_retired", message: "Use POST /api/brands/drafts" });
  }

  if ((m = path.match(/^\/api\/brands\/([^/]+)(?:\/(pause|resume))?$/))) {
    const rawBrand = decodePathSegment(m[1]!);
    if (rawBrand === null) return notFound("brand", rid);
    const id = BrandId.safeParse(rawBrand);
    const action = m[2];
    if (!id.success) return notFound("brand", rid);

    if (!action && method === "GET") {
      const g = authorize("getBrand", ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      return fromCore(await callCore(env, ctx, { endpoint: "getBrand", params: { id: id.data } }));
    }

    if (!action && method === "PATCH") {
      const g = authorize("patchBrand", ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      const parsed = BrandPatchRequest.safeParse(await readJson(request));
      if (!parsed.success) return invalid(parsed.error, rid);
      const fields = authorize("patchBrand", ctx.actor_role, parsed.data);
      if (!fields.ok) return forbidden(fields.error, rid);
      return fromCore(await callCore(env, ctx, { endpoint: "patchBrand", params: { id: id.data }, body: parsed.data }));
    }

    if ((action === "pause" || action === "resume") && method === "POST") {
      const endpoint = action === "pause" ? "pauseBrand" : "resumeBrand";
      const g = authorize(endpoint, ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      const parsed = BrandStatusChangeRequest.safeParse(await readJson(request));
      if (!parsed.success) return invalid(parsed.error, rid);
      return fromCore(await callCore(env, ctx, { endpoint, params: { id: id.data }, body: parsed.data }));
    }

  }

  // --- leads ---
  if (path === "/api/leads/aggregates" && method === "GET") {
    const g = authorize("leadAggregates", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const q = LeadAggregatesQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "leadAggregates", query: url.searchParams }));
  }

  if ((m = path.match(/^\/api\/leads\/([^/]+)$/)) && method === "GET") {
    // PII: owner only (plan: "View individual leads with PII").
    const g = authorize("getLead", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const rawLead = decodePathSegment(m[1]!);
    if (rawLead === null) return notFound("lead", rid);
    const id = LeadId.safeParse(rawLead);
    if (!id.success) return notFound("lead", rid);
    return fromCore(await callCore(env, ctx, { endpoint: "getLead", params: { lead_id: id.data } }));
  }

  // --- audit: core's rows (brand/config) plus the panel's own (sign-in, users) ---
  if (path === "/api/audit" && method === "GET") {
    const g = authorize("listAudit", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const q = AuditQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    const ownOnly = g.scope === "own";
    if (ownOnly && q.data.actor_id && q.data.actor_id !== ctx.actor_id) {
      return forbidden({ error: "forbidden_role", required_role: "owner" }, rid);
    }
    const limit = q.data.limit ?? 50;
    const query = new URLSearchParams(url.searchParams);
    if (ownOnly) query.set("actor_id", ctx.actor_id);
    const core = await callCore(env, ctx, { endpoint: "listAudit", query });
    if (core.status !== 200) return fromCore(core);
    const coreList = AuditListResponse.parse(core.body);
    const actorId = ownOnly ? ctx.actor_id : q.data.actor_id;
    const skipLocal = (q.data.target_type && q.data.target_type !== "user") || q.data.cursor !== undefined;
    const local = skipLocal ? [] : [...await listPanelAudit(env.FACTORY, { actorId, limit }), ...await listLifecycleAudit(env.FACTORY, { actorId, limit })];
    // Core and the panel share the audit_log table in production: show each row once.
    const isPanelRow = (e: AuditEntry) => e.action.startsWith("auth.") || e.action.startsWith("user.");
    const merged = [...coreList.entries.filter((e) => !isPanelRow(e)), ...local];
    const entries = [...new Map(merged.map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id))
      .slice(0, limit);
    return json(200, { entries, next_cursor: coreList.next_cursor });
  }

  // --- users (panel-only, owner only) ---
  if (path === "/api/users" && method === "GET") {
    const g = authorizePanel("listUsers", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const { results } = await env.AUTH.prepare(
      `SELECT "id", "name", "email", "role", "banned" FROM "user" ORDER BY "createdAt", "id"`,
    ).all<{ id: string; name: string; email: string; role: string; banned: number | null }>();
    return json(200, { users: results.map((u) => ({ ...u, banned: !!u.banned })) });
  }

  if (path === "/api/users" && method === "POST") {
    const g = authorizePanel("createUser", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const body = UserCreate.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error, rid);
    let created;
    try {
      created = await auth.api.createUser({ body: body.data, headers: request.headers });
    } catch {
      return json(409, { error: "conflict", message: "User could not be created (email already in use?).", request_id: rid });
    }
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.create",
      entity_type: "user",
      entity_id: created.user.id,
      after: { email: body.data.email, role: body.data.role },
    });
    return json(201, { user: { id: created.user.id, name: body.data.name, email: body.data.email, role: body.data.role, banned: false } });
  }

  if ((m = path.match(/^\/api\/users\/([^/]+)$/)) && method === "PATCH") {
    const g = authorizePanel("setUserRole", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const userId = decodePathSegment(m[1]!);
    if (userId === null) return json(404, { error: "not_found", resource: "user", request_id: rid });
    const body = UserSetRole.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error, rid);
    if (userId === ctx.actor_id) {
      return json(422, { error: "invalid", request_id: rid, issues: [{ path: "id", message: "You cannot change your own role" }] });
    }
    const before = await env.AUTH.prepare(`SELECT "role" FROM "user" WHERE "id" = ?1`).bind(userId).first<{ role: string }>();
    if (!before) return json(404, { error: "not_found", resource: "user", request_id: rid });
    await auth.api.setRole({ body: { userId, role: body.data.role }, headers: request.headers });
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.set_role",
      entity_type: "user",
      entity_id: userId,
      before: { role: before.role },
      after: { role: body.data.role },
    });
    return json(200, { user: { id: userId, role: body.data.role } });
  }

  // --- reports: core read-only admin routes. The panel does not bind the leads D1. ---
  if (path === "/api/funnel" && method === "GET") {
    const g = authorize("funnelReport", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "funnelReport", query: url.searchParams }));
  }

  if (path === "/api/alerts" && method === "GET") {
    const g = authorize("alertsReport", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "alertsReport", query: url.searchParams }));
  }

  if (path === "/api/mailing" && method === "GET") {
    const g = authorize("mailingStatus", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "mailingStatus" }));
  }

  return notFound("route", rid);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch {
        return json(500, { error: "internal" });
      }
    }
    // Everything else is the SPA. With `run_worker_first` the Worker sees every path first and
    // hands non-API paths to the assets binding, which falls back to index.html.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
