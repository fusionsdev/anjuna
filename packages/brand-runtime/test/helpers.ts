import { vi } from "vitest";
import { createBrandWorker, type BrandWorkerConfig } from "../src/index.js";
import { MockCoreClient } from "../src/testing.js";

export const HANDOFF = "requested_amount=750&zip=60601";
export const LANDING = '<!doctype html><html><h1><span data-kw>Default Heading</span></h1><form data-cta action="/go"><input name="zip"><button>Continue</button></form></html>';
export const FORM = '<!doctype html><html><h1><span data-kw>Default Heading</span></h1><script type="application/json" id="cfg">{}</script></html>';

export function setup(overrides: Partial<BrandWorkerConfig> = {}) {
  const core = new MockCoreClient();
  const assets = { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/index.html") return new Response(LANDING, { headers: { "content-type": "text/html", etag: "unchanged" } });
    if (path === "/_f/index.html") return new Response(FORM, { headers: { "content-type": "text/html" } });
    if (/^\/(privacy|terms|disclosures|do-not-sell)\/index.html$/.test(path)) return new Response(`<h1>${path.split("/")[1]}</h1>`);
    if (path.endsWith("/app.js")) return new Response('console.log("ready")', { headers: { "content-type": "text/javascript" } });
    if (path === "/favicon.svg") return new Response("<svg/>");
    return new Response("asset-store-private-error", { status: 404 });
  }) };
  const config: BrandWorkerConfig = {
    brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/request",
    amount_buckets: [500, 750, 1000, 1750, 5000], core, assets, ...overrides,
  };
  const worker = createBrandWorker(config);
  return { config, worker, core, assets, get: (path: string, init?: RequestInit) => worker.fetch(new Request(`https://brand-a.example${path}`, init)) };
}

export function cookies(response: Response): string[] { return response.headers.getSetCookie(); }
export function cookieHeader(response: Response): string { return cookies(response).map((value) => value.split(";")[0]).join("; "); }
export async function cfg(response: Response) {
  const html = await response.text();
  return JSON.parse(html.match(/<script type="application\/json" id="cfg">(.*?)<\/script>/s)![1]!);
}
