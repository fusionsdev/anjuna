import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Parsed by the same splitter wrangler uses for `d1 migrations apply`.
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    test: {
      projects: [
        {
          // Migrations on a local D1 (workerd via Miniflare).
          plugins: [
            cloudflareTest({
              miniflare: {
                compatibilityDate: "2026-08-01",
                d1Databases: ["DB"],
                bindings: { MIGRATIONS: migrations },
              },
            }),
          ],
          test: { name: "d1", include: ["test/**/*.test.ts"], exclude: ["test/**/*.node.test.ts"] },
        },
        {
          // better-auth's own schema diff, which runs in Node.
          test: { name: "better-auth", environment: "node", include: ["test/**/*.node.test.ts"] },
        },
      ],
    },
  };
});
