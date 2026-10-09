import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'zip_lookup'",
  ).all();
  expect(tables.results).toEqual([]);
  await applyD1Migrations(env.DB, env.MIGRATIONS);
});

describe("ZIP lookup seed", () => {
  it("seeds exactly 42,632 ZIPs on an empty D1", async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM zip_lookup").first();
    expect(row).toEqual({ count: 42_632 });
  });

  it.each([
    ["42411", "Fredonia", "KY"],
    ["10001", "New York", "NY"],
    ["97003", "Beaverton", "OR"],
    ["90210", "Beverly Hills", "CA"],
  ])("resolves %s to %s, %s", async (zip, city, state) => {
    const row = await env.DB.prepare("SELECT city, state FROM zip_lookup WHERE zip = ?")
      .bind(zip)
      .first();
    expect(row).toEqual({ city, state });
  });

  it("uses only INSERT OR IGNORE with the original 500-row batches", () => {
    const seed = env.MIGRATIONS.find((migration) => migration.name === "0010_zip_lookup_seed.sql");
    expect(seed).toBeDefined();
    expect(seed!.queries).toHaveLength(86);
    for (const [index, query] of seed!.queries.entries()) {
      const sql = query.replace(/--[^\n]*/g, "").trim();
      expect(sql).toMatch(/^INSERT OR IGNORE INTO zip_lookup \(zip, city, state\) VALUES /);
      expect([...sql.matchAll(/\('\d{5}',/g)]).toHaveLength(index === 85 ? 132 : 500);
    }
  });

  it("preserves an existing tenant ZIP when its seed batch is replayed", async () => {
    const seed = env.MIGRATIONS.find((migration) => migration.name === "0010_zip_lookup_seed.sql");
    const query = seed?.queries.find((sql) => sql.includes("('42411','Fredonia','KY')"));
    expect(query).toBeDefined();
    await env.DB.prepare("UPDATE zip_lookup SET city = 'Existing tenant city' WHERE zip = '42411'").run();
    try {
      await env.DB.prepare(query!).run();
      const row = await env.DB.prepare("SELECT city, state FROM zip_lookup WHERE zip = '42411'").first();
      expect(row).toEqual({ city: "Existing tenant city", state: "KY" });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM zip_lookup").first()).toEqual({
        count: 42_632,
      });
    } finally {
      await env.DB.prepare("UPDATE zip_lookup SET city = 'Fredonia' WHERE zip = '42411'").run();
    }
  });
});
