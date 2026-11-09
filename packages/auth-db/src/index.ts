/**
 * `auth` D1 schema: better-auth core tables + the admin plugin, restricted to two roles.
 * The SQL in `../migrations` is the source of truth (wrangler D1 migration format).
 *
 * Configure better-auth's admin plugin to match the CHECK constraint on "user"."role":
 *   admin({ defaultRole: DEFAULT_ROLE, adminRoles: [...ADMIN_ROLES], ac, roles: { owner, employee } })
 */

export const AUTH_DB_MIGRATIONS = ["0001_better_auth.sql", "0002_user_prefs.sql"] as const;

export const AUTH_ROLES = ["owner", "employee"] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

/** Role given to a new user. */
export const DEFAULT_ROLE: AuthRole = "employee";

/** Roles better-auth's admin plugin treats as administrators. */
export const ADMIN_ROLES: readonly AuthRole[] = ["owner"];

export function isAuthRole(value: unknown): value is AuthRole {
  return typeof value === "string" && (AUTH_ROLES as readonly string[]).includes(value);
}
