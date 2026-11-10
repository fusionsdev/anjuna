import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBrandClean } from "@anjuna/contracts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("factory bundle", () => {
  it("builds a single ESM Worker whose served responses carry no system identifiers", async () => {
    execSync("bun run bundle", { cwd: join(__dirname, "..") });
    const bytes = readFileSync(join(__dirname, "..", "dist", "brand-runtime.js"), "utf8");
    expect(bytes).toMatch(/export\s*\{/);
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: bytes,
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["global_fetch_strictly_public"],
      bindings: {
        CORE_TOKEN: "t",
        BRAND_CONFIG: { brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A",
          formRoute: "/request", amount_buckets: [500, 750, 1000] },
      },
      serviceBindings: {
        ASSETS: async (request) => new URL(request.url).pathname === "/index.html"
          ? new Response('<h1 data-kw>Default Heading</h1>', { headers: { "content-type": "text/html" } })
          : new Response("private asset error", { status: 404 }),
        CORE: async () => Response.json({ error: "not used" }, { status: 503 }),
      },
      outboundService: () => { throw new Error("External requests are forbidden in tests"); },
    }));
    try {
      const landing = await mf.dispatchFetch("https://brand-a.example/?keyword=quick+cash");
      expect(landing.status).toBe(200);
      // The H1 slot holds the brand name; the URL keyword is never written into the page.
      const landingHtml = await landing.text();
      expect(landingHtml).toContain("<h1 data-kw>Brand A</h1>");
      expect(landingHtml).not.toMatch(/quick cash/i);
      for (const keyword of ["Anjuna", "AURUM"]) {
        const response = await mf.dispatchFetch(`https://brand-a.example/?keyword=${keyword}`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("<h1 data-kw>Brand A</h1>");
        expect(isBrandClean(html)).toBe(true);
      }
      for (const path of ["/index.html", "/_f/index.html", "/_f/assets/missing.js", "/unknown"]) {
        const response = await mf.dispatchFetch(`https://brand-a.example${path}`);
        expect(response.status, path).toBe(404);
        expect(await response.text(), path).toBe("Not Found");
      }
    } finally { await mf.dispose(); }
  }, 30_000);
});
