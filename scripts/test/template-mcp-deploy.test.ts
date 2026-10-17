import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import aduplift from "@anjuna/tenants/aduplift.config";
import maimax from "@anjuna/tenants/maimax.config";

const root = new URL("../../", import.meta.url);
const stripComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "");
const mcpConfig = (file: string) => JSON.parse(stripComments(readFileSync(new URL(`workers/template-mcp/${file}`, root), "utf8")));
const tenants = [
  { tenant: aduplift, file: "wrangler.jsonc" },
  { tenant: maimax, file: "wrangler.maimax.jsonc" },
];

describe("template MCP per tenant (no deployment)", () => {
  it.each(tenants)("$file targets its own account, factory D1 and domain", ({ tenant, file }) => {
    const config = mcpConfig(file);
    expect(config.name).toBe("anjuna-template-mcp");
    expect(config.account_id).toBe(tenant.accountId);
    expect(config.d1_databases).toEqual([expect.objectContaining({ binding: "FACTORY", database_name: `${tenant.name}-factory`, database_id: tenant.d1!.factory })]);
    expect(config.routes).toEqual([{ pattern: tenant.appDomain.replace(/^app\./, "mcp."), custom_domain: true }]);
    expect(config.vars.DASHBOARD_URL).toBe(`https://${tenant.appDomain}`);
    expect(config.workers_dev).toBe(false);
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
    expect(config.durable_objects.bindings).toEqual([{ name: "MCP_OBJECT", class_name: "TemplateMcp" }]);
    expect(config.r2_buckets).toEqual([{ binding: "ARTIFACTS", bucket_name: "anjuna-artifacts" }]);
  });

  it("deploys the template MCP after migrations and before the web Worker in both tenant jobs", () => {
    const workflow = parseDocument(readFileSync(new URL(".github/workflows/deploy.yml", root), "utf8")).toJS() as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    for (const [tenant, file, host] of [["aduplift", "wrangler.jsonc", "mcp.aduplift.ai"], ["maimax", "wrangler.maimax.jsonc", "mcp.maimax.com"]] as const) {
      const steps = workflow.jobs[`deploy-${tenant}`]!.steps;
      const names = steps.map((step) => step.name);
      const deploy = names.indexOf(`Deploy template MCP (${tenant})`);
      expect(deploy, tenant).toBeGreaterThan(names.indexOf(`Apply D1 migrations (${tenant})`));
      expect(deploy, tenant).toBeLessThan(names.indexOf(`Deploy web (${tenant})`));
      expect(steps[deploy]!.run?.trim()).toBe(`bun x wrangler deploy --config workers/template-mcp/${file}`);
      expect(steps[names.indexOf(`Smoke test template MCP (${tenant})`)]?.run).toContain(`https://${host}/health`);
    }
  });
});
