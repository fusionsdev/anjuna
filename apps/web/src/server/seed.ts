/**
 * Seed users for a tenant: 1 owner + 2 employees. Pure functions shared by `scripts/seed.ts`
 * (writes a gitignored SQL file for `wrangler d1 execute`) and the tests (insert into a local D1).
 * Emails and passwords come from the environment or a gitignored file, never from git.
 */
import { AUTH_ROLES, type AuthRole } from "@anjuna/auth-db";
import { hashPassword } from "better-auth/crypto";

export interface SeedUser {
  email: string;
  name: string;
  role: AuthRole;
  password: string;
}

export interface SeedStatement {
  sql: string;
  params: (string | number)[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stable id per email, so re-running the seed is a no-op (INSERT OR IGNORE). Fits the actor_id pattern. */
export async function seedUserId(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `usr_${hex.slice(0, 20)}`;
}

export function validateSeedUsers(users: readonly SeedUser[]): void {
  const owners = users.filter((u) => u.role === "owner").length;
  const employees = users.filter((u) => u.role === "employee").length;
  if (owners !== 1 || employees !== 2) throw new Error(`Seed needs 1 owner and 2 employees, got ${owners} and ${employees}`);
  const seen = new Set<string>();
  for (const u of users) {
    if (!EMAIL.test(u.email)) throw new Error(`Invalid seed email: ${u.email}`);
    if (!(AUTH_ROLES as readonly string[]).includes(u.role)) throw new Error(`Invalid role: ${u.role}`);
    if (u.password.length < 8) throw new Error("Seed passwords need at least 8 characters");
    const key = u.email.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate seed email: ${u.email}`);
    seen.add(key);
  }
}

export async function buildSeedStatements(users: readonly SeedUser[], now = new Date()): Promise<SeedStatement[]> {
  validateSeedUsers(users);
  const ts = now.toISOString();
  const out: SeedStatement[] = [];
  for (const u of users) {
    const id = await seedUserId(u.email);
    out.push({
      sql: `INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role") VALUES (?, ?, ?, 1, ?, ?, ?)`,
      params: [id, u.name, u.email.toLowerCase(), ts, ts, u.role],
    });
    out.push({
      sql: `INSERT OR IGNORE INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      params: [`acc_${id}`, id, id, await hashPassword(u.password), ts, ts],
    });
  }
  return out;
}

export async function seedD1(db: D1Database, users: readonly SeedUser[]): Promise<void> {
  const stmts = await buildSeedStatements(users);
  await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
}

const lit = (v: string | number): string => (typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);

/** Renders statements as a SQL file for `wrangler d1 execute AUTH --file`. Contains password hashes: keep it out of git. */
export function renderSql(stmts: readonly SeedStatement[]): string {
  return (
    stmts
      .map((s) => {
        let i = 0;
        return s.sql.replace(/\?/g, () => lit(s.params[i++]!));
      })
      .join(";\n") + ";\n"
  );
}
