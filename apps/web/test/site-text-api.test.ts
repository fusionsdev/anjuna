import { env } from "cloudflare:workers";
import { authorize } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-17T00:00:00.000Z";
const DEFAULTS = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  employee = await sessions.employee();
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-text', 'Copperline', 'react_spa', 'bk_1', ?1)").bind(NOW),
    env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json)
      VALUES ('tv-text', 'tpl-text', 1, ?1, 'templates/tpl-text/a.zip', 'sealed', 'owner', ?2, 'bk_1', ?2, ?3)`).bind("d".repeat(64), NOW, JSON.stringify(DEFAULTS)),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, payload_version, bundle_form_version, created_at) VALUES ('fa-text', 'abcdef9', 'forms/fa-text', 'manifest', '2026-01', 'form@abcdef9', ?1)").bind(NOW),
  ]);
});

describe("site text defaults", () => {
  it("copies the template's text defaults into the first revision and serves them", async () => {
    const draft = await call("/api/brands/drafts", { cookie: employee, method: "POST", body: { domain: "copperline.test", keyword_default: "Quick Loan", template_version_id: "tv-text" } });
    expect(draft.status).toBe(201);
    const { brand } = (await draft.json()) as { brand: { brand_id: string } };
    const revision = await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1").bind(brand.brand_id).first<{ config_json: string }>();
    expect(JSON.parse(revision!.config_json)).toEqual({ keyword_default: "Quick Loan", text_defaults: DEFAULTS });
    const response = await call(`/api/brands/${brand.brand_id}/site-text`, { cookie: employee });
    expect([response.status, await response.json()]).toEqual([200, { brand_id: brand.brand_id, defaults: DEFAULTS }]);
  });

  it("answers null defaults for a brand the factory does not know, and 401 without a session", async () => {
    expect(await (await call("/api/brands/brand-a/site-text", { cookie: employee })).json()).toEqual({ brand_id: "brand-a", defaults: null });
    expect((await call("/api/brands/brand-a/site-text")).status).toBe(401);
  });

  it("lets every role that can read the brand read its site text defaults", async () => {
    for (const role of ["owner", "employee"] as const) {
      const cookie = await sessions[role]();
      const [brandRead, siteText] = [await call("/api/brands/brand-a", { cookie }), await call("/api/brands/brand-a/site-text", { cookie })];
      const allowed = authorize("getBrand", role).ok;
      expect([brandRead.status === 403, siteText.status]).toEqual([!allowed, allowed ? 200 : 403]);
    }
  });

  it("saves site text through the brand PATCH and validates it", async () => {
    const ok = await call("/api/brands/brand-a", { cookie: employee, method: "PATCH", body: { site_title: "Brand A | Options" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { brand: { site_title: string } }).brand.site_title).toBe("Brand A | Options");
    for (const body of [{ site_description: "Personal loans now" }, { brand_name: "x".repeat(81) }, { site_title: 'Say "hi"' }]) {
      expect((await call("/api/brands/brand-a", { cookie: employee, method: "PATCH", body })).status, JSON.stringify(body)).toBe(422);
    }
  });
});
