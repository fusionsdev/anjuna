import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrandClean } from "@anjuna/contracts";
import settingsFixture from "../../contracts/fixtures/rpc/brandSettings.response.json";
import { createBrandWorker, HttpsCoreClient, type BrandWorkerConfig } from "../src/index.js";
import { MockCoreClient } from "../src/testing.js";
import { HANDOFF, LANDING } from "./helpers.js";

const INDEX = '<!doctype html><html><head><title>Harbor | Funding Options</title><style>:root{--color-royal:#2563eb}</style></head><body><h1><span data-kw>Funding Options</span></h1><form data-cta method="get" action="/go"><input name="zip"></form></body></html>';
const LEGAL = (name: string) => `<!doctype html><html><head><title>${name} | Harbor</title></head><body><h1>${name}</h1></body></html>`;
const FORM = '<!doctype html><html><head><title>Request</title></head><body><script type="application/json" id="cfg">{}</script></body></html>';
const LEGAL_PAGES = ["/privacy", "/terms", "/disclosures", "/do-not-sell"];
const THEME = { primary: "#0f766e", secondary: "#1e293b" };
const VARS = { primary: ["--color-royal"], primary_dark: ["--color-royal-dark"], secondary: ["--color-ink"] };
const BLOCK = '<style id="brand-theme">:root{--color-royal:#0f766e;--color-royal-dark:#0d6861;--color-ink:#1e293b}</style>';
const PAGES = ["/", "/privacy", `/request?${HANDOFF}`];

function site(overrides: Partial<BrandWorkerConfig> = {}, index = INDEX) {
  const core = new MockCoreClient();
  const pages: Record<string, string> = { "/index.html": index, "/_f/index.html": FORM };
  for (const page of LEGAL_PAGES) pages[`${page}/index.html`] = LEGAL(page.slice(1));
  const assets = { fetch: vi.fn(async (request: Request) => {
    const body = pages[new URL(request.url).pathname];
    return body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 });
  }) };
  const worker = createBrandWorker({
    brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/request",
    amount_buckets: [500, 750, 1000, 1750, 5000], core, assets, ...overrides,
  });
  return { core, get: (path: string, init?: RequestInit) => worker.fetch(new Request(`https://brand-a.example${path}`, init)) };
}
// ab_config null: no variant cookie, so two workers serve comparable responses.
const live = (extra: Record<string, unknown> = {}) => ({ ...structuredClone(settingsFixture), flow_gate_mode: "param" as const, ab_config: null, ...extra });
const block = (html: string) => html.match(/<style id="brand-theme">.*?<\/style>/s)?.[0] ?? null;
async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

afterEach(() => vi.restoreAllMocks());

