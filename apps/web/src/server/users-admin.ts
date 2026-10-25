/**
 * Owner-only user admin routes (spec polish D1.1): ban, unban, password reset, delete and
 * session management through better-auth `auth.api.*`, audited like the other admin writes.
 *   POST   /api/users/:id/ban                { reason?: string } -> 200
 *   POST   /api/users/:id/unban                                   -> 200
 *   POST   /api/users/:id/password           { password: string } -> 200
 *   DELETE /api/users/:id                                        -> 200
 *   GET    /api/users/:id/sessions                               -> { sessions: UserSession[] }
 *   DELETE /api/users/:id/sessions                               -> 200
 *   DELETE /api/users/:id/sessions/:sid                          -> 200
 */
import { z } from "zod";
import type { AdminRequestContext } from "@anjuna/contracts";
import { writePanelAudit } from "./audit.js";
import type { Auth } from "./auth.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const invalid = (issues: { path: string; message: string }[], requestId: string): Response =>
  json(422, { error: "invalid", request_id: requestId, issues });

/** The session shape the panel returns: better-auth's row minus the token, which never leaves the server. */
export interface UserSession {
  id: string;
  created_at: string;
  expires_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const toUserSession = (s: { id: string; createdAt: unknown; expiresAt: unknown; ipAddress: unknown; userAgent: unknown }): UserSession => ({
  id: s.id,
  created_at: iso(s.createdAt),
  expires_at: iso(s.expiresAt),
  ip_address: s.ipAddress == null ? null : String(s.ipAddress),
  user_agent: s.userAgent == null ? null : String(s.userAgent),
});

const BanBody = z.strictObject({ reason: z.string().trim().min(1).max(200).optional() });
const PasswordBody = z.strictObject({ password: z.string().min(8).max(128) });

/** better-auth throws its own APIError; map a missing user to the panel's 404 shape. */
const isNotFound = (e: unknown): boolean => {
  const status = (e as { status?: unknown; statusCode?: unknown })?.status
    ?? (e as { statusCode?: unknown })?.statusCode;
  return status === 404 || status === "NOT_FOUND";
};

/**
 * Empty body means "no fields" (ban allows it); anything else must parse as JSON,
 * the core `readJsonObject` convention. Returns null when the body does not parse.
 */
const readJsonBody = async (request: Request): Promise<unknown | null> => {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export async function handleUsersAdminRoute(
  request: Request,
  env: Env,
  path: string,
  ctx: AdminRequestContext,
  auth: Auth,
): Promise<Response | null> {
  const { method } = request;
  const rid = ctx.request_id;

  const sessionsList = path.match(/^\/api\/users\/([^/]+)\/sessions$/);
  const sessionOne = path.match(/^\/api\/users\/([^/]+)\/sessions\/([^/]+)$/);
  const ban = method === "POST" && path.match(/^\/api\/users\/([^/]+)\/ban$/);
  const unban = method === "POST" && path.match(/^\/api\/users\/([^/]+)\/unban$/);
  const password = method === "POST" && path.match(/^\/api\/users\/([^/]+)\/password$/);
  const remove = method === "DELETE" && path.match(/^\/api\/users\/([^/]+)$/);
  // `||`: a method-guarded arm is `false` on other methods, and `??` would keep that `false`.
  const match = sessionsList || sessionOne || ban || unban || password || remove;
  if (!match) return null;

  const userId = decodePathSegment(match[1]!);
  if (userId === null) return json(404, { error: "not_found", resource: "user", request_id: rid });

  const action = ban ? "banUser" : unban ? "banUser" : password ? "resetUserPassword" : sessionOne || sessionsList ? "manageUserSessions" : "deleteUser";
  const g = authorizePanel(action, ctx.actor_role);
  if (!g.ok) return json(403, { ...g.error, request_id: rid });

  const user = await env.AUTH.prepare(`SELECT "id", "email", "role" FROM "user" WHERE "id" = ?1`).bind(userId).first<{ id: string; email: string; role: string }>();
  if (!user) return json(404, { error: "not_found", resource: "user", request_id: rid });

  const selfInvalid = (message: string): Response => invalid([{ path: "id", message }], rid);

  if (ban) {
    if (userId === ctx.actor_id) return selfInvalid("You cannot ban yourself");
    const raw = await readJsonBody(request);
    if (raw === null) return invalid([{ path: "body", message: "Invalid JSON" }], rid);
    const body = BanBody.safeParse(raw);
    if (!body.success) {
      return invalid(body.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })), rid);
    }
    try {
      await auth.api.banUser({ body: { userId, ...(body.data.reason ? { banReason: body.data.reason } : {}) }, headers: request.headers });
    } catch (e) {
      if (isNotFound(e)) return json(404, { error: "not_found", resource: "user", request_id: rid });
      throw e;
    }
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.ban",
      entity_type: "user",
      entity_id: userId,
      after: { reason: body.data.reason ?? null },
    });
    return json(200, { user: { id: userId, banned: true } });
  }

  if (unban) {
    try {
      await auth.api.unbanUser({ body: { userId }, headers: request.headers });
    } catch (e) {
      if (isNotFound(e)) return json(404, { error: "not_found", resource: "user", request_id: rid });
      throw e;
    }
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.unban",
      entity_type: "user",
      entity_id: userId,
    });
    return json(200, { user: { id: userId, banned: false } });
  }

  if (password) {
    if (userId === ctx.actor_id) return selfInvalid("You cannot reset your own password here");
    const body = PasswordBody.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return invalid(body.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })), rid);
    }
    try {
      await auth.api.setUserPassword({ body: { userId, newPassword: body.data.password }, headers: request.headers });
    } catch (e) {
      if (isNotFound(e)) return json(404, { error: "not_found", resource: "user", request_id: rid });
      throw e;
    }
    // Written before the session revoke: a revoke failure must not lose the reset row.
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.reset_password",
      entity_type: "user",
      entity_id: userId,
    });
    try {
      await auth.api.revokeUserSessions({ body: { userId }, headers: request.headers });
    } catch (e) {
      if (isNotFound(e)) return json(404, { error: "not_found", resource: "user", request_id: rid });
      throw e;
    }
    return json(200, { user: { id: userId } });
  }

  if (remove) {
    if (userId === ctx.actor_id) return selfInvalid("You cannot delete yourself");
    try {
      await auth.api.removeUser({ body: { userId }, headers: request.headers });
    } catch (e) {
      if (isNotFound(e)) return json(404, { error: "not_found", resource: "user", request_id: rid });
      throw e;
    }
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.delete",
      entity_type: "user",
      entity_id: userId,
      before: { email: user.email, role: user.role },
    });
    return json(200, { removed: true });
  }

  if (sessionsList && method === "GET") {
    const { sessions } = await auth.api.listUserSessions({ body: { userId }, headers: request.headers });
    return json(200, { sessions: (sessions as { id: string; createdAt: unknown; expiresAt: unknown; ipAddress: unknown; userAgent: unknown }[]).map(toUserSession) });
  }

  if (sessionsList && method === "DELETE") {
    await auth.api.revokeUserSessions({ body: { userId }, headers: request.headers });
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.revoke_sessions",
      entity_type: "user",
      entity_id: userId,
    });
    return json(200, { revoked: true });
  }

  if (sessionOne && method === "DELETE") {
    const sessionId = decodePathSegment(match[2]!);
    if (sessionId === null) return json(404, { error: "not_found", resource: "session", request_id: rid });
    const row = await env.AUTH.prepare(`SELECT "token", "userId" FROM "session" WHERE "id" = ?1`).bind(sessionId).first<{ token: string; userId: string }>();
    if (!row || row.userId !== userId) return json(404, { error: "not_found", resource: "session", request_id: rid });
    await auth.api.revokeUserSession({ body: { sessionToken: row.token }, headers: request.headers });
    await writePanelAudit(env.FACTORY, {
      actor_id: ctx.actor_id,
      actor_role: ctx.actor_role,
      action: "user.revoke_session",
      entity_type: "user",
      entity_id: userId,
      after: { session_id: sessionId },
    });
    return json(200, { revoked: true });
  }

  return null;
}
