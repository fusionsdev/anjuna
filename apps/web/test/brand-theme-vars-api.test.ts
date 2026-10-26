import { env } from "cloudflare:workers";
import { BrandThemeVarsResponse } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-26T00:00:00.000Z";
const TEMPLATE_MAP = { primary: ["--color-royal"], primary_dark: [], secondary: ["--color-navy"] };
const DEPLOYED_MAP = { primary: ["--old-brand"], primary_dark: [], secondary: [] };
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-tv', 'Theme Vars', 'react_spa', 'bk_1', ?1)").bind(NOW),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
      VALUES ('tv-tv-mapped', 'tpl-tv', 1, ?1, 'templates/tpl-tv/a.zip', 'sealed', 'owner', ?2, 'bk_1', ?2, ?3)`).bind("e".repeat(64), NOW, JSON.stringify(TEMPLATE_MAP)),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at)
      VALUES ('tv-tv-bare', 'tpl-tv', 2, ?1, 'templates/tpl-tv/b.zip', 'sealed', 'owner', ?2, 'bk_1', ?2)`).bind("f".repeat(64), NOW),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, payload_version, bundle_form_version, created_at) VALUES ('fa-tv', 'abcdef9', 'forms/fa-tv', 'manifest', '2026-01', 'form@abcdef9', ?1)").bind(NOW),
  ]);
});

async function draft(templateVersionId: string, domain: string): Promise<string> {
  const response = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain, keyword_default: "Quick Loan", template_version_id: templateVersionId } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { brand: { brand_id: string } }).brand.brand_id;
}

const setConfig = (brandId: string, config: unknown) =>
  env.FACTORY.prepare("UPDATE brand_revisions SET config_json = ?2 WHERE brand_id = ?1").bind(brandId, JSON.stringify(config)).run();

const read = async (brandId: string) => {
  const response = await call(`/api/brands/${brandId}/theme-vars`, { cookie: employee });
  return [response.status, BrandThemeVarsResponse.parse(await response.json())] as const;
};

describe("brand theme vars", () => {
  it("reports deployed and template maps", async () => {
    const brandId = await draft("tv-tv-mapped", "mapped.test");
    await setConfig(brandId, { keyword_default: "Quick Loan", theme_vars: DEPLOYED_MAP });
    expect(await read(brandId)).toEqual([200, { brand_id: brandId, deployed: DEPLOYED_MAP, template: TEMPLATE_MAP }]);
    const backfilled = { primary: ["--backfilled"], primary_dark: [], secondary: [] };
    await env.FACTORY.prepare("INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES ('tv-tv-mapped', ?1, 'owner', ?2)")
      .bind(JSON.stringify(backfilled), NOW).run();
    try {
      expect(await read(brandId)).toEqual([200, { brand_id: brandId, deployed: DEPLOYED_MAP, template: backfilled }]);
    } finally {
      await env.FACTORY.prepare("DELETE FROM template_theme_vars WHERE template_version_id = 'tv-tv-mapped'").run();
    }
  });

  it("template is null when the version has no map", async () => {
    const brandId = await draft("tv-tv-bare", "bare.test");
    expect(await read(brandId)).toEqual([200, { brand_id: brandId, deployed: null, template: null }]);
    const emptyId = await draft("tv-tv-mapped", "empty.test");
    await env.FACTORY.prepare("INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES ('tv-tv-mapped', ?1, 'owner', ?2)")
      .bind(JSON.stringify({ primary: [], primary_dark: [], secondary: [] }), NOW).run();
    try {
      expect((await read(emptyId))[1].template).toBeNull();
    } finally {
      await env.FACTORY.prepare("DELETE FROM template_theme_vars WHERE template_version_id = 'tv-tv-mapped'").run();
    }
  });

  it("deployed is null before a map is baked", async () => {
    const brandId = await draft("tv-tv-mapped", "unbaked.test");
    // A revision written before the map existed carries no theme_vars (Task 4 makes new drafts bake the effective map).
    await setConfig(brandId, { keyword_default: "Quick Loan" });
    expect(await read(brandId)).toEqual([200, { brand_id: brandId, deployed: null, template: TEMPLATE_MAP }]);
    expect(await (await call("/api/brands/brand-unknown/theme-vars", { cookie: employee })).json()).toEqual({ brand_id: "brand-unknown", deployed: null, template: null });
    expect((await call("/api/brands/brand-unknown/theme-vars")).status).toBe(401);
  });
});