describe("brand theme", () => {
  it("appends the theme block as the last child of head on the index page", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    const html = await (await get("/")).text();
    expect(html).toContain(`${BLOCK}</head>`);
    expect(html.indexOf("--color-royal:#2563eb")).toBeLessThan(html.indexOf(BLOCK));
  });

  it("adds the block to every legal page and not to the form page", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    for (const page of LEGAL_PAGES) expect(await (await get(page)).text()).toContain(`${BLOCK}</head>`);
    const form = await (await get(`/request?${HANDOFF}`)).text();
    expect(form).toContain("<title>Request</title></head>");
    expect(form).not.toContain("brand-theme");
  });

  it("serves bytes identical to a brand without theme support when theme or vars are missing", async () => {
    const baseline = site();
    baseline.core.settings = live();
    const cases = [
      { name: "no theme", vars: VARS, theme: null },
      { name: "no vars", vars: undefined, theme: THEME },
      { name: "empty vars", vars: { primary: [], primary_dark: [], secondary: [] }, theme: THEME },
    ];
    for (const item of cases) {
      const themed = site(item.vars ? { theme_vars: item.vars } : {});
      themed.core.settings = live({ theme: item.theme });
      for (const page of PAGES) {
        expect(await snapshot(await themed.get(page)), `${item.name} ${page}`).toEqual(await snapshot(await baseline.get(page)));
      }
    }
  });

  it("serves identical bytes to different visitors", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    const visitors: [string, RequestInit][] = [
      ["", {}],
      ["", { headers: { "user-agent": "AdsBot-Google", "cf-connecting-ip": "192.0.2.1" } }],
      ["", { headers: { "user-agent": "curl/8", "cf-connecting-ip": "2001:db8::1", referer: "https://www.google.com/" } }],
      ["?gclid=test-click", { headers: { "user-agent": "Mozilla/5.0", referer: "https://search.example/" } }],
    ];
    const legal = new Set<string>();
    for (const [query, init] of visitors) {
      expect(block(await (await get(`/${query}`, init)).text())).toBe(BLOCK);
      legal.add(await (await get(`/privacy${query}`, init)).text());
    }
    expect(legal.size).toBe(1);
    expect([...legal][0]).toContain(BLOCK);
  });

  it("ignores an invalid live theme and serves the template colors", async () => {
    // Core answered: its live settings without a theme.
    const answered = site();
    answered.core.settings = live();
    const invalidLive = site({ theme_vars: VARS });
    invalidLive.core.settings = live({ theme: { primary: "red", secondary: "#1e293b" } }) as never;
    const invalidVars = site({ theme_vars: { primary: ["--color-royal;color:red"], primary_dark: [], secondary: [] } as never });
    invalidVars.core.settings = live({ theme: THEME });
    const leakingVars = site({ theme_vars: { primary: ["--anjuna-royal"], primary_dark: [], secondary: [] } });
    leakingVars.core.settings = live({ theme: THEME });
    for (const [themed, baseline] of [[invalidLive, answered], [invalidVars, answered], [leakingVars, answered]] as const) {
      const html = await (await themed.get("/")).text();
      expect(html).not.toContain("brand-theme");
      expect(html).toBe(await (await baseline.get("/")).text());
    }
  });

  it("ignores a theme baked into BRAND_CONFIG", async () => {
    // Core answered 200 with no theme (null, or no key at all from a core deployed before brand colors).
    for (const answer of [live({ theme: null }), live()]) {
      const baseline = site({ theme_vars: VARS });
      baseline.core.settings = answer as never;
      const baked = site({ theme_vars: VARS, theme: THEME });
      baked.core.settings = answer as never;
      const html = await (await baked.get("/")).text();
      expect(html).not.toContain("brand-theme");
      expect(html).toBe(await (await baseline.get("/")).text());
    }
  });

  it("keeps live paused and site text when core sends an invalid theme", async () => {
    const pausedSite = site({ theme_vars: VARS });
    pausedSite.core.settings = live({ paused: true, site_title: "Live Title", theme: { primary: "#fff", secondary: "#1e293b" } }) as never;
    expect((await pausedSite.get("/")).status).toBe(503);
    const textSite = site({ theme_vars: VARS });
    textSite.core.settings = live({ site_title: "Live Title", theme: { primary: "#fff", secondary: "#1e293b" } }) as never;
    const html = await (await textSite.get("/")).text();
    expect(html).toContain("<title>Live Title</title>");
    expect(html).not.toContain("brand-theme");
  });

  it("keeps live paused and site text when core sends an invalid theme over HTTPS", async () => {
    const answer = (extra: Record<string, unknown>) => async () =>
      Response.json(live({ site_title: "Live Title", theme: { primary: "#fff", secondary: "#1e293b" }, ...extra }));
    const paused = site({ theme_vars: VARS, core: new HttpsCoreClient({ credential: "test" }, vi.fn(answer({ paused: true }))) });
    expect((await paused.get("/")).status).toBe(503);
    const text = site({ theme_vars: VARS, core: new HttpsCoreClient({ credential: "test" }, vi.fn(answer({}))) });
    const html = await (await text.get("/")).text();
    expect(html).toContain("<title>Live Title</title>");
    expect(html).not.toContain("brand-theme");
  });

  it("asks core with include_site_text and include_theme", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    await (await get("/")).text();
    expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a", include_site_text: true, include_theme: true }]);
  });

  // Deploy order: a brand runtime can reach a core deployed before brand colors (400 on include_theme), or one
  // deployed before site text too (400 on include_site_text).
  it("falls back to site text only when core refuses include_theme", async () => {
    const run = async (refuses: (body: Record<string, unknown>) => boolean) => {
      const bodies: Record<string, unknown>[] = [];
      const send = vi.fn(async (request: Request) => {
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        if (refuses(body)) return Response.json({ error: "invalid_request" }, { status: 400 });
        return Response.json(live("include_site_text" in body ? { brand_name: null, site_title: "Older Core Title", site_description: null } : { keyword_default: "Oldest Core" }));
      });
      const { get } = site({ theme_vars: VARS, core: new HttpsCoreClient({ credential: "test" }, send) });
      return { bodies, html: await (await get("/")).text() };
    };
    const older = await run((body) => "include_theme" in body);
    expect(older.bodies).toEqual([{ brand_id: "brand-a", include_site_text: true, include_theme: true }, { brand_id: "brand-a", include_site_text: true }]);
    expect(older.html).toContain("<title>Older Core Title</title>");
    expect(older.html).not.toContain("brand-theme");
    const oldest = await run((body) => "include_site_text" in body);
    expect(oldest.bodies).toEqual([
      { brand_id: "brand-a", include_site_text: true, include_theme: true }, { brand_id: "brand-a", include_site_text: true }, { brand_id: "brand-a" },
    ]);
    expect(oldest.html).toContain("<title>Harbor | Funding Options</title>");
    expect(oldest.html).not.toContain("brand-theme");
  });

  it("applies a Settings change within the 60 second TTL", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(block(await (await get("/")).text())).toBe(BLOCK);
    core.settings = live({ theme: { primary: "#2563eb", secondary: "#f59e0b" } });
    clock.mockReturnValue(1_059_999);
    expect(block(await (await get("/")).text())).toBe(BLOCK);
    clock.mockReturnValue(1_060_000);
    expect(block(await (await get("/")).text())).toBe('<style id="brand-theme">:root{--color-royal:#2563eb;--color-royal-dark:#2157cf;--color-ink:#f59e0b}</style>');
    core.settings = live({ theme: null });
    clock.mockReturnValue(1_120_000);
    expect(await (await get("/")).text()).not.toContain("brand-theme");
  });

  it("keeps the block brand clean", async () => {
    const { get, core } = site({ theme_vars: VARS });
    core.settings = live({ theme: THEME });
    const found = block(await (await get("/")).text());
    expect(found).toBe(BLOCK);
    expect(isBrandClean(found!)).toBe(true);
  });

  it("does not inject into a page without a head element", async () => {
    const { get, core } = site({ theme_vars: VARS }, LANDING);
    core.settings = live({ theme: THEME });
    const html = await (await get("/")).text();
    expect(html).toContain("<h1><span data-kw>Fast Cash Loans</span></h1>");
    expect(html).not.toContain("brand-theme");
  });
});
