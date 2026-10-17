import { afterEach, describe, expect, it, vi } from "vitest";
import leadFixture from "../../contracts/fixtures/form/lead.lite_v1.json";
import settingsFixture from "../../contracts/fixtures/rpc/brandSettings.response.json";
import { createBrandWorker, HttpsCoreClient, type BrandWorkerConfig } from "../src/index.js";
import { MockCoreClient } from "../src/testing.js";
import { cfg, HANDOFF } from "./helpers.js";

const INDEX = '<!doctype html><html><head><title>Harbor | Funding Options</title><meta name="description" content="Harbor helps you compare."><meta property="og:title" content="Harbor | Funding Options"><meta property="og:description" content="Harbor helps you compare."></head><body><header><a href="/" data-brand>Harbor</a></header><h1><span data-kw>Funding Options</span></h1><form data-cta method="get" action="/go"><input name="zip"></form><footer><span data-brand>Harbor</span></footer></body></html>';
const PRIVACY = '<!doctype html><html><head><title>Privacy Policy | Harbor &amp; Co</title><meta name="description" content="How Harbor uses data."></head><body><a href="/" data-brand>Harbor</a></body></html>';
const FORM = '<!doctype html><html><head><title>Request</title></head><body><span data-brand>Harbor</span><script type="application/json" id="cfg">{}</script></body></html>';
const DEFAULTS = { brand_name: "Harbor", title: "Harbor | Funding Options", description: "Harbor helps you compare." };

function site(overrides: Partial<BrandWorkerConfig> = {}) {
  const core = new MockCoreClient();
  const pages: Record<string, string> = { "/index.html": INDEX, "/privacy/index.html": PRIVACY, "/_f/index.html": FORM };
  const assets = { fetch: vi.fn(async (request: Request) => {
    const body = pages[new URL(request.url).pathname];
    return body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 });
  }) };
  const worker = createBrandWorker({
    brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/request",
    amount_buckets: [500, 750, 1000, 1750, 5000], text_defaults: DEFAULTS, core, assets, ...overrides,
  });
  return { core, get: (path: string, init?: RequestInit) => worker.fetch(new Request(`https://brand-a.example${path}`, init)) };
}
const live = (text: Record<string, string | null>) => ({ ...structuredClone(settingsFixture), flow_gate_mode: "param" as const, ...text });

afterEach(() => vi.restoreAllMocks());

