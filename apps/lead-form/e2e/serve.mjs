import { createRequire } from "node:module";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Reuse the runtime's installed local test tooling; no credentials or remote services.
const require = createRequire(new URL("../../../packages/brand-runtime/package.json", import.meta.url));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const root = fileURLToPath(new URL("../", import.meta.url));
const assets = path.join(root, ".e2e/public");
await mkdir(assets, { recursive: true });
await cp(path.join(root, "dist"), path.join(assets, "_f"), { recursive: true });
await writeFile(path.join(assets, "index.html"), `<!doctype html><html><body>
<h1 data-kw>Example Loans</h1><form data-cta action="/go">
<select name="requested_amount"><option value="3250">3250</option></select>
<input name="zip"><button type="submit">Continue</button></form></body></html>`);
const bundled = await build({
  entryPoints: [path.join(root, "e2e/local-worker.ts")], bundle: true,
  write: false, format: "esm", platform: "browser",
});
const mf = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1", port: Number(process.env.E2E_PORT ?? 8799),
  modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: "2026-08-01", compatibilityFlags: ["global_fetch_strictly_public"],
  assets: { directory: assets, binding: "ASSETS", run_worker_first: true,
    routerConfig: { has_user_worker: true },
    assetConfig: { html_handling: "none", not_found_handling: "none" } },
  outboundService: () => { throw new Error("External requests are forbidden in E2E"); },
}));
console.log(`E2E ready: ${await mf.ready}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await mf.dispose(); process.exit(0); });
}
