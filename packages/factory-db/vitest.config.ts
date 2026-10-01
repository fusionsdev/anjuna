import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Parsed by the same splitter wrangler uses for `d1 migrations apply`.
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
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
