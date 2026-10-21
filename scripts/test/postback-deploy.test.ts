import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
type Step = { name?: string; run?: string; env?: Record<string, string> };

describe("global postback token deploy", () => {
  const workflow = parseDocument(readFileSync(new URL(".github/workflows/deploy.yml", root), "utf8")).toJS() as {
    jobs: Record<string, { steps: Step[] }>;
  };
  it.each([
    ["aduplift", "POSTBACK_TOKEN", "workers/core/wrangler.deploy.aduplift.jsonc"],
    ["maimax", "MAIMAX_POSTBACK_TOKEN", "workers/core/wrangler.deploy.maimax.jsonc"],
  ])("%s sets POSTBACK_TOKEN from its own secret and skips when empty", (tenant, secret, config) => {
    const step = workflow.jobs[`deploy-${tenant}`]!.steps.find((s) => s.name === `Set postback token (${tenant})`);
    expect(step, tenant).toBeDefined();
    expect(step!.env).toEqual({ POSTBACK_TOKEN: `\${{ secrets.${secret} }}` });
    expect(step!.run).toContain('[ -z "$POSTBACK_TOKEN" ] && echo "');
    expect(step!.run).toContain(`printf '%s' "$POSTBACK_TOKEN" | bun x wrangler secret put POSTBACK_TOKEN --config ${config}`);
    const names = workflow.jobs[`deploy-${tenant}`]!.steps.map((s) => s.name);
    expect(names.indexOf(`Set postback token (${tenant})`)).toBeLessThan(names.indexOf(`Smoke test core (${tenant})`));
  });
});
