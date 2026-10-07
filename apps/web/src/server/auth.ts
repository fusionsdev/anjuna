/**
 * better-auth on the AUTH D1: email + password, admin plugin with `defaultRole: "employee"` and
 * `adminRoles: ["owner"]`. Sign-up is closed: users are seeded or created by an owner.
 */
import { ADMIN_ROLES, DEFAULT_ROLE } from "@anjuna/auth-db";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";
import { writePanelAudit } from "./audit.js";
import type { Env } from "./env.js";

const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole({ ...adminAc.statements }),
  employee: ac.newRole({ ...userAc.statements }),
};

function localDevOrigins(baseURL: string): string[] {
  const host = new URL(baseURL).host;
  return ["http://127.0.0.1:*", "http://localhost:*", `http://${host}`];
}

export function createAuth(env: Env) {
  return betterAuth({
    database: env.AUTH,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: env.DEV_ACCESS_BYPASS === "1" ? localDevOrigins(env.BETTER_AUTH_URL) : [],
    advanced: env.DEV_ACCESS_BYPASS === "1" ? { useSecureCookies: false } : undefined,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8 },
    plugins: [admin({ ac, roles, defaultRole: DEFAULT_ROLE, adminRoles: [...ADMIN_ROLES] })],
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const user = await env.AUTH.prepare(`SELECT "role" FROM "user" WHERE "id" = ?1`)
              .bind(session.userId)
              .first<{ role: "owner" | "employee" }>();
            await writePanelAudit(env.FACTORY, {
              actor_id: session.userId,
              actor_role: user?.role ?? "employee",
              action: "auth.sign_in",
              entity_type: "user",
              entity_id: session.userId,
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
