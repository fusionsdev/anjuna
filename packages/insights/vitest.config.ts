import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The insights package only reads the `leads` D1 schema (owned by packages/leads-db).
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../leads-db/migrations"));
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          d1Databases: ["DB"],
          bindings: { MIGRATIONS: migrations },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"] },
  };
});