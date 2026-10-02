import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

let mf: Miniflare;
beforeAll(async () => {
  const example = JSON.parse(readFileSync(path.join(import.meta.dirname, "../example/wrangler.jsonc"), "utf8"));
  const bundled = await build({ entryPoints: [path.join(import.meta.dirname, "integration-worker.ts")], bundle: true, write: false, format: "esm", platform: "browser" });
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0]!.text,
    compatibilityDate: example.compatibility_date, compatibilityFlags: example.compatibility_flags,
    assets: {
      directory: path.join(import.meta.dirname, "../example/public"), binding: "ASSETS",
      run_worker_first: example.assets.run_worker_first,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: example.assets.html_handling, not_found_handling: example.assets.not_found_handling },
    },
    // Any unexpected external request fails locally.
    outboundService: () => { throw new Error("External requests are forbidden in tests"); },
  }));
  await mf.ready;
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

it("asset router bypasses the Worker for public bundles, including navigation requests", async () => {
  for (const headers of [{}, { "sec-fetch-mode": "navigate" }]) {
    const response = await mf.dispatchFetch("https://example.com/_f/assets/example.js", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-runtime-invoked"), JSON.stringify(headers)).toBeNull();
    expect(await response.text()).toContain("Example asset");
  }
});

it("asset router runs the Worker for gated HTML and falls back to uniform 404 on missing assets", async () => {
  const landing = await mf.dispatchFetch("https://example.com/?keyword=quick+cash");
  const body = await landing.text();
  expect(landing.headers.get("x-runtime-invoked"), `${landing.status}: ${body}`).toBe("yes");
  expect(body).toContain("Quick Cash");
  for (const route of ["/index.html", "/_f/index.html", "/_f/assets/missing.js", "/api/postback"]) {
    const response = await mf.dispatchFetch(`https://example.com${route}`);
    expect(response.status).toBe(404);
    expect(await response.text(), route).toBe("Not Found");
  }
});

it("asset router runs www page navigations through the apex redirect", async () => {
  const response = await mf.dispatchFetch("https://www.example.com/request?requested_amount=750&zip=60601", { redirect: "manual" });
  expect(response.status, await response.text()).toBe(301);
  expect(response.headers.get("location")).toBe("https://example.com/request?requested_amount=750&zip=60601");
});
