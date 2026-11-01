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
      { binding: "TEMPLATE_MCP", service: "anjuna-template-mcp", entrypoint: "TemplateImportService" },
    ]);
    expect(wrangler.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
    expect(wrangler.vars.MOCK_CORE).toBe("0");
    expect(JSON.stringify(wrangler).toLowerCase()).not.toContain("leads");
  });

  it("keeps secrets, D1 ids and the dev bypass out of the committed config", () => {
    const text = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
    expect(wrangler.vars.DEV_ACCESS_BYPASS).toBeUndefined();
    expect(text).not.toMatch(/DEV_ACCESS_BYPASS\s*"/);
    for (const d of wrangler.d1_databases) expect(d.database_id).toMatch(/^<.+>$/);
    expect(wrangler.vars.ACCESS_AUD).toBeUndefined();
  });
});

it.each(["wrangler.deploy.aduplift.jsonc", "wrangler.deploy.maimax.jsonc"])("%s never sets DEV_ACCESS_BYPASS", (file) => {
  expect(readFileSync(path.join(root, file), "utf8")).not.toContain("DEV_ACCESS_BYPASS");
});

it.each(["wrangler.deploy.aduplift.jsonc", "wrangler.deploy.maimax.jsonc"])("%s binds the template import service and the artifacts bucket", (file) => {
  const config = JSON.parse(stripComments(readFileSync(path.join(root, file), "utf8")));
  expect(config.services).toContainEqual({ binding: "TEMPLATE_MCP", service: "anjuna-template-mcp", entrypoint: "TemplateImportService" });
  expect(config.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
});

describe("styles.css", () => {
  const css = readFileSync(path.join(root, "src/client/styles.css"), "utf8");

  it("ends with the reduced-motion block, after every animated rule", () => {
    const reduced = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toBeGreaterThan(-1);
    expect(reduced).toBeGreaterThan(css.indexOf(".spinner-ring {"));
    expect(css.slice(reduced)).toContain(".spinner-ring { animation: none; }");
    // The last animation declaration outside the block sits before it: the block's end is matched by braces.
    let depth = 0;
    let end = css.length;
    for (let i = css.indexOf("{", reduced); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && (depth -= 1) === 0) { end = i + 1; break; }
    }
    const outside = css.slice(0, reduced) + css.slice(end);
    const lastAnimation = [...outside.matchAll(/animation(?:-[a-z-]+)?\s*:/g)].at(-1)?.index ?? -1;
    expect(lastAnimation).toBeGreaterThan(-1);
    expect(lastAnimation).toBeLessThan(reduced);
  });

  it("left-aligns the text cells of a DataTable over the right-aligned .tw cells", () => {
    expect(css).toContain(".data-table td:not(.num), .data-table th:not(.num) { text-align: left; }");
    expect(css).toMatch(/\.tw th \{[^}]*text-align: right/);
  });

  it("makes the DataTable wrapper the vertical scroll box so the sticky header sticks", () => {
    expect(css).toContain(".data-table { max-height: 70vh; overflow: auto; }");
    expect(css).toContain(".data-table thead th { position: sticky; top: 0;");
  });
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

  it("loads no external font and uses absolute asset paths for deep links", async () => {
    await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent" });
    const out = path.join(root, "dist/client");
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).toMatch(/src="\/assets\/[^"]+\.js"/);
    const fonts = readdirSync(path.join(out, "assets")).filter((f) => f.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
  });
});
