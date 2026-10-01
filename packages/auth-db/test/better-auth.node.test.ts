import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

const migrationsDir = path.join(import.meta.dirname, "..", "migrations");

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return db;
}

describe("better-auth schema conformance", () => {
  it("better-auth (core + admin plugin) finds nothing to create or add", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations({
      database: migratedDatabase(),
      plugins: [admin()],
    });
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });

  it("an empty database would need exactly the four tables this package creates", async () => {
    const { toBeCreated } = await getMigrations({
      database: new DatabaseSync(":memory:"),
      plugins: [admin()],
    });
    expect(toBeCreated.map((t) => t.table).sort()).toEqual(["account", "session", "user", "verification"]);
  });
});
