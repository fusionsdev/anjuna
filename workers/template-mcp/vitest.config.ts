import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../packages/factory-db/migrations"));
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              main: "./src/index.ts",
              miniflare: {
                compatibilityDate: "2026-08-01",
                compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
                d1Databases: ["FACTORY"],
                r2Buckets: ["ARTIFACTS"],
                durableObjects: { MCP_OBJECT: { className: "TemplateMcp", useSQLite: true } },
                bindings: { MIGRATIONS: migrations, RATE_LIMIT_PER_MINUTE: "1000", SIMILARITY_THRESHOLD: "0.5", OWNER_SECRET: "test-owner-secret", DASHBOARD_URL: "https://app.test" },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
            exclude: ["test/**/*.node.test.ts"],
            fileParallelism: false,
            testTimeout: 30_000,
          },
        },
        {
          // Launches a local browser. The suite skips unless CHROMIUM_EXECUTABLE is set.
          test: {
            name: "chromium",
            environment: "node",
            include: ["test/**/*.node.test.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
            // The default reporter hides a fully skipped file, so the skip reason is logged directly.
            disableConsoleIntercept: true,
          },
        },
      ],
    },
  };
});
