import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrandProfile, LifecycleBrandSummary, UpdateBrandDraftResponse } from "@anjuna/contracts";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-21T00:00:00.000Z";
const TEXT_A = { brand_name: "Copperline", title: "Copperline | Funding Options", description: "Check your funding options." };
const TEXT_B = { brand_name: "Harbor", title: "Harbor | Funding", description: "See what you may qualify for." };
const PROFILE = {
  contact: { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" },
  disclosures: {
    term_min_months: 6, term_max_months: 48, apr_max: 29.99,
    representative_example: "A 12 month loan of $1,000 at 29.99% APR costs about $96 a month.",
    unsupported_states: ["NY", "AR", "VT", "WV", "CA"],
  },
  ads: { google_ads_account: "1234567890", google_conversion_action: "555", adkit_project: "maple-ads", microsoft_ads_account: "654321" },
};
let owner: string;
let employee: string;
let seq = 0;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  const version = (id: string, n: number, defaults: unknown) => env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json)
    VALUES (?1, 'tpl-draft', ?2, ?3, ?4, ?5, 'owner', ?6, 'owner', ?6, ?7)`).bind(id, n, String(n).repeat(64), `templates/${id}`, id === "tv-draft-unsealed" ? "draft" : "sealed", NOW, defaults === null ? null : JSON.stringify(defaults));
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-draft', 'Drafts', 'astro', 'owner', ?1)").bind(NOW),
    version("tv-draft-a", 1, TEXT_A), version("tv-draft-b", 2, TEXT_B), version("tv-draft-none", 3, null), version("tv-draft-unsealed", 4, TEXT_B),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, payload_version, bundle_form_version, created_at) VALUES ('fa-draft', 'abcdef9', 'forms/fa-draft', 'manifest', '2026-01', 'form@abcdef9', ?1)").bind(NOW),
  ]);
});

const create = (body: Record<string, unknown>, cookie = employee) =>
  call("/api/brands/drafts", { cookie, method: "POST", body: { domain: `draft-${++seq}.test`, keyword_default: "Quick Loan", template_version_id: "tv-draft-a", ...body } });
const draftId = async (body: Record<string, unknown> = {}): Promise<string> => {
  const response = await create(body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { brand: { brand_id: string } }).brand.brand_id;
};
const patch = (brandId: string, body: unknown, cookie = employee) => call(`/api/brands/${brandId}/draft`, { cookie, method: "PATCH", body });
const configOf = async (brandId: string) => JSON.parse((await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1 ORDER BY revision DESC LIMIT 1").bind(brandId).first<{ config_json: string }>())!.config_json) as Record<string, unknown>;
const counts = () => Promise.all([
  env.FACTORY.prepare("SELECT count(*) AS n FROM brands").first(),
  env.FACTORY.prepare("SELECT count(*) AS n FROM brand_revisions").first(),
  env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log").first(),
]);

describe("POST /api/brands/drafts with a profile", () => {
  it("stores the profile in config_json.profile next to the keyword and the template's text defaults", async () => {
    const brandId = await draftId({ profile: PROFILE });
    expect(await configOf(brandId)).toEqual({ keyword_default: "Quick Loan", text_defaults: TEXT_A, profile: PROFILE });
  });

  it("draft config carries the template theme_vars", async () => {
    const vars = { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: ["--color-ink"] };
    await env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json, theme_vars_json)
      VALUES ('tv-draft-theme', 'tpl-draft', 5, ?1, 'templates/tv-draft-theme', 'sealed', 'owner', ?2, 'owner', ?2, NULL, ?3)`).bind("5".repeat(64), NOW, JSON.stringify(vars)).run();
    const brandId = await draftId({ template_version_id: "tv-draft-theme" });
    expect(await configOf(brandId)).toEqual({ keyword_default: "Quick Loan", theme_vars: vars });
    expect((await patch(brandId, { template_version_id: "tv-draft-a" })).status).toBe(200);
    expect(await configOf(brandId)).toEqual({ keyword_default: "Quick Loan", text_defaults: TEXT_A });
  });

  it("keeps the old config shape when no profile is sent", async () => {
    const brandId = await draftId();
    expect(await configOf(brandId)).toEqual({ keyword_default: "Quick Loan", text_defaults: TEXT_A });
  });

  const states = (list: string[]) => ({ disclosures: { unsupported_states: list } });
  it.each([
    ["a forbidden word in the address", { contact: { address: "Anjuna Plaza, Austin TX" } }],
    ["a forbidden word in the email", { contact: { email: "help@aurum.test" } }],
    ["markup in the address", { contact: { address: "<b>12 Main St</b>" } }],
    ["a letter in the phone", { contact: { phone: "555-CASH-NOW" } }],
    ["a forbidden word in the example", { disclosures: { representative_example: "Aurum pays in 3 days" } }],
    ["personal loan wording in the example", { disclosures: { representative_example: "A Personal Loan of $500 costs $40" } }],
    ["a term range that is reversed", { disclosures: { term_min_months: 40, term_max_months: 12 } }],
    ["an APR with 3 decimals", { disclosures: { apr_max: 35.999 } }],
    ["a lowercase state code", states(["NY", "AR", "VT", "WV", "ca"])],
    ["an unknown state code", states(["NY", "AR", "VT", "WV", "ZZ"])],
    ["a duplicate state code", states(["NY", "AR", "VT", "WV", "CA", "CA"])],
    ["a state list without NY", states(["AR", "VT", "WV", "CA"])],
    ["an empty state list", states([])],
    ["a bad Google Ads account", { ads: { google_ads_account: "123-456-7890" } }],
    ["a bad Microsoft Ads account", { ads: { microsoft_ads_account: "12345" } }],
    ["amount buckets", { amount_buckets: [500] }],
    ["a form route", { form_route: "/apply" }],
  ])("refuses %s with 422 and creates nothing", async (_label, profile) => {
    const before = await counts();
    const response = await create({ profile });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid" });
    expect(await counts()).toEqual(before);
  });
});