describe("site text", () => {
  // Controller ruling (final review Important 4): a brand made as "Brand A" from a "Harbor" template never shows "Harbor" as its name.
  it("serves the template text with the brand display name when nothing was edited", async () => {
    const html = await (await site().get("/")).text();
    expect(html).toContain("<title>Brand A | Funding Options</title>");
    expect(html).toContain('<meta property="og:title" content="Brand A | Funding Options">');
    expect(html).toContain('<meta name="description" content="Harbor helps you compare.">');
    expect(html).toContain('<a href="/" data-brand>Brand A</a>');
    expect(html).toContain("<footer><span data-brand>Brand A</span></footer>");
  });

  it("keeps an unedited 80 character template title and a distinct og:title", async () => {
    const title = "Compare Funding Options From Trusted Lenders Nationally In One Easy Request Form";
    expect(title).toHaveLength(80);
    const index = `<!doctype html><html><head><title>${title}</title><meta property="og:title" content="Harbor &amp; You: Options Today"><meta name="description" content="Template words."></head><body><span data-brand>Harbor</span></body></html>`;
    const assets = { fetch: async () => new Response(index, { headers: { "content-type": "text/html" } }) };
    const { get, core } = site({ assets, text_defaults: { brand_name: "Harbor", title: title.slice(0, 70).trim(), description: "Template words." } });
    core.settings = live({ brand_name: null, site_title: null, site_description: null });
    const html = await (await get("/")).text();
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain('<meta property="og:title" content="Brand A &amp; You: Options Today">');
    expect(html).toContain('<meta name="description" content="Template words.">');
  });

  it("changes only the brand inside the index title and og:title when only the brand name was edited", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const html = await (await get("/")).text();
    expect(html).toContain("<title>Quick Funds | Funding Options</title>");
    expect(html).toContain('<meta property="og:title" content="Quick Funds | Funding Options">');
    expect(html).toContain('<meta name="description" content="Harbor helps you compare.">');
    expect(html).toContain('<meta property="og:description" content="Harbor helps you compare.">');
  });

  it("matches the template brand only as a whole word and never inside an entity", async () => {
    const pages: Record<string, string> = {
      "/index.html": "<!doctype html><html><head><title>Max | Maximum Savings, Max2 and Max</title></head><body></body></html>",
      "/terms/index.html": "<!doctype html><html><head><title>nbsp&nbsp;Terms &amp; amp</title></head><body></body></html>",
    };
    const assets = { fetch: async (request: Request) => new Response(pages[new URL(request.url).pathname] ?? "missing", { status: pages[new URL(request.url).pathname] ? 200 : 404 }) };
    const max = site({ assets, text_defaults: { brand_name: "Max", title: null, description: null } });
    max.core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    expect(await (await max.get("/")).text()).toContain("<title>Quick Funds | Maximum Savings, Max2 and Quick Funds</title>");
    const nbsp = site({ assets, text_defaults: { brand_name: "nbsp", title: null, description: null } });
    nbsp.core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    expect(await (await nbsp.get("/terms")).text()).toContain("<title>Quick Funds&nbsp;Terms &amp; amp</title>");
    const amp = site({ assets, text_defaults: { brand_name: "amp", title: null, description: null } });
    amp.core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    expect(await (await amp.get("/terms")).text()).toContain("<title>nbsp&nbsp;Terms &amp; Quick Funds</title>");
  });

  it("writes edited title, description and og tags on the index page", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: "Quick Funds | Check Options", site_description: "Fast & fair options." });
    const html = await (await get("/")).text();
    expect(html).toContain("<title>Quick Funds | Check Options</title>");
    expect(html).toContain('<meta name="description" content="Fast &amp; fair options.">');
    expect(html).toContain('<meta property="og:title" content="Quick Funds | Check Options">');
    expect(html).toContain('<meta property="og:description" content="Fast &amp; fair options.">');
    expect(html).toContain('<a href="/" data-brand>Quick Funds</a>');
    expect(html).toContain("<footer><span data-brand>Quick Funds</span></footer>");
    expect(html).not.toContain("Harbor");
  });

  it("replaces only the brand name in other pages' titles and keeps their descriptions", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const html = await (await get("/privacy")).text();
    expect(html).toContain("<title>Privacy Policy | Quick Funds &amp; Co</title>");
    expect(html).toContain('<meta name="description" content="How Harbor uses data.">');
    expect(html).toContain('<a href="/" data-brand>Quick Funds</a>');
  });

  it("uses one brand name for the page, cfg.brand and the consent header", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const form = await get(`/request?${HANDOFF}`);
    const body = await form.clone().text();
    expect((await cfg(form)).brand).toBe("Quick Funds");
    expect(body).toContain("<span data-brand>Quick Funds</span>");
    const submit = vi.spyOn(core, "submitLead");
    await get("/api/leads", { method: "POST", body: JSON.stringify(leadFixture) });
    expect(submit).toHaveBeenCalledWith(expect.anything(), { consent_brand: "Quick Funds" });
  });

  it("asks core for site text and serves the template text with the brand display name when core is unreachable", async () => {
    const { get, core } = site();
    core.failure = new Error("core down");
    expect(await (await get("/")).text()).toContain("<title>Brand A | Funding Options</title>");
    expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a", include_site_text: true }]);
  });

  it("shows an edit within the 60 second settings TTL", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: null, site_title: "First Title", site_description: null });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await (await get("/")).text()).toContain("<title>First Title</title>");
    core.settings = live({ brand_name: null, site_title: "Second Title", site_description: null });
    clock.mockReturnValue(1_060_000);
    expect(await (await get("/")).text()).toContain("<title>Second Title</title>");
  });

  it("serves identical HTML to every visitor", async () => {
    const { get, core } = site();
    core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    const bodies = new Set<string>();
    for (const headers of [{ "user-agent": "Mozilla/5.0" }, { "user-agent": "AdsBot-Google", "cf-connecting-ip": "66.249.66.1" }, { referer: "https://www.google.com/" }] as Record<string, string>[]) {
      bodies.add(await (await get("/", { headers })).text());
    }
    expect(bodies.size).toBe(1);
  });

  it("keeps serving with the factory brand name when baked text defaults are invalid or missing", async () => {
    const bad = site({ text_defaults: { brand_name: "Personal Loans Inc", title: "x", description: null } as never });
    expect(await (await bad.get("/")).text()).toContain('<a href="/" data-brand>Brand A</a>');
    const none = site({ text_defaults: undefined });
    expect(await (await none.get("/")).text()).toContain('<a href="/" data-brand>Brand A</a>');
  });

  // Controller ruling: core unreachable and no baked defaults leave the template's title and meta tags as they are.
  it("leaves the template title and meta tags as they are when core is unreachable and no defaults are baked", async () => {
    const { get, core } = site({ text_defaults: undefined });
    core.failure = new Error("core down");
    const html = await (await get("/")).text();
    expect(html).toContain("<title>Harbor | Funding Options</title>");
    expect(html).toContain('<meta name="description" content="Harbor helps you compare.">');
    expect(html).toContain('<meta property="og:title" content="Harbor | Funding Options">');
    expect(html).toContain('<meta property="og:description" content="Harbor helps you compare.">');
  });

  // Controller ruling C9: only head > title changes. An inline SVG <title> in the body is an accessible icon label.
  it("rewrites only the head title and leaves inline SVG titles in the body unchanged", async () => {
    const svg = '<svg role="img"><title>Harbor logo</title><circle r="4"></circle></svg>';
    const pages: Record<string, string> = {
      "/index.html": `<!doctype html><html><head><title>Harbor | Funding Options</title></head><body>${svg}<span data-brand>Harbor</span></body></html>`,
      "/privacy/index.html": `<!doctype html><html><head><title>Privacy Policy | Harbor</title></head><body>${svg}</body></html>`,
    };
    const assets = { fetch: async (request: Request) => new Response(pages[new URL(request.url).pathname] ?? "missing", { status: pages[new URL(request.url).pathname] ? 200 : 404 }) };
    const { get, core } = site({ assets });
    core.settings = live({ brand_name: "Quick Funds", site_title: "Quick Funds | Check Options", site_description: null });
    const index = await (await get("/")).text();
    expect(index).toContain("<head><title>Quick Funds | Check Options</title></head>");
    expect(index).toContain(svg);
    const privacy = await (await get("/privacy")).text();
    expect(privacy).toContain("<head><title>Privacy Policy | Quick Funds</title></head>");
    expect(privacy).toContain(svg);
  });

  it("keeps other entities in other pages' titles and matches an encoded template brand name", async () => {
    const pages: Record<string, string> = {
      "/index.html": "<!doctype html><html><head><title>Home</title></head><body></body></html>",
      "/terms/index.html": "<!doctype html><html><head><title>Terms&nbsp;&mdash; Harbor &amp; Sons</title></head><body></body></html>",
      "/privacy/index.html": "<!doctype html><html><head><title>Privacy | Harbor &#39;n&#x27; Sons</title></head><body></body></html>",
    };
    const assets = { fetch: async (request: Request) => new Response(pages[new URL(request.url).pathname] ?? "missing", { status: pages[new URL(request.url).pathname] ? 200 : 404 }) };
    const amp = site({ assets, text_defaults: { brand_name: "Harbor & Sons", title: null, description: null } });
    amp.core.settings = live({ brand_name: "Quick & Fair", site_title: "Quick & Fair | Options", site_description: null });
    expect(await (await amp.get("/terms")).text()).toContain("<title>Terms&nbsp;&mdash; Quick &amp; Fair</title>");
    expect(await (await amp.get("/")).text()).toContain("<title>Quick &amp; Fair | Options</title>");
    const apostrophe = site({ assets, text_defaults: { brand_name: "Harbor 'n' Sons", title: null, description: null } });
    apostrophe.core.settings = live({ brand_name: "Quick Funds", site_title: null, site_description: null });
    expect(await (await apostrophe.get("/privacy")).text()).toContain("<title>Privacy | Quick Funds</title>");
  });

  // Controller ruling: the x-consent-brand header core receives equals the brand name the form and page show.
  it("sends the shown brand name to core in the x-consent-brand header", async () => {
    const accepted = { status: "accepted", lead_id: leadFixture.lead_id, reference: "ref", continuation: "continue_00000000000001" };
    const send = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/rpc/brandSettings") return Response.json(live({ brand_name: "Quick Funds Å", site_title: null, site_description: null }));
      if (path === "/rpc/submitLead") return Response.json(accepted, { status: 201 });
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    const { get } = site({ core: new HttpsCoreClient({ credential: "test-account-credential" }, send) });
    const form = await get(`/request?${HANDOFF}`);
    const body = await form.clone().text();
    expect((await cfg(form)).brand).toBe("Quick Funds Å");
    expect(body).toContain("<span data-brand>Quick Funds Å</span>");
    expect((await get("/api/leads", { method: "POST", body: JSON.stringify(leadFixture) })).status).toBe(201);
    const settingsRequest = send.mock.calls.map(([request]) => request).find((request) => request.url.endsWith("/rpc/brandSettings"))!;
    expect(await settingsRequest.json()).toEqual({ brand_id: "brand-a", include_site_text: true });
    const submitRequest = send.mock.calls.map(([request]) => request).find((request) => request.url.endsWith("/rpc/submitLead"))!;
    expect(decodeURIComponent(submitRequest.headers.get("x-consent-brand")!)).toBe("Quick Funds Å");
  });
});
