import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { darkenHex } from "@anjuna/contracts";
import { createBrandWorker } from "@anjuna/brand-runtime";
import { renderPageText, templateBrandName } from "@anjuna/brand-runtime/page-text";
import { MockCoreClient, WILLOW_LAKE_INDEX, WILLOW_LAKE_TERMS, WIZARD_DEMO_PAGE_TEXT } from "@anjuna/brand-runtime/testing";
import { WizardDraft, DuplicateBrandResponse, ZoneCheckResponse } from "../src/shared/wizard";
import { PANEL_ROLE_TABLE, authorizePanel } from "../src/server/panel-roles";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-10-22T00:00:00.000Z";
const TEXT = { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Check your funding options." };
const PROFILE = {
  contact: { phone: "+1 (555) 010-0199", address: "12 Main St, Austin, TX 78701", email: "help@maplecash.test" },
  disclosures: {
    term_min_months: 6, term_max_months: 48, apr_max: 29.99,
    representative_example: "A 12 month loan of $1,000 at 29.99% APR costs about $96 a month.",
    unsupported_states: ["NY", "AR", "VT", "WV", "CA"],
  },
  copy: { brand_name: "Maple Cash", site_title: "Maple Cash | Quick Funding", site_description: "See your options in minutes.", h1: "{{keyword}} When You Need It", cta: "Check my rate" },
  ads: { google_ads_account: "1234567890", google_conversion_action: "555", adkit_project: "maple-ads", microsoft_ads_account: "654321" },
};
const enc = (text: string) => new TextEncoder().encode(text);
const INDEX = `<!doctype html><html><head><title>Harbor | Funding Options</title>
<meta name="description" content="Check your funding options."><meta property="og:title" content="Harbor | Funding Options">
<link rel="stylesheet" href="/assets/site.css"><link rel="icon" href="/favicon.ico"><script src="/assets/app.js"></script><style>.hero{color:red}</style></head>
<body><header data-brand>Harbor</header><h1>Funding</h1><img src="/assets/logo.png" alt="logo"><img src="https://cdn.example/x.png"><script>alert(1)</script></body></html>`;
const CSS = `body{background:url("../assets/bg.png")} .x{font-family:"X";src:url(/assets/font.woff2)} .y{background:url(https://cdn.example/y.png)}`;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let owner: string;
let employee: string;
let seq = 0;

beforeAll(setupDatabases, 60_000);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
  const archive = zipSync({ "index.html": enc(INDEX), "assets/site.css": enc(CSS), "assets/logo.png": PNG, "assets/bg.png": PNG, "assets/font.woff2": PNG, "assets/app.js": enc("alert(2)") });
  await env.ARTIFACTS.put("templates/tv-wiz-a.zip", archive);
  await env.ARTIFACTS.put("templates/tv-wiz-noindex.zip", zipSync({ "about.html": enc("<p>x</p>") }));
  const version = (id: string, n: number, defaults: unknown, key: string) => env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json)
    VALUES (?1, 'tpl-wiz', ?2, ?3, ?4, 'sealed', 'owner', ?5, 'owner', ?5, ?6)`).bind(id, n, String(n).repeat(64), key, NOW, defaults === null ? null : JSON.stringify(defaults));
  await env.FACTORY.batch([
    env.FACTORY.prepare("INSERT OR IGNORE INTO templates (template_id, name, framework, created_by, created_at) VALUES ('tpl-wiz', 'Wizard', 'astro', 'owner', ?1)").bind(NOW),
    version("tv-wiz-a", 1, TEXT, "templates/tv-wiz-a.zip"), version("tv-wiz-noindex", 2, null, "templates/tv-wiz-noindex.zip"), version("tv-wiz-missing", 3, TEXT, "templates/absent.zip"),
    env.FACTORY.prepare("INSERT OR IGNORE INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, payload_version, bundle_form_version, created_at) VALUES ('fa-wiz', 'abcdef9', 'forms/fa-wiz', 'manifest', '2026-01', 'form@abcdef9', ?1)").bind(NOW),
  ]);
});

const create = (body: Record<string, unknown> = {}, cookie = employee) =>
  call("/api/brands/drafts", { cookie, method: "POST", body: { domain: `wiz-${++seq}.test`, keyword_default: "Quick Loan", template_version_id: "tv-wiz-a", name: "Maple Cash", ...body } });
const draftId = async (body: Record<string, unknown> = {}): Promise<string> => {
  const response = await create(body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { brand: { brand_id: string } }).brand.brand_id;
};
const configOf = async (brandId: string) => JSON.parse((await env.FACTORY.prepare("SELECT config_json FROM brand_revisions WHERE brand_id = ?1 ORDER BY revision DESC LIMIT 1").bind(brandId).first<{ config_json: string }>())!.config_json) as Record<string, unknown>;

/** A FACTORY_WORKER stand-in that records what the panel sent and answers like the factory /zone-check route. */
function factoryWorker(answer: () => Response) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = { async fetch(request: Request) {
    requests.push({ method: request.method, url: request.url, body: await request.json().catch(() => null) });
    return answer();
  } } as unknown as Fetcher;
  return { fetcher, requests };
}
const zoneCheck = (body: unknown, fetcher?: Fetcher, cookie = employee) =>
  call("/api/wizard/zone-check", { cookie, method: "POST", body, env: makeEnv(fetcher ? { FACTORY_WORKER: fetcher } : { MOCK_CORE: "0" }) });

describe("GET /api/wizard/defaults", () => {
  it("returns the tenant amount buckets and form route to an employee", async () => {
    const response = await call("/api/wizard/defaults", { cookie: employee });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ amount_buckets: [100, 200, 300, 500, 1000], form_route: "/request" });
  });
  it("answers 503 when the tenant defaults are not configured", async () => {
    const response = await call("/api/wizard/defaults", { cookie: employee, env: makeEnv({ DEFAULT_FORM_ROUTE: "" }) });
    expect(response.status).toBe(503);
  });
  it("answers 401 without a session", async () => {
    expect((await call("/api/wizard/defaults")).status).toBe(401);
  });
});

describe("POST /api/wizard/zone-check", () => {
  const active = { zone_active: true, zone_name: "maple.test", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], conflicting_records: [] };

  it("returns an active zone and sends the lowercased domain to the factory as one POST", async () => {
    const worker = factoryWorker(() => Response.json(active));
    const response = await zoneCheck({ domain: "Maple.Test" }, worker.fetcher);
    expect(response.status).toBe(200);
    expect(ZoneCheckResponse.parse(await response.json())).toEqual(active);
    expect(worker.requests).toEqual([{ method: "POST", url: "https://factory/zone-check", body: { domain: "maple.test" } }]);
  });

  it("returns an inactive zone with the name servers to set at the registrar", async () => {
    const inactive = { zone_active: false, zone_name: "maple.test", nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], conflicting_records: [] };
    const response = await zoneCheck({ domain: "maple.test" }, factoryWorker(() => Response.json(inactive)).fetcher);
    expect(await response.json()).toEqual(inactive);
  });

  it("returns a domain that has no zone in the tenant account", async () => {
    const none = { zone_active: false, zone_name: null, nameservers: [], conflicting_records: [] };
    const response = await zoneCheck({ domain: "maple.test" }, factoryWorker(() => Response.json(none)).fetcher);
    expect(await response.json()).toEqual(none);
  });

  it("returns conflicting records and passes the draft's brand id so its own Worker is not a conflict", async () => {
    const conflict = { ...active, conflicting_records: [{ type: "A", name: "maple.test" }, { type: "CNAME", name: "www.maple.test" }] };
    const worker = factoryWorker(() => Response.json(conflict));
    const response = await zoneCheck({ domain: "maple.test", brand_id: "brand_abc123" }, worker.fetcher);
    expect(await response.json()).toEqual(conflict);
    expect(worker.requests[0]!.body).toEqual({ domain: "maple.test", brand_id: "brand_abc123" });
  });

  it.each([
    ["a www hostname", { domain: "www.maple.test" }],
    ["a bare label", { domain: "localhost" }],
    ["a url", { domain: "https://maple.test" }],
    ["a missing domain", {}],
    ["an unknown key", { domain: "maple.test", zone_id: "z" }],
    ["a bad brand id", { domain: "maple.test", brand_id: "Brand/1" }],
  ])("answers 422 for %s without calling the factory", async (_name, body) => {
    const worker = factoryWorker(() => Response.json(active));
    const response = await zoneCheck(body, worker.fetcher);
    expect(response.status).toBe(422);
    expect(worker.requests).toEqual([]);
  });

  it("answers 502 when the factory binding is missing", async () => {
    const response = await zoneCheck({ domain: "maple.test" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "zone_check_unavailable" });
  });

  it("answers 502 with the factory's message when Cloudflare fails", async () => {
    const response = await zoneCheck({ domain: "maple.test" }, factoryWorker(() => Response.json({ ok: false, message: "CF API GET /zones failed: 10000: Authentication error" }, { status: 502 })).fetcher);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "zone_check_failed", message: "CF API GET /zones failed: 10000: Authentication error" });
  });

  it("answers 502 when the factory answers with an unexpected shape", async () => {
    const response = await zoneCheck({ domain: "maple.test" }, factoryWorker(() => Response.json({ zone_active: "yes" })).fetcher);
    expect(response.status).toBe(502);
  });

  it("is open to an employee and an owner, and closed without a session", async () => {
    const fetcher = factoryWorker(() => Response.json(active)).fetcher;
    expect((await zoneCheck({ domain: "maple.test" }, fetcher, employee)).status).toBe(200);
    expect((await zoneCheck({ domain: "maple.test" }, fetcher, owner)).status).toBe(200);
    expect((await call("/api/wizard/zone-check", { method: "POST", body: { domain: "maple.test" }, env: makeEnv({ FACTORY_WORKER: fetcher }) })).status).toBe(401);
  });
});

describe("GET /api/wizard/drafts/:id", () => {
  it("returns the draft the way the wizard resumes it, with its profile", async () => {
    const brandId = await draftId({ profile: PROFILE, domain: "resume.test" });
    const response = await call(`/api/wizard/drafts/${brandId}`, { cookie: employee });
    expect(response.status).toBe(200);
    expect(WizardDraft.parse(await response.json())).toEqual({
      brand: { brand_id: brandId, name: "Maple Cash", domain: "resume.test", keyword_default: "Quick Loan", status: "draft" },
      revision: { revision_id: `${brandId}_rev_1`, revision: 1, template_version_id: "tv-wiz-a", form_artifact_id: "fa-wiz" },
      profile: PROFILE,
    });
  });
  it("omits the profile of a draft that has none", async () => {
    const brandId = await draftId();
    expect(await (await call(`/api/wizard/drafts/${brandId}`, { cookie: employee })).json()).not.toHaveProperty("profile");
  });
  // A live brand opens in the wizard too (FUS-391, wizard-live-api.test.ts); a paused one does not.
  it("answers 404 for an unknown brand and 409 for a paused brand", async () => {
    expect((await call("/api/wizard/drafts/brand_nope", { cookie: employee })).status).toBe(404);
    const brandId = await draftId();
    await env.FACTORY.prepare("UPDATE brands SET status = 'paused' WHERE brand_id = ?1").bind(brandId).run();
    expect((await call(`/api/wizard/drafts/${brandId}`, { cookie: employee })).status).toBe(409);
  });
});

describe("POST /api/brands/:id/duplicate", () => {
  const duplicate = (brandId: string, body: unknown, cookie = employee) => call(`/api/brands/${brandId}/duplicate`, { cookie, method: "POST", body });

  it("copies the template, keyword, profile and site text into a new draft with a new domain", async () => {
    const sourceId = await draftId({ profile: PROFILE, domain: "source.test" });
    const response = await duplicate(sourceId, { domain: "Copy.Test", name: "Copy Cash" });
    expect(response.status).toBe(201);
    const body = DuplicateBrandResponse.parse(await response.json());
    expect(body.duplicated_from).toBe(sourceId);
    expect(body.brand).toMatchObject({ name: "Copy Cash", domain: "copy.test", keyword_default: "Quick Loan", status: "draft" });
    expect(body.brand.brand_id).not.toBe(sourceId);
    expect(body.revision).toMatchObject({ revision_id: `${body.brand.brand_id}_rev_1`, template_version_id: "tv-wiz-a" });
    expect(body.profile).toEqual(PROFILE);
    expect(await configOf(body.brand.brand_id)).toEqual({ keyword_default: "Quick Loan", text_defaults: TEXT, profile: PROFILE });
  });

  it("derives the name from the new domain when none is given", async () => {
    const sourceId = await draftId({ profile: PROFILE });
    const body = DuplicateBrandResponse.parse(await (await duplicate(sourceId, { domain: "fresh-name.test" })).json());
    expect(body.brand.name).toBe("fresh name");
  });

  it("never copies the domain, ids, checklist, tokens or install state", async () => {
    const sourceId = await draftId({ profile: PROFILE, domain: "marker-source.test" });
    // A live brand's config_json can carry more than the draft keys: a duplicate keeps only keyword, profile and text defaults.
    await env.FACTORY.batch([
      env.FACTORY.prepare("UPDATE brand_revisions SET config_json = ?2 WHERE brand_id = ?1").bind(sourceId, JSON.stringify({ keyword_default: "Quick Loan", profile: PROFILE, text_defaults: TEXT, postback_token: "tok_SECRET", drain_key: "drain_SECRET", worker_url: "marker-source.test" })),
      env.FACTORY.prepare("UPDATE brands SET status = 'live', current_revision_id = ?2 WHERE brand_id = ?1").bind(sourceId, `${sourceId}_rev_1`),
      env.FACTORY.prepare("INSERT INTO installs (install_id, brand_id, kind, status, to_revision_id, started_by, started_role, started_at) VALUES ('ins-dup-1', ?1, 'install', 'ready', ?2, 'owner', 'owner', ?3)").bind(sourceId, `${sourceId}_rev_1`, NOW),
      env.FACTORY.prepare("INSERT INTO brand_checklist (brand_id, item, evidence_json, confirmed_by, confirmed_role, confirmed_at) VALUES (?1, 'drain_route', '{}', 'owner', 'owner', ?2)").bind(sourceId, NOW),
    ]);
    const response = await duplicate(sourceId, { domain: "marker-copy.test" });
    expect(response.status).toBe(201);
    const { brand } = DuplicateBrandResponse.parse(await response.json());
    const newId = brand.brand_id;
    const row = await env.FACTORY.prepare("SELECT * FROM brands WHERE brand_id = ?1").bind(newId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ domain: "marker-copy.test", status: "draft", current_revision_id: null });
    const stored = JSON.stringify(await env.FACTORY.prepare("SELECT * FROM brand_revisions WHERE brand_id = ?1").bind(newId).all());
    for (const leaked of ["tok_SECRET", "drain_SECRET", "marker-source.test", sourceId]) expect(stored).not.toContain(leaked);
    expect(Object.keys(await configOf(newId)).sort()).toEqual(["keyword_default", "profile", "text_defaults"]);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM installs WHERE brand_id = ?1").bind(newId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_checklist WHERE brand_id = ?1").bind(newId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.FACTORY.prepare("SELECT count(*) AS n FROM brand_checklist WHERE brand_id = ?1").bind(sourceId).first<{ n: number }>())!.n).toBe(1);
  });

  it("requires a new domain and refuses one that is taken", async () => {
    const sourceId = await draftId({ profile: PROFILE, domain: "taken.test" });
    expect((await duplicate(sourceId, {})).status).toBe(422);
    expect((await duplicate(sourceId, { domain: "www.new.test" })).status).toBe(422);
    expect((await duplicate(sourceId, { domain: "new.test", extra: 1 })).status).toBe(422);
    const same = await duplicate(sourceId, { domain: "taken.test" });
    expect(same.status).toBe(409);
    expect(await same.json()).toMatchObject({ error: "conflict" });
  });

  it("answers 404 for an unknown source and writes one audit row for the actor on success", async () => {
    expect((await duplicate("brand_nope", { domain: "x-copy.test" })).status).toBe(404);
    const sourceId = await draftId();
    const { brand } = DuplicateBrandResponse.parse(await (await duplicate(sourceId, { domain: "audited.test" })).json());
    const rows = (await env.FACTORY.prepare("SELECT actor_role, entity_id, after_json FROM audit_log WHERE action = 'brand.duplicate' AND entity_id = ?1").bind(brand.brand_id).all<{ actor_role: string; entity_id: string; after_json: string }>()).results;
    expect(rows).toEqual([{ actor_role: "employee", entity_id: brand.brand_id, after_json: JSON.stringify({ source_brand_id: sourceId }) }]);
  });

  it("is open to an employee and an owner, and closed without a session", async () => {
    const sourceId = await draftId();
    expect((await duplicate(sourceId, { domain: "by-owner.test" }, owner)).status).toBe(201);
    expect((await call(`/api/brands/${sourceId}/duplicate`, { method: "POST", body: { domain: "anon.test" } })).status).toBe(401);
  });
});

describe("GET /api/wizard/preview/:id", () => {
  const preview = (brandId: string, cookie = employee) => call(`/api/wizard/preview/${brandId}`, { cookie });

  it("renders the template with the draft's site text and no core runtime row", async () => {
    // makeEnv's CORE binding throws when called: the preview reads the factory D1 and R2 only.
    const brandId = await draftId({ profile: PROFILE });
    const response = await preview(brandId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Maple Cash | Quick Funding</title>");
    expect(html).toContain('content="See your options in minutes."');
    expect(html).toContain('<meta property="og:title" content="Maple Cash | Quick Funding">');
    expect(html).toMatch(/<header data-brand>Maple Cash<\/header>/);
    // The H1 slot is baked with the brand name, not the keyword.
    expect(html).toContain("<h1><span data-kw>Maple Cash</span> When You Need It</h1>");
    expect(html).not.toContain("Quick Loan</span>");
    expect(html).not.toContain("Harbor");
  });

  const addThemedVersion = () => env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json, theme_vars_json)
    VALUES ('tv-wiz-themed', 'tpl-wiz', 5, ?1, 'templates/tv-wiz-a.zip', 'sealed', 'owner', ?2, 'owner', ?2, ?3, ?4)`)
    .bind("5".repeat(64), NOW, JSON.stringify(TEXT), JSON.stringify({ primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: [] })).run();

  it("preview carries the draft theme block", async () => {
    await addThemedVersion();
    const html = await (await preview(await draftId({ template_version_id: "tv-wiz-themed", profile: { theme: { primary: "#112233", secondary: "#445566" } } }))).text();
    const block = `<style id="brand-theme">:root{--color-royal:#112233;--color-royal-dark:${darkenHex("#112233")}}</style>`;
    expect(html).toContain(`${block}</head>`);
    expect(html.indexOf(".hero{color:red}")).toBeLessThan(html.indexOf(block));
  });

  it("preview without theme is unchanged", async () => {
    await addThemedVersion();
    // Same fixture and same profile: the template without a map is the baseline, the template with a map but no draft theme must match it byte for byte.
    const plain = await preview(await draftId({ profile: PROFILE }));
    const mapped = await preview(await draftId({ template_version_id: "tv-wiz-themed", profile: PROFILE }));
    expect(plain.status).toBe(200);
    expect(mapped.status).toBe(200);
    const html = await plain.text();
    expect(html).not.toContain("brand-theme");
    expect(await mapped.text()).toBe(html);
  });

  it("answers 422 for saved copy the install would refuse", async () => {
    const response = await preview(await draftId({ profile: { copy: { h1: "No keyword slot" } } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_copy" });
  });

  // FUS-364: the Willow Lake Lending template on brand "Wizard Demo". The live page is renderPageText (the install
  // render; workers/factory/test/page-text-render.test.ts shows renderBrand uploads its output) served by the brand Worker.
  it("shows the page the brand Worker serves after install", async () => {
    await env.ARTIFACTS.put("templates/tv-wiz-willow.zip", zipSync({ "index.html": enc(WILLOW_LAKE_INDEX), "terms/index.html": enc(WILLOW_LAKE_TERMS) }));
    const defaults = { brand_name: "Willow Lake Lending", title: "Willow Lake Lending | Loan Options", description: "Willow Lake Lending helps you compare options." };
    await env.FACTORY.prepare(`INSERT OR IGNORE INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, text_defaults_json)
      VALUES ('tv-wiz-willow', 'tpl-wiz', 4, ?1, 'templates/tv-wiz-willow.zip', 'sealed', 'owner', ?2, 'owner', ?2, ?3)`).bind("4".repeat(64), NOW, JSON.stringify(defaults)).run();
    const { profile } = WIZARD_DEMO_PAGE_TEXT;
    const brandId = await draftId({ name: "Wizard Demo", keyword_default: "Loan Options", template_version_id: "tv-wiz-willow", profile });
    const previewed = await (await preview(brandId)).text();

    const rendered = await renderPageText(new Map([["index.html", WILLOW_LAKE_INDEX], ["terms/index.html", WILLOW_LAKE_TERMS]]), {
      brand_name: "Wizard Demo", template_brand: templateBrandName(JSON.stringify(defaults), "Wizard"), keyword_default: "Loan Options", profile,
    });
    const worker = createBrandWorker({
      brand_id: "wizard-demo", hostname: "demo11.example", brand: "Wizard Demo", formRoute: "/request", amount_buckets: [1000],
      keyword_default: "Loan Options", text_defaults: defaults, core: new MockCoreClient(),
      assets: { fetch: async () => new Response(rendered.get("index.html")!, { headers: { "content-type": "text/html" } }) },
    });
    const served = await (await worker.fetch(new Request("https://demo11.example/"))).text();

    // The preview drops scripts (the JSON-LD block is the only one) and image sources missing from the archive.
    expect(previewed).toBe(served.replace(/<script type="application\/ld\+json">.*?<\/script>/, "").replace(' src="/logo.png"', ""));
    expect(previewed).toContain("<h1><span data-kw>Wizard Demo</span> Options in Minutes</h1>");
    expect(previewed).toContain('href="tel:+15550100199"');
    expect(previewed).toContain("+1 (555) 010-0199");
    expect(previewed).toContain("<title>Wizard Demo | Loan Options</title>");
    expect(previewed).not.toContain("Willow Lake");
    expect(previewed).not.toContain("710-3200");
  });

  it("replaces the template brand in an unedited title with the brand name", async () => {
    const html = await (await preview(await draftId({ name: "Maple Cash" }))).text();
    expect(html).toContain("<title>Maple Cash | Funding Options</title>");
    expect(html).toContain('<meta property="og:title" content="Maple Cash | Funding Options">');
    expect(html).toContain('content="Check your funding options."');
    expect(html).toMatch(/<header data-brand>Maple Cash<\/header>/);
  });

  it("folds stylesheets and images into the page, drops scripts, and makes no request", async () => {
    const html = await (await preview(await draftId())).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(");
    expect(html).not.toContain("/assets/site.css");
    expect(html).toContain("<style>body{background:url(\"data:image/png;base64,");
    expect(html).toContain('url("data:font/woff2;base64,');
    expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="logo">/);
    expect(html).toContain("url(https://cdn.example/y.png)");
    expect(html).not.toContain('<img src="https://cdn.example');
    expect(html).not.toContain('rel="icon"');
  });

  it("is served under a sandbox CSP that allows no script, form, frame or network", async () => {
    const response = await preview(await draftId());
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox;");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("allow-");
    expect(csp).not.toContain("script-src");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("escapes markup in a brand name typed into the display name", async () => {
    const brandId = await draftId({ profile: { copy: { brand_name: "Smith & Sons" } } });
    const html = await (await preview(brandId)).text();
    expect(html).toMatch(/<header data-brand>Smith &amp; Sons<\/header>/);
  });

  it("answers 503 when the template archive is missing and 422 when it has no index.html", async () => {
    const missing = await preview(await draftId({ template_version_id: "tv-wiz-missing" }));
    expect(missing.status).toBe(503);
    const noIndex = await preview(await draftId({ template_version_id: "tv-wiz-noindex" }));
    expect(noIndex.status).toBe(422);
    expect(await noIndex.json()).toMatchObject({ error: "preview_unavailable" });
  });

  it("answers 404 for an unknown brand and 409 for a paused brand", async () => {
    expect((await preview("brand_nope")).status).toBe(404);
    const brandId = await draftId();
    await env.FACTORY.prepare("UPDATE brands SET status = 'paused' WHERE brand_id = ?1").bind(brandId).run();
    expect((await preview(brandId)).status).toBe(409);
  });

  it("is closed without a session", async () => {
    expect((await call(`/api/wizard/preview/${await draftId()}`)).status).toBe(401);
  });
});

describe("draft tracking role", () => {
  const original = PANEL_ROLE_TABLE.setDraftTracking;
  const patch = (brandId: string, body: unknown, cookie: string) => call(`/api/brands/${brandId}/draft`, { cookie, method: "PATCH", body });
  const restrict = () => { (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = "owner"; };
  afterEach(() => { (PANEL_ROLE_TABLE as Record<string, string>).setDraftTracking = original; });

  it("lets an employee set tracking ids on a draft today", async () => {
    expect(authorizePanel("setDraftTracking", "employee").ok).toBe(true);
    const brandId = await draftId();
    expect((await patch(brandId, { profile: { ads: PROFILE.ads } }, employee)).status).toBe(200);
  });

  it("refuses an employee who creates a draft with tracking ids once the role is raised to owner", async () => {
    restrict();
    expect(authorizePanel("setDraftTracking", "employee").ok).toBe(false);
    const denied = await create({ profile: { ads: PROFILE.ads } }, employee);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden_role", required_role: "owner" });
    expect((await create({ profile: { contact: PROFILE.contact } }, employee)).status).toBe(201);
    expect((await create({ profile: { ads: PROFILE.ads } }, owner)).status).toBe(201);
  });

  it("refuses an employee who changes tracking ids on a draft, and accepts the same ids sent back unchanged", async () => {
    const brandId = await draftId({ profile: { contact: PROFILE.contact, ads: { adkit_project: "maple-ads" } } });
    restrict();
    expect((await patch(brandId, { profile: { contact: PROFILE.contact, ads: { adkit_project: "other" } } }, employee)).status).toBe(403);
    expect((await patch(brandId, { profile: { contact: PROFILE.contact } }, employee)).status).toBe(403);
    expect((await patch(brandId, { profile: { contact: { ...PROFILE.contact, phone: "555 010 0100" }, ads: { adkit_project: "maple-ads" } } }, employee)).status).toBe(200);
    expect((await patch(brandId, { profile: { contact: PROFILE.contact, ads: { adkit_project: "other" } } }, owner)).status).toBe(200);
  });
});
