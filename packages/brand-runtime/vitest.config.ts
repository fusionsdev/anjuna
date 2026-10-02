import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";

const example = JSON.parse(readFileSync(path.join(import.meta.dirname, "example/wrangler.jsonc"), "utf8"));

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./test/integration-worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["global_fetch_strictly_public"],
      assets: {
        directory: "./example/public", binding: "ASSETS", run_worker_first: example.assets.run_worker_first,
        routerConfig: { has_user_worker: true },
        assetConfig: { html_handling: example.assets.html_handling, not_found_handling: example.assets.not_found_handling },
      },
    },
  })],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/*.node.test.ts"] },
});
