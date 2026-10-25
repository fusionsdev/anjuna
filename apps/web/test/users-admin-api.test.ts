import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/server/index";
import type { Auth } from "../src/server/auth.js";
import { handleUsersAdminRoute } from "../src/server/users-admin.js";
import { ORIGIN, PASSWORD, call, makeEnv, resetState, sessions, setupDatabases, signIn } from "./helpers";

let owner: string;
let employee: string;
let seq = 0;

beforeAll(async () => {
  await setupDatabases();
});

beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const me = async (cookie: string): Promise<string> =>
  ((await (await call("/api/me", { cookie })).json()) as { user: { id: string } }).user.id;

async function freshUser(role = "employee"): Promise<{ id: string; email: string }> {
  const email = `t9-${++seq}@example.test`;
  const res = await call("/api/users", { cookie: owner, method: "POST", body: { email, name: `T9 ${seq}`, password: PASSWORD, role } });
  expect(res.status).toBe(201);
  const { user } = (await res.json()) as { user: { id: string } };
  return { id: user.id, email };
}

async function fullAudit(): Promise<{ action: string; entity_id: string; before_json: string | null; after_json: string | null }[]> {
  const { results } = await env.FACTORY.prepare(
    "SELECT action, entity_id, before_json, after_json FROM audit_log ORDER BY id",
  ).all<{ action: string; entity_id: string; before_json: string | null; after_json: string | null }>();
  return results;
}

