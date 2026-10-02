import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../packages/factory-db/migrations"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
          d1Databases: ["FACTORY"],
          durableObjects: { MCP_OBJECT: { className: "TemplateMcp", useSQLite: true } },
          bindings: { MIGRATIONS: migrations, RATE_LIMIT_PER_MINUTE: "1000", SIMILARITY_THRESHOLD: "0.5" },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000 },
  };
});
