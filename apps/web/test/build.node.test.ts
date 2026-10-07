import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const wrangler = JSON.parse(stripComments(readFileSync(path.join(root, "wrangler.jsonc"), "utf8")));

describe("wrangler.jsonc", () => {
  it("is the anjuna-web Worker on app.aduplift.ai, not reachable any other way", () => {
    expect(wrangler.name).toBe("anjuna-web");
    expect(wrangler.account_id).toBe("6cb8500c35210800451bd9a535482850");
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.routes).toEqual([{ pattern: "app.aduplift.ai", custom_domain: true }]);
    expect(wrangler.compatibility_flags).toContain("global_fetch_strictly_public");
  });

  it("serves the SPA as assets with run_worker_first", () => {
    expect(wrangler.assets).toMatchObject({ binding: "ASSETS", run_worker_first: true, directory: "./dist/client" });
  });

  it("binds AUTH and FACTORY, never the leads D1; CORE only once mock core is off", () => {
    expect(wrangler.d1_databases.map((d: { binding: string }) => d.binding).sort()).toEqual(["AUTH", "FACTORY"]);
    expect(wrangler.services).toEqual([
      { binding: "CORE", service: "anjuna-core", entrypoint: "AdminService" },
      { binding: "CORE_LIFECYCLE", service: "anjuna-core", entrypoint: "PanelLifecycleService" },
      { binding: "FACTORY_WORKER", service: "anjuna-factory" },
    ]);
    expect(wrangler.vars.MOCK_CORE).toBe("0");
    expect(JSON.stringify(wrangler).toLowerCase()).not.toContain("leads");
  });

  it("keeps secrets, D1 ids and the dev bypass out of the committed config", () => {
    const text = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
    expect(wrangler.vars.DEV_ACCESS_BYPASS).toBeUndefined();
    expect(text).not.toMatch(/DEV_ACCESS_BYPASS\s*"/);
    for (const d of wrangler.d1_databases) expect(d.database_id).toMatch(/^<.+>$/);
    // Access team domain and AUD are not secrets; they must be the real AdUplift values.
    expect(wrangler.vars.ACCESS_TEAM_DOMAIN).toBe("aduplift.cloudflareaccess.com");
    expect(wrangler.vars.ACCESS_AUD).toMatch(/^[0-9a-f]{64}$/);
  });
});

it.each(["wrangler.deploy.aduplift.jsonc", "wrangler.deploy.maimax.jsonc"])("%s never sets DEV_ACCESS_BYPASS", (file) => {
  expect(readFileSync(path.join(root, file), "utf8")).not.toContain("DEV_ACCESS_BYPASS");
});

describe("SPA build", () => {
  it("vite build emits index.html and bundled assets into dist/client", async () => {
    await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent" });
    const out = path.join(root, "dist/client");
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain('<div id="root">');
    expect(readdirSync(path.join(out, "assets")).some((f) => f.endsWith(".js"))).toBe(true);
    expect(existsSync(path.join(out, "assets"))).toBe(true);
  });
});
