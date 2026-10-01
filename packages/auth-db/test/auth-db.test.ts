import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { AUTH_DB_MIGRATIONS, DEFAULT_ROLE } from "../src/index";

const NOW = "2026-10-02T00:00:00.000Z";

async function userTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

const insertUser = (id: string, role?: string) =>
  role === undefined
    ? env.DB
        .prepare(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'N', ?2, 0, ?3, ?3)`,
        )
        .bind(id, `${id}@example.com`, NOW)
        .run()
    : env.DB
        .prepare(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role") VALUES (?1, 'N', ?2, 0, ?3, ?3, ?4)`,
        )
        .bind(id, `${id}@example.com`, NOW, role)
        .run();

describe("auth-db migrations", () => {
  it("apply cleanly to an empty D1", async () => {
    expect(await userTables(env.DB)).toEqual([]);
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...AUTH_DB_MIGRATIONS]);
    expect(await userTables(env.DB)).toEqual(["account", "session", "user", "verification"]);
  });

  it("re-applying is a no-op", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });
});

describe("roles", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  it("defaults a new user to employee", async () => {
    await insertUser("u-default");
    const row = await env.DB.prepare(`SELECT "role" FROM "user" WHERE "id" = 'u-default'`).first<{ role: string }>();
    expect(row?.role).toBe(DEFAULT_ROLE);
    expect(row?.role).toBe("employee");
  });

  it("accepts owner and employee", async () => {
    await insertUser("u-owner", "owner");
    await insertUser("u-employee", "employee");
  });

  it.each(["user", "admin", "owner,employee", ""])("rejects role %j", async (role) => {
    await expect(insertUser(`u-bad-${role}`, role)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("cascades sessions when a user is deleted", async () => {
    await insertUser("u-cascade");
    await env.DB
      .prepare(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES ('s1', ?1, 'tok', ?1, ?1, 'u-cascade')`,
      )
      .bind(NOW)
      .run();
    await env.DB.prepare(`DELETE FROM "user" WHERE "id" = 'u-cascade'`).run();
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "session"`).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
