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
import { listPanelAudit, writePanelAudit, writeFactoryAudit } from "./audit.js";
import { createAuth, type Auth } from "./auth.js";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { authorizePanel } from "./panel-roles.js";

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

const BrandCreate = z.strictObject({
  name: z.string().min(1).max(128),
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/, "Must be a valid lowercase hostname"),
  keyword_default: z.string().min(1).max(100),
  account: z.string().min(1).max(64).optional(),
});

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
    const g = authorizePanel("createBrand", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const body = BrandCreate.safeParse(await readJson(request));
    if (!body.success) return invalid(body.error, rid);
    const brandId = `brand_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await env.FACTORY.prepare(
      "INSERT INTO brands (brand_id, name, account, domain, keyword_default, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )
      .bind(brandId, body.data.name, body.data.account ?? "default", body.data.domain, body.data.keyword_default, ctx.actor_id, now)
      .run();
    await writeFactoryAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "brand.create",
      entity_type: "brand",
      entity_id: brandId,
      after: { name: body.data.name, domain: body.data.domain, keyword_default: body.data.keyword_default },
    });
    return json(201, { brand: { brand_id: brandId, name: body.data.name, domain: body.data.domain, keyword_default: body.data.keyword_default, status: "draft" } });
  }

  if ((m = path.match(/^\/api\/brands\/([^/]+)(?:\/(pause|resume|rollback|install|installs))?$/))) {
    const id = BrandId.safeParse(decodeURIComponent(m[1]!));
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

    if (action === "rollback" && method === "POST") {
      const g = authorizePanel("rollbackBrand", ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      const brand = await env.FACTORY.prepare("SELECT brand_id, status FROM brands WHERE brand_id = ?1").bind(id.data).first<{ brand_id: string; status: string }>();
      if (!brand) return notFound("brand", rid);
      const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      await env.FACTORY.prepare(
        "INSERT INTO installs (install_id, brand_id, kind, status, started_by, started_at) VALUES (?1, ?2, 'rollback', 'queued', ?3, ?4)",
      )
        .bind(installId, id.data, ctx.actor_id, now)
        .run();
      await writeFactoryAudit(env.FACTORY, {
        actor_id: ctx.actor_id,
        actor_role: ctx.actor_role,
        action: "install.start",
        entity_type: "install",
        entity_id: installId,
        after: { brand_id: id.data, kind: "rollback" },
      });
      if (env.FACTORY_WORKER) {
        await env.FACTORY_WORKER.fetch(new Request("https://factory/rollback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ install_id: installId, brand_id: id.data }),
        })).catch(() => null);
      }
      return json(201, { install_id: installId, brand_id: id.data, kind: "rollback", status: "queued" });
    }

    if (action === "install" && method === "POST") {
      const g = authorizePanel("installBrand", ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      const brand = await env.FACTORY.prepare("SELECT brand_id, status FROM brands WHERE brand_id = ?1").bind(id.data).first<{ brand_id: string; status: string }>();
      if (!brand) return notFound("brand", rid);
      const installId = `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      await env.FACTORY.prepare(
        "INSERT INTO installs (install_id, brand_id, kind, status, started_by, started_at) VALUES (?1, ?2, 'install', 'queued', ?3, ?4)",
      )
        .bind(installId, id.data, ctx.actor_id, now)
        .run();
      await writeFactoryAudit(env.FACTORY, {
        actor_id: ctx.actor_id,
        actor_role: ctx.actor_role,
        action: "install.start",
        entity_type: "install",
        entity_id: installId,
        after: { brand_id: id.data, kind: "install" },
      });
      if (env.FACTORY_WORKER) {
        await env.FACTORY_WORKER.fetch(new Request("https://factory/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ install_id: installId, brand_id: id.data }),
        })).catch(() => null);
      }
      return json(201, { install_id: installId, brand_id: id.data, kind: "install", status: "queued" });
    }

    if (action === "installs" && method === "GET") {
      const g = authorizePanel("installBrand", ctx.actor_role);
      if (!g.ok) return forbidden(g.error, rid);
      const brand = await env.FACTORY.prepare("SELECT brand_id FROM brands WHERE brand_id = ?1").bind(id.data).first<{ brand_id: string }>();
      if (!brand) return notFound("brand", rid);
      const { results } = await env.FACTORY.prepare(
        "SELECT install_id, kind, status, started_by, started_at, finished_at, error FROM installs WHERE brand_id = ?1 ORDER BY started_at DESC LIMIT 50",
      )
        .bind(id.data)
        .all<{ install_id: string; kind: string; status: string; started_by: string; started_at: string; finished_at: string | null; error: string | null }>();
      return json(200, { brand_id: id.data, installs: results });
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
    const id = LeadId.safeParse(decodeURIComponent(m[1]!));
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
    const local = skipLocal ? [] : await listPanelAudit(env.FACTORY, { actorId, limit });
    // Core and the panel share the audit_log table in production: show each row once.
    const isPanelRow = (e: AuditEntry) => e.action.startsWith("auth.") || e.action.startsWith("user.");
    const entries = [...coreList.entries.filter((e) => !isPanelRow(e)), ...local]
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
    const userId = decodeURIComponent(m[1]!);
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

  // --- upgrade-all ---
  if (path === "/api/upgrade-all" && method === "POST") {
    const g = authorizePanel("upgradeAll", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const { results: brands } = await env.FACTORY.prepare(
      "SELECT brand_id FROM brands WHERE status IN ('live', 'paused')",
    ).all<{ brand_id: string }>();
    const now = new Date().toISOString();
    const installs = brands.map((b) => ({
      install_id: `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      brand_id: b.brand_id,
    }));
    if (installs.length > 0) {
      await env.FACTORY.batch(
        installs.map((i) =>
          env.FACTORY.prepare(
            "INSERT INTO installs (install_id, brand_id, kind, status, started_by, started_at) VALUES (?1, ?2, 'upgrade', 'queued', ?3, ?4)",
          ).bind(i.install_id, i.brand_id, ctx.actor_id, now),
        ),
      );
      if (env.FACTORY_WORKER) {
        for (const i of installs) {
          await env.FACTORY_WORKER.fetch(new Request("https://factory/upgrade", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ install_id: i.install_id, brand_id: i.brand_id }),
          })).catch(() => null);
        }
      }
    }
    return json(201, { queued: installs.length, install_ids: installs.map((i) => i.install_id) });
  }

  // --- alerts (T9 table; stub until T9 merges) ---
  if (path === "/api/alerts" && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); // employee+
    if (!g.ok) return forbidden(g.error, rid);
    return json(200, { alerts: [] });
  }

  // --- mailing status (listmonk; stub until T8/T9 configure the instance) ---
  if (path === "/api/mailing" && method === "GET") {
    const g = authorizePanel("installBrand", ctx.actor_role); // employee+
    if (!g.ok) return forbidden(g.error, rid);
    return json(200, { status: "not_configured" });
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
