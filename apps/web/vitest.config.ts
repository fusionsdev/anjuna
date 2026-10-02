import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const authMigrations = await readD1Migrations(path.join(import.meta.dirname, "../../packages/auth-db/migrations"));
  const factoryMigrations = await readD1Migrations(path.join(import.meta.dirname, "../../packages/factory-db/migrations"));
  return {
    test: {
      projects: [
        {
          // The Worker on a local D1 pair (workerd via Miniflare).
          plugins: [
            cloudflareTest({
              miniflare: {
                compatibilityDate: "2026-08-01",
                compatibilityFlags: ["nodejs_compat"],
                d1Databases: ["AUTH", "FACTORY"],
                bindings: { AUTH_MIGRATIONS: authMigrations, FACTORY_MIGRATIONS: factoryMigrations },
              },
            }),
          ],
          test: { name: "worker", include: ["test/**/*.test.ts"], exclude: ["test/**/*.node.test.ts"] },
        },
        {
          // Config checks and the SPA build run in Node.
          test: { name: "build", environment: "node", include: ["test/**/*.node.test.ts"], testTimeout: 120_000 },
        },
      ],
    },
  };
});
