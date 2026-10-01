import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;

export default defineConfig(async () => {
  // Anjuna migrations, parsed by the same splitter wrangler uses for `d1 migrations apply`.
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  // Verbatim V1 sources (fusion_formv_v1@8404ec2 db/) to compare against.
  const v1Schema = await readD1Migrations(path.join(here, "v1"));
  const v1Dir = path.join(here, "v1", "migrations");
  const v1MigrationTexts = Object.fromEntries(
    readdirSync(v1Dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => [f, readFileSync(path.join(v1Dir, f), "utf8")]),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          d1Databases: ["DB", "V1_DB"],
          bindings: {
            MIGRATIONS: migrations,
            V1_SCHEMA: v1Schema,
            V1_MIGRATION_TEXTS: v1MigrationTexts,
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"] },
  };
});
