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
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          d1Databases: ["FACTORY"],
          r2Buckets: ["ARTIFACTS"],
          bindings: {
            MIGRATIONS: migrations,
            CF_ACCOUNT_ID: "test-account-id",
            CF_API_TOKEN: "test-token",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000 },
  };
});