describe("users admin routes", () => {
  it("an employee gets 403 on every user admin route", async () => {
    const { id } = await freshUser();
    const routes: Array<[string, Parameters<typeof call>[1]]> = [
      [`/api/users/${id}/ban`, { cookie: employee, method: "POST", body: { reason: "x" } }],
      [`/api/users/${id}/unban`, { cookie: employee, method: "POST" }],
      [`/api/users/${id}/password`, { cookie: employee, method: "POST", body: { password: "new-password-456" } }],
      [`/api/users/${id}`, { cookie: employee, method: "DELETE" }],
      [`/api/users/${id}/sessions`, { cookie: employee }],
      [`/api/users/${id}/sessions`, { cookie: employee, method: "DELETE" }],
      [`/api/users/${id}/sessions/sess_nope`, { cookie: employee, method: "DELETE" }],
    ];
    for (const [path, init] of routes) {
      const res = await call(path, init);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    }
  });

  it("ban blocks sign-in and ends the banned user's session", async () => {
    const { id, email } = await freshUser();
    const cookie = await signIn(email);
    expect((await call("/api/me", { cookie })).status).toBe(200);
    const ban = await call(`/api/users/${id}/ban`, { cookie: owner, method: "POST", body: { reason: "spam" } });
    expect(ban.status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(401);
    const retry = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
    expect(retry.status).toBe(403);
  });

  it("unban lets the user sign in again", async () => {
    const { id, email } = await freshUser();
    expect((await call(`/api/users/${id}/ban`, { cookie: owner, method: "POST", body: {} })).status).toBe(200);
    expect((await call(`/api/users/${id}/unban`, { cookie: owner, method: "POST" })).status).toBe(200);
    const cookie = await signIn(email);
    expect((await call("/api/me", { cookie })).status).toBe(200);
  });

  it("ban, delete and password reset on yourself answer 422 with no change", async () => {
    const ownerId = await me(owner);
    const auditBefore = (await fullAudit()).length;
    expect((await call(`/api/users/${ownerId}/ban`, { cookie: owner, method: "POST", body: { reason: "self" } })).status).toBe(422);
    expect((await call(`/api/users/${ownerId}`, { cookie: owner, method: "DELETE" })).status).toBe(422);
    expect((await call(`/api/users/${ownerId}/password`, { cookie: owner, method: "POST", body: { password: "new-password-456" } })).status).toBe(422);
    expect((await call("/api/me", { cookie: owner })).status).toBe(200);
    const row = await env.AUTH.prepare(`SELECT "role", "banned" FROM "user" WHERE "id" = ?1`).bind(ownerId).first<{ role: string; banned: number | null }>();
    expect(row).toMatchObject({ role: "owner", banned: null });
    const again = await signIn("owner@example.test");
    expect((await call("/api/me", { cookie: again })).status).toBe(200);

    // Zero better-auth calls: the route is invoked directly with spying stubs,
    // so any banUser/removeUser/setUserPassword/revokeUserSessions call would show up here.
    const api = { banUser: vi.fn(), removeUser: vi.fn(), setUserPassword: vi.fn(), revokeUserSessions: vi.fn() };
    const auth = { api } as unknown as Auth;
    const ctx = { actor_id: ownerId, actor_role: "owner" as const, request_id: "req_self_spy" };
    const direct = async (path: string, method: string) =>
      handleUsersAdminRoute(
        new Request(`https://app.test${path}`, { method, headers: { cookie: owner } }),
        { AUTH: env.AUTH, FACTORY: env.FACTORY } as never,
        path,
        ctx,
        auth,
      );
    expect((await direct(`/api/users/${ownerId}/ban`, "POST"))?.status).toBe(422);
    expect((await direct(`/api/users/${ownerId}`, "DELETE"))?.status).toBe(422);
    expect((await direct(`/api/users/${ownerId}/password`, "POST"))?.status).toBe(422);
    expect(api.banUser).not.toHaveBeenCalled();
    expect(api.removeUser).not.toHaveBeenCalled();
    expect(api.setUserPassword).not.toHaveBeenCalled();
    expect(api.revokeUserSessions).not.toHaveBeenCalled();
    expect((await fullAudit()).length).toBe(auditBefore + 1);
    expect((await fullAudit()).slice(auditBefore).every((r) => !r.action.startsWith("user."))).toBe(true);
  });

  it("ban with an unreadable body answers 422 with no change; an empty body still bans", async () => {
    const { id, email } = await freshUser();
    const cookie = await signIn(email);
    const auditBefore = (await fullAudit()).length;
    const raw = await worker.fetch(
      new Request(`${ORIGIN}/api/users/${id}/ban`, {
        method: "POST",
        headers: { cookie: owner, origin: ORIGIN, "content-type": "application/json" },
        body: "{not json",
      }),
      makeEnv(),
    );
    expect(raw.status).toBe(422);
    expect(await raw.json()).toMatchObject({ error: "invalid" });
    // Account and sessions unchanged, no audit row.
    expect((await call("/api/me", { cookie })).status).toBe(200);
    const row = await env.AUTH.prepare(`SELECT "banned" FROM "user" WHERE "id" = ?1`).bind(id).first<{ banned: number | null }>();
    expect(row!.banned).toBeFalsy();
    expect((await fullAudit()).length).toBe(auditBefore);
    // An empty body stays allowed for ban.
    const empty = await worker.fetch(
      new Request(`${ORIGIN}/api/users/${id}/ban`, { method: "POST", headers: { cookie: owner, origin: ORIGIN } }),
      makeEnv(),
    );
    expect(empty.status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(401);
  });

  it("revoking your own sessions is allowed", async () => {
    const ownerId = await me(owner);
    const res = await call(`/api/users/${ownerId}/sessions`, { cookie: owner, method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await call("/api/me", { cookie: owner })).status).toBe(401);
  });

  it("password reset changes the password and revokes the user's sessions", async () => {
    const { id, email } = await freshUser();
    const cookie = await signIn(email);
    const bad = await call(`/api/users/${id}/password`, { cookie: owner, method: "POST", body: { password: "short7!" } });
    expect(bad.status).toBe(422);
    const res = await call(`/api/users/${id}/password`, { cookie: owner, method: "POST", body: { password: "new-password-456" } });
    expect(res.status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(401);
    expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } })).status).toBe(401);
    const fresh = await signIn(email, "new-password-456");
    expect((await call("/api/me", { cookie: fresh })).status).toBe(200);
  });

  it("delete removes the user and their sessions", async () => {
    const { id, email } = await freshUser();
    const cookie = await signIn(email);
    const res = await call(`/api/users/${id}`, { cookie: owner, method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(401);
    const list = (await (await call("/api/users", { cookie: owner })).json()) as { users: { email: string }[] };
    expect(list.users.map((u) => u.email)).not.toContain(email);
    expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } })).status).toBe(401);
  });

  it("sessions list never returns a token", async () => {
    const { id, email } = await freshUser();
    await signIn(email);
    await signIn(email);
    const list = await call(`/api/users/${id}/sessions`, { cookie: owner });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain("token");
    const body = JSON.parse(text) as { sessions: Record<string, unknown>[] };
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of body.sessions) {
      expect(Object.keys(s).sort()).toEqual(["created_at", "expires_at", "id", "ip_address", "user_agent"]);
    }
  });

  it("revoking one session of another user answers 404", async () => {
    const a = await freshUser();
    const b = await freshUser();
    const cookieB = await signIn(b.email);
    const list = (await (await call(`/api/users/${b.id}/sessions`, { cookie: owner })).json()) as { sessions: { id: string }[] };
    expect(list.sessions.length).toBeGreaterThanOrEqual(1);
    const res = await call(`/api/users/${a.id}/sessions/${list.sessions[0]!.id}`, { cookie: owner, method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await call("/api/me", { cookie: cookieB })).status).toBe(200);
  });

  it("revoking one session ends only that session", async () => {
    const { id, email } = await freshUser();
    const c1 = await signIn(email);
    const c2 = await signIn(email);
    const list = (await (await call(`/api/users/${id}/sessions`, { cookie: owner })).json()) as { sessions: { id: string }[] };
    expect(list.sessions.length).toBeGreaterThanOrEqual(2);
    const res = await call(`/api/users/${id}/sessions/${list.sessions[0]!.id}`, { cookie: owner, method: "DELETE" });
    expect(res.status).toBe(200);
    // Exactly one of the two sessions is gone; the other still works.
    const statuses = [(await call("/api/me", { cookie: c1 })).status, (await call("/api/me", { cookie: c2 })).status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("revoke all ends every session of the user", async () => {
    const { email, id } = await freshUser();
    const c1 = await signIn(email);
    const c2 = await signIn(email);
    const res = await call(`/api/users/${id}/sessions`, { cookie: owner, method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await call("/api/me", { cookie: c1 })).status).toBe(401);
    expect((await call("/api/me", { cookie: c2 })).status).toBe(401);
  });

  it("each write writes one audit row with the right action and no password", async () => {
    const { id, email } = await freshUser();
    const before = (await fullAudit()).length;
    expect((await call(`/api/users/${id}/ban`, { cookie: owner, method: "POST", body: { reason: "audit-check" } })).status).toBe(200);
    expect((await call(`/api/users/${id}/unban`, { cookie: owner, method: "POST" })).status).toBe(200);
    expect((await call(`/api/users/${id}/password`, { cookie: owner, method: "POST", body: { password: "audit-pass-789" } })).status).toBe(200);
    const cookie = await signIn(email, "audit-pass-789");
    const sid = ((await (await call(`/api/users/${id}/sessions`, { cookie: owner })).json()) as { sessions: { id: string }[] }).sessions.find((s) => s.id)?.id;
    const auditBeforeGet = (await fullAudit()).length;
    expect((await call(`/api/users/${id}/sessions`, { cookie: owner })).status).toBe(200);
    expect((await fullAudit()).length).toBe(auditBeforeGet);
    expect((await call(`/api/users/${id}/sessions/${sid}`, { cookie: owner, method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/users/${id}/sessions`, { cookie: owner, method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/users/${id}`, { cookie: owner, method: "DELETE" })).status).toBe(200);
    expect((await call("/api/me", { cookie })).status).toBe(401);

    // The sign-in between the writes adds its own auth.sign_in row; scope to user.* rows.
    const rows = (await fullAudit()).slice(before).filter((r) => r.action.startsWith("user."));
    expect(rows.map((r) => r.action)).toEqual([
      "user.ban",
      "user.unban",
      "user.reset_password",
      "user.revoke_session",
      "user.revoke_sessions",
      "user.delete",
    ]);
    expect(rows.every((r) => r.entity_id === id)).toBe(true);
    expect(JSON.parse(rows[0]!.after_json!)).toEqual({ reason: "audit-check" });
    expect(rows[2]!.before_json).toBeNull();
    expect(rows[2]!.after_json).toBeNull();
    expect(JSON.parse(rows[3]!.after_json!)).toEqual({ session_id: sid });
    expect(JSON.parse(rows[5]!.before_json!)).toEqual({ email, role: "employee" });
    for (const r of rows) {
      expect(`${r.before_json ?? ""}${r.after_json ?? ""}`.toLowerCase()).not.toContain("audit-pass-789");
    }
  });

  it("an unknown user id answers 404", async () => {
    const nope = "usr_no_such_user";
    expect((await call(`/api/users/${nope}/ban`, { cookie: owner, method: "POST", body: {} })).status).toBe(404);
    expect((await call(`/api/users/${nope}/unban`, { cookie: owner, method: "POST" })).status).toBe(404);
    expect((await call(`/api/users/${nope}/password`, { cookie: owner, method: "POST", body: { password: "new-password-456" } })).status).toBe(404);
    expect((await call(`/api/users/${nope}`, { cookie: owner, method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/users/${nope}/sessions`, { cookie: owner })).status).toBe(404);
    expect((await call(`/api/users/${nope}/sessions`, { cookie: owner, method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/users/${nope}/sessions/sess_nope`, { cookie: owner, method: "DELETE" })).status).toBe(404);
  });

  it("revoking an unknown session of a known user answers 404", async () => {
    const { id } = await freshUser();
    expect((await call(`/api/users/${id}/sessions/sess_nope`, { cookie: owner, method: "DELETE" })).status).toBe(404);
  });
});
