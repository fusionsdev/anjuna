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
  BrandId,
  BrandPatchRequest,
  BrandStatusChangeRequest,
  ConversionsQuery,
  LeadAggregatesQuery,
  SpendReportResponse,
  authorize,
  type AdminError,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { AUTH_ROLES } from "@anjuna/auth-db";
import { z } from "zod";
import { writePanelAudit } from "./audit.js";
import { createAuth, type Auth } from "./auth.js";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { isLocalDev } from "./local-dev.js";
import { authorizePanel } from "./panel-roles.js";
import { decodePathSegment, handleLifecycleRoute, readBrandChecklists } from "./lifecycle.js";
import { withMockBindings } from "./mock-bindings.js"; // spec polish
import { handleDeployRoute } from "./deploys.js";
import { handleTimelineRoute } from "./timeline.js";
import { handleAuditRoute } from "./audit-route.js";
import { handleBrandEditRoute } from "./brand-edit.js";
import { handleBuilderKeyRoute } from "./builder-keys.js";
import { handleApiKeyRoute, handleApiV1 } from "./api-v1.js";
import { handleLeadsRoute } from "./leads.js";
import { handleAdsCapsSettingRoute, handleFxSettingRoute, handleMicrosoftAdsSettingRoute, handleSettingsRoute, readFxSetting } from "./settings.js";
import { withUsd } from "./money.js";
import { handleSuppressionsRoute } from "./suppressions.js";
import { handleTemplateRoute } from "./templates.js";
import { handleTrafficRiskRoute } from "./traffic-risk.js";
import { handleTrafficLogRoute } from "./traffic-log.js"; // spec traffic
import { handleWizardRoute } from "./wizard.js";
import { handleUsersAdminRoute } from "./users-admin.js"; // spec polish

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
  const localDev = isLocalDev(request, env);

  const auth = createAuth(env, localDev);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.startsWith("/api/auth/")) {
    if (!AUTH_ALLOWED.has(path)) return notFound("route");
    return auth.handler(request);
  }

  // API v1: a bearer key or the session, with scopes (api-v1.ts).
  if (path === "/api/v1" || path.startsWith("/api/v1/")) return handleApiV1(request, env, url, path, auth);

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

  // Panel redesign (Task 4): every live brand's checklist in one read, for Home and the Brands screen.
  if (path === "/api/brands/checklists" && method === "GET") return readBrandChecklists(env, ctx);

  const lifecycle = await handleLifecycleRoute(request, env, url, path, ctx);
  if (lifecycle) return lifecycle;

  // spec brands (FUS-377): cross-brand deploy timeline.
  const deploys = await handleDeployRoute(request, env, url, path, ctx);
  if (deploys) return deploys;

  // spec timeline (FUS-380): brand timeline and manual Ads account events.
  const timeline = await handleTimelineRoute(request, env, url, path, ctx);
  if (timeline) return timeline;

  // spec settings (FUS-378): Owner-only settings read.
  const settings = await handleSettingsRoute(request, env, path, ctx);
  if (settings) return settings;

  // Baht per dollar for USD spend and profit (panel redesign, Task 1): owner read and write.
  const fxSetting = await handleFxSettingRoute(request, env, path, ctx);
  if (fxSetting) return fxSetting;

  // Baht caps for panel campaigns (T13 Part B): owner read and write.
  const adsCaps = await handleAdsCapsSettingRoute(request, env, path, ctx);
  if (adsCaps) return adsCaps;

  const wizard = await handleWizardRoute(request, env, path, ctx);
  if (wizard) return wizard;

  const templates = await handleTemplateRoute(request, env, path, ctx, email);
  if (templates) return templates;

  const builderKeys = await handleBuilderKeyRoute(request, env, path, ctx);
  if (builderKeys) return builderKeys;

  const apiKeys = await handleApiKeyRoute(request, env, path, ctx);
  if (apiKeys) return apiKeys;

  const microsoftAds = await handleMicrosoftAdsSettingRoute(request, env, path, ctx);
  if (microsoftAds) return microsoftAds;

  const brandEdit = await handleBrandEditRoute(request, env, path, ctx);
  if (brandEdit) return brandEdit;

  if (path === "/api/me" && method === "GET") {
    return json(200, { user: { id: ctx.actor_id, email, role: ctx.actor_role, account: env.DEFAULT_ACCOUNT } });
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
      if (action === "pause") {
        const owner = authorizePanel("pauseBrand", ctx.actor_role);
        if (!owner.ok) return forbidden(owner.error, rid);
      }
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

  // spec leads: after the aggregates arm above, or the lead id pattern captures it.
  const leads = await handleLeadsRoute(request, env, url, path, ctx);
  if (leads) return leads;
  const suppressions = await handleSuppressionsRoute(request, env, url, path, ctx);
  if (suppressions) return suppressions;

  // --- audit: core's rows (brand/config) plus the panel's own (sign-in, users) ---
  const auditList = await handleAuditRoute(request, env, url, path, ctx); // spec polish
  if (auditList) return auditList;

  // spec polish
  const usersAdmin = await handleUsersAdminRoute(request, env, path, ctx, auth);
  if (usersAdmin) return usersAdmin;

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
  if (path === "/api/traffic/breakdown" && method === "GET") {
    const g = authorize("trafficBreakdown", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "trafficBreakdown", query: url.searchParams }));
  }

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

  const trafficRisk = await handleTrafficRiskRoute(request, env, url, path, ctx);
  if (trafficRisk) return trafficRisk;

  // spec traffic
  const trafficLog = await handleTrafficLogRoute(request, env, url, path, ctx);
  if (trafficLog) return trafficLog;

  if (path === "/api/mailing" && method === "GET") {
    const g = authorize("mailingStatus", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "mailingStatus" }));
  }

  // Ad spend (FUS-368): owner only, so an employee never receives money figures. Core reports cost
  // in the account currency; the panel adds cost_usd and total_cost_usd at the owner's fx rate.
  if (path === "/api/spend" && method === "GET") {
    const g = authorize("spendReport", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const report = await callCore(env, ctx, { endpoint: "spendReport", query: url.searchParams });
    if (report.status !== 200) return fromCore(report);
    const fx = await readFxSetting(env.FACTORY);
    return json(200, withUsd(SpendReportResponse.parse(report.body), fx.thbPerUsd));
  }

  // Conversion action status (FUS-384): owner only, shown in the money section.
  if ((m = path.match(/^\/api\/brands\/([^/]+)\/conversion-setup$/)) && method === "GET") {
    const rawBrand = decodePathSegment(m[1]!);
    const id = rawBrand === null ? null : BrandId.safeParse(rawBrand);
    if (!id?.success) return notFound("brand", rid);
    const g = authorize("conversionSetup", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "conversionSetup", params: { id: id.data } }));
  }

  // Conversion uploads (FUS-375): read-only, employee allowed. Core nulls value and raw error text for a non-owner.
  if (path === "/api/conversions" && method === "GET") {
    const g = authorize("conversionsReport", ctx.actor_role);
    if (!g.ok) return forbidden(g.error, rid);
    const q = ConversionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "conversionsReport", query: url.searchParams }));
  }

  return notFound("route", rid);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    env = withMockBindings(env); // spec polish
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