describe("PATCH /api/brands/:id/draft", () => {
  it("updates name, keyword, profile and the audit trail in place, as an Employee", async () => {
    const brandId = await draftId();
    await env.FACTORY.prepare("UPDATE brands SET updated_at = '2026-01-01T00:00:00.000Z' WHERE brand_id = ?1").bind(brandId).run();
    const before = await counts();
    const response = await patch(brandId, { name: "  Maple Cash ", keyword_default: "fast cash", profile: PROFILE });
    expect(response.status).toBe(200);
    const body = UpdateBrandDraftResponse.parse(await response.json());
    expect(body).toMatchObject({
      brand: { brand_id: brandId, name: "Maple Cash", keyword_default: "Fast Cash", status: "draft" },
      revision: { revision: 1, template_version_id: "tv-draft-a", form_artifact_id: "fa-draft" },
      profile: PROFILE,
      changed: ["name", "keyword_default", "profile.contact", "profile.disclosures", "profile.ads"],
    });
    expect(await env.FACTORY.prepare("SELECT name, keyword_default, status, updated_at <> '2026-01-01T00:00:00.000Z' AS touched FROM brands WHERE brand_id = ?1").bind(brandId).first())
      .toEqual({ name: "Maple Cash", keyword_default: "Fast Cash", status: "draft", touched: 1 });
    expect(await configOf(brandId)).toEqual({ keyword_default: "Fast Cash", text_defaults: TEXT_A, profile: PROFILE });
    const [brands, revisions, audits] = await counts();
    expect([brands, revisions, audits]).toEqual([before[0], before[1], { n: (before[2] as { n: number }).n + 1 }]);
  });

  it("writes one brand.draft_update audit row that names the changed keys and holds none of the text", async () => {
    const brandId = await draftId({ profile: PROFILE });
    const next = { ...PROFILE, contact: { ...PROFILE.contact, phone: "+1 555 010 0200" } };
    expect((await patch(brandId, { profile: next, name: "Quiet Cash" })).status).toBe(200);
    const { results } = await env.FACTORY.prepare("SELECT actor_role, entity_type, after_json FROM audit_log WHERE action = 'brand.draft_update' AND entity_id = ?1").bind(brandId).all<{ actor_role: string; entity_type: string; after_json: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ actor_role: "employee", entity_type: "brand" });
    expect(JSON.parse(results[0]!.after_json)).toEqual({ changed: ["name", "profile.contact"] });
    for (const secret of ["555", "Main St", "maplecash", "Quiet Cash", "29.99"]) expect(results[0]!.after_json).not.toContain(secret);
  });

  it("replaces the whole profile: a group left out is removed", async () => {
    const brandId = await draftId({ profile: PROFILE });
    const response = await patch(brandId, { profile: { ads: PROFILE.ads } });
    expect(response.status).toBe(200);
    expect(UpdateBrandDraftResponse.parse(await response.json()).changed).toEqual(["profile.contact", "profile.disclosures"]);
    expect((await configOf(brandId)).profile).toEqual({ ads: PROFILE.ads });
  });

  it("leaves everything alone and writes no audit row when nothing changes", async () => {
    const brandId = await draftId({ profile: PROFILE });
    const before = await counts();
    const config = await configOf(brandId);
    for (const body of [{}, { profile: PROFILE }, { keyword_default: "quick loan" }, { template_version_id: "tv-draft-a" }]) {
      const response = await patch(brandId, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(UpdateBrandDraftResponse.parse(await response.json()).changed).toEqual([]);
    }
    expect(await counts()).toEqual(before);
    expect(await configOf(brandId)).toEqual(config);
  });

  it("lets an Owner edit too and records the Owner role", async () => {
    const brandId = await draftId();
    expect((await patch(brandId, { name: "Owner Edit" }, owner)).status).toBe(200);
    expect(await env.FACTORY.prepare("SELECT actor_role FROM audit_log WHERE action = 'brand.draft_update' AND entity_id = ?1").bind(brandId).first()).toEqual({ actor_role: "owner" });
  });

  it("allows a failed brand and refuses live, installing, paused and retired brands with 409", async () => {
    const brandId = await draftId();
    await env.FACTORY.prepare("UPDATE brands SET status = 'failed' WHERE brand_id = ?1").bind(brandId).run();
    const failed = await patch(brandId, { name: "Second Try" });
    expect(failed.status).toBe(200);
    expect(UpdateBrandDraftResponse.parse(await failed.json()).brand.status).toBe("failed");
    for (const status of ["live", "installing", "paused", "retired"]) {
      await env.FACTORY.prepare("UPDATE brands SET status = ?2 WHERE brand_id = ?1").bind(brandId, status).run();
      const response = await patch(brandId, { name: "Too Late" });
      expect(response.status, status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "conflict" });
    }
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id = ?1").bind(brandId).first()).toEqual({ name: "Second Try" });
  });

  it.each(["queued", "running"])("refuses an edit while an install is %s and changes nothing", async (status) => {
    const brandId = await draftId({ profile: PROFILE });
    await env.FACTORY.prepare("INSERT INTO installs (install_id, brand_id, kind, status, started_by, started_role, started_at) VALUES (?1, ?2, 'install', ?3, 'owner', 'owner', ?4)").bind(`ins-edit-${status}`, brandId, status, NOW).run();
    const before = await counts();
    const config = await configOf(brandId);
    const response = await patch(brandId, { name: "Mid Install", profile: {} });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "lifecycle_operation_active", active_install_id: `ins-edit-${status}`, active_kind: "install", active_status: status });
    expect(await counts()).toEqual(before);
    expect(await configOf(brandId)).toEqual(config);
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id = ?1").bind(brandId).first()).not.toEqual({ name: "Mid Install" });
  });

  // The statements of the batch re-check the brand status, active installs and the config as read, so a change that lands
  // after the read is refused. The proxy runs that change right before the batch.
  it.each([
    ["an install claims the draft", "INSERT INTO installs (install_id, brand_id, kind, status, started_by, started_role, started_at) VALUES ('ins-race', ?1, 'install', 'queued', 'owner', 'owner', '2026-10-21T00:00:00.000Z')", "lifecycle_operation_active"],
    ["another edit changes the revision", "UPDATE brand_revisions SET config_json = json_set(config_json, '$.keyword_default', 'Other Edit') WHERE brand_id = ?1", "conflict"],
    ["the brand goes live", "UPDATE brands SET status = 'live' WHERE brand_id = ?1", "conflict"],
  ])("refuses and changes nothing when %s between the read and the write", async (_label, sql, error) => {
    const brandId = await draftId({ profile: PROFILE });
    const racing = new Proxy(env.FACTORY, {
      get(target, prop) {
        if (prop === "batch") return async (statements: D1PreparedStatement[]) => { await target.prepare(sql).bind(brandId).run(); return target.batch(statements); };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const config = await configOf(brandId);
    const response = await call(`/api/brands/${brandId}/draft`, { cookie: employee, method: "PATCH", body: { name: "Lost Race", profile: {} }, env: makeEnv({ FACTORY: racing }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error });
    expect(await env.FACTORY.prepare("SELECT name FROM brands WHERE brand_id = ?1").bind(brandId).first()).not.toEqual({ name: "Lost Race" });
    expect(await env.FACTORY.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'brand.draft_update' AND entity_id = ?1").bind(brandId).first()).toEqual({ n: 0 });
    expect((await configOf(brandId)).profile).toEqual(config.profile);
  });

  it("refuses a body that is not valid, an unknown key and a dirty profile with 422, and an unknown brand with 404", async () => {
    const brandId = await draftId();
    const before = await counts();
    for (const body of [null, "x", { domain: "other.test" }, { name: "Anjuna Cash" }, { keyword_default: "!!!" }, { profile: { disclosures: { unsupported_states: ["AR"] } } }, { profile: { contact: { address: "Aurum Way" } } }]) {
      expect((await patch(brandId, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await patch("brand_missing", { name: "Nobody" })).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("needs a session", async () => {
    const brandId = await draftId();
    expect((await call(`/api/brands/${brandId}/draft`, { method: "PATCH", body: { name: "No Session" } })).status).toBe(401);
  });

  describe("template change", () => {
    it("re-applies the new template's text defaults and keeps every other key, including site text the user set", async () => {
      const brandId = await draftId({ profile: PROFILE });
      await env.FACTORY.prepare("UPDATE brand_revisions SET config_json = ?2 WHERE brand_id = ?1")
        .bind(brandId, JSON.stringify({ ...(await configOf(brandId)), brand_name: "My Brand", site_title: "My Title", site_description: "My description." })).run();
      const response = await patch(brandId, { template_version_id: "tv-draft-b" });
      expect(response.status).toBe(200);
      expect(UpdateBrandDraftResponse.parse(await response.json())).toMatchObject({ revision: { template_version_id: "tv-draft-b" }, changed: ["template_version_id"] });
      expect(await configOf(brandId)).toEqual({
        keyword_default: "Quick Loan", text_defaults: TEXT_B, profile: PROFILE,
        brand_name: "My Brand", site_title: "My Title", site_description: "My description.",
      });
      expect(await env.FACTORY.prepare("SELECT template_version_id FROM brand_revisions WHERE brand_id = ?1").bind(brandId).first()).toEqual({ template_version_id: "tv-draft-b" });
    });

    it("drops text_defaults for a template that has none, as draft creation does", async () => {
      const brandId = await draftId();
      expect((await patch(brandId, { template_version_id: "tv-draft-none" })).status).toBe(200);
      expect(await configOf(brandId)).toEqual({ keyword_default: "Quick Loan" });
    });

    it("refuses an unsealed or unknown template with 422 and changes nothing", async () => {
      const brandId = await draftId();
      const before = await counts();
      const config = await configOf(brandId);
      for (const id of ["tv-draft-unsealed", "tv-missing"]) {
        const response = await patch(brandId, { template_version_id: id, name: "Not Saved" });
        expect(response.status, id).toBe(422);
        expect(await response.json()).toMatchObject({ error: "template_not_sealed" });
      }
      expect(await counts()).toEqual(before);
      expect(await configOf(brandId)).toEqual(config);
      expect(await env.FACTORY.prepare("SELECT template_version_id FROM brand_revisions WHERE brand_id = ?1").bind(brandId).first()).toEqual({ template_version_id: "tv-draft-a" });
    });
  });
});

describe("GET /api/lifecycle/brands/:id profile", () => {
  const detail = async (brandId: string) => {
    const response = await call(`/api/lifecycle/brands/${brandId}`, { cookie: employee });
    expect(response.status).toBe(200);
    return ((await response.json()) as { brand: unknown }).brand;
  };

  it("returns the profile from the latest revision and follows a PATCH", async () => {
    const brandId = await draftId({ profile: PROFILE });
    const read = LifecycleBrandSummary.parse(await detail(brandId));
    expect(read).toMatchObject({ brand_id: brandId, status: "draft" });
    expect(read.profile).toEqual(BrandProfile.parse(PROFILE));
    await patch(brandId, { profile: { contact: { email: "hello@maplecash.test" } } });
    expect(LifecycleBrandSummary.parse(await detail(brandId)).profile).toEqual({ contact: { email: "hello@maplecash.test" } });
  });

  it("omits the key for a brand without a profile and keeps the list free of it", async () => {
    const brandId = await draftId();
    expect(Object.keys(await detail(brandId) as object)).not.toContain("profile");
    const withProfile = await draftId({ profile: PROFILE });
    const list = (await (await call("/api/lifecycle/brands", { cookie: employee })).json() as { brands: Array<{ brand_id: string }> }).brands;
    expect(list.map((row) => row.brand_id)).toEqual(expect.arrayContaining([brandId, withProfile]));
    for (const row of list) expect(Object.keys(row)).not.toContain("profile");
  });

  it("omits a stored profile that no longer validates instead of failing the read", async () => {
    const brandId = await draftId();
    await env.FACTORY.prepare("UPDATE brand_revisions SET config_json = ?2 WHERE brand_id = ?1").bind(brandId, JSON.stringify({ keyword_default: "Quick Loan", profile: { contact: { phone: "abc" } } })).run();
    expect(Object.keys(await detail(brandId) as object)).not.toContain("profile");
  });
});
