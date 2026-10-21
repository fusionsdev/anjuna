import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_ASSET_MAX_BYTES, brandInitialSvg, bytesToBase64, type BrandAssetBody } from "@anjuna/contracts";
import { CoreError, createBrandWorker } from "../src/index.js";
import { setup } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123"/></svg>';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0]);
const body = (bytes: Uint8Array, content_type: BrandAssetBody["content_type"]): BrandAssetBody => ({ content_type, sha256: "a".repeat(64), body_base64: bytesToBase64(bytes) });
const text = (value: string) => new TextEncoder().encode(value);

describe("uploaded favicon and logo", () => {
  it("serves the favicon bytes at /favicon.ico with its own type, the same for every visitor", async () => {
    const { get, core } = setup();
    core.assets.favicon = body(ICO, "image/x-icon");
    const first = await get("/favicon.ico", { headers: { "user-agent": "Mozilla/5.0", referer: "https://search.example/", "cf-connecting-ip": "192.0.2.1" } });
    const second = await get("/favicon.ico", { headers: { "user-agent": "AdsBot-Google", "accept-language": "de", cookie: "_vc=abc" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/x-icon");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([...ICO]);
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([...ICO]);
    expect([...second.headers].sort()).toEqual([...first.headers].sort());
  });

  it("serves the logo at /brand/logo and asks core once per minute", async () => {
    const { get, core } = setup();
    core.assets.logo = body(PNG, "image/png");
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    for (let i = 0; i < 3; i++) {
      const response = await get("/brand/logo");
      expect([response.status, response.headers.get("content-type")]).toEqual([200, "image/png"]);
      await response.arrayBuffer();
    }
    expect(core.calls.brandAsset).toEqual([{ brand_id: "brand-a", kind: "logo" }]);
    clock.mockReturnValue(2_060_000);
    await (await get("/brand/logo")).arrayBuffer();
    expect(core.calls.brandAsset).toHaveLength(2);
  });

  it("locks an SVG down so it can style itself and nothing else", async () => {
    const { get, core } = setup();
    core.assets.logo = body(text(SVG), "image/svg+xml");
    const response = await get("/brand/logo");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(await response.text()).toBe(SVG);
  });

  it("serves /favicon.svg only when the uploaded favicon is an SVG", async () => {
    const { get, core } = setup();
    core.assets.favicon = body(text(SVG), "image/svg+xml");
    expect(await (await get("/favicon.svg")).text()).toBe(SVG);
    const png = setup();
    png.core.assets.favicon = body(PNG, "image/png");
    expect((await png.get("/favicon.ico")).headers.get("content-type")).toBe("image/png");
    const other = await png.get("/favicon.svg");
    // The template's own favicon.svg is still served; with no such file the path is a plain 404, not the generated icon.
    expect(await other.text()).toBe("<svg/>");
    const bare = setup();
    bare.core.assets.favicon = body(PNG, "image/png");
    bare.assets.fetch.mockImplementation(async () => new Response("asset-store-private-error", { status: 404 }));
    const missing = await bare.get("/favicon.svg");
    expect([missing.status, await missing.text()]).toEqual([404, "Not Found"]);
  });

  it("serves them while the brand is paused, like every other static file", async () => {
    const { get, core } = setup({ paused: true });
    core.assets.favicon = body(PNG, "image/png");
    expect((await get("/favicon.ico")).status).toBe(200);
    expect((await get("/")).status).toBe(503);
  });

  it("answers HEAD and refuses other methods", async () => {
    const { get, core } = setup();
    core.assets.logo = body(PNG, "image/png");
    const head = await get("/brand/logo", { method: "HEAD" });
    expect([head.status, head.headers.get("content-type"), await head.text()]).toEqual([200, "image/png", ""]);
    const post = await get("/brand/logo", { method: "POST" });
    expect([post.status, await post.text()]).toEqual([404, "Not Found"]);
  });
});

describe("no uploaded file", () => {
  it("serves the template's own favicon when the assets hold one", async () => {
    const { get, assets } = setup();
    const response = await get("/favicon.svg");
    expect(await response.text()).toBe("<svg/>");
    expect(assets.fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(["/favicon.svg"]);
  });

  it("serves the generated initial-letter SVG for a favicon the template lacks and for the logo", async () => {
    const { get, core } = setup();
    const expected = brandInitialSvg("Brand A");
    for (const path of ["/favicon.ico", "/brand/logo"]) {
      const response = await get(path);
      expect([response.status, response.headers.get("content-type")]).toEqual([200, "image/svg+xml"]);
      expect(await response.text()).toBe(expected);
    }
    expect(expected).toContain(">B</text>");
    expect(core.calls.brandAsset.map((call) => call.kind)).toEqual(["favicon", "logo"]);
  });

  it("uses the dashboard brand name for the letter and keeps the bytes the same for every visitor", async () => {
    const { get, core } = setup();
    core.settings = { flow_gate_mode: "param", paused: false, amount_buckets: [500], ab_config: null, keyword_default: null, form_route: "/request", brand_name: "Harbor Cash", site_title: null, site_description: null };
    const a = await (await get("/brand/logo", { headers: { "user-agent": "AdsBot-Google" } })).text();
    const b = await (await get("/brand/logo", { headers: { "user-agent": "Mozilla/5.0" } })).text();
    expect(a).toBe(b);
    expect(a).toBe(brandInitialSvg("Harbor Cash"));
  });

  it("falls back, and retries after a minute, when core is down", async () => {
    const { get, core } = setup();
    core.assets.logo = body(PNG, "image/png");
    core.failure = new CoreError(503);
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    expect(await (await get("/brand/logo")).text()).toBe(brandInitialSvg("Brand A"));
    core.failure = null;
    clock.mockReturnValue(3_059_999);
    expect((await get("/brand/logo")).headers.get("content-type")).toBe("image/svg+xml");
    clock.mockReturnValue(3_060_000);
    expect((await get("/brand/logo")).headers.get("content-type")).toBe("image/png");
  });
});

describe("bytes that fail the checks again are never served", () => {
  it.each([
    ["a platform name in an SVG", text(SVG.replace("</svg>", "<title>Anjuna</title></svg>")), "image/svg+xml"],
    ["a platform name in PNG metadata", Uint8Array.from([...PNG, ...text("tEXtAurum")]), "image/png"],
    ["a script in an SVG", text(SVG.replace("</svg>", "<script>x()</script></svg>")), "image/svg+xml"],
    ["an outside reference in an SVG", text(SVG.replace("<rect", '<image href="https://x.test/a.png"/><rect')), "image/svg+xml"],
    ["unknown bytes", text("GIF89a......"), "image/png"],
    ["a favicon above the size cap", Uint8Array.from([...PNG, ...new Uint8Array(BRAND_ASSET_MAX_BYTES.favicon)]), "image/png"],
  ] as const)("%s", async (_name, bytes, type) => {
    const { get, core, assets } = setup();
    assets.fetch.mockImplementation(async () => new Response("asset-store-private-error", { status: 404 }));
    core.assets.favicon = body(bytes, type);
    const response = await get("/favicon.ico");
    // The template has no favicon.ico, so the visitor gets the generated icon, never the stored bytes.
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(brandInitialSvg("Brand A"));
  });

  it("a stored row that does not match the contract is treated as missing", async () => {
    const { get, core } = setup();
    core.assets.logo = { content_type: "image/png", sha256: "short", body_base64: "AAAA" };
    expect(await (await get("/brand/logo")).text()).toBe(brandInitialSvg("Brand A"));
  });
});

describe("reserved paths", () => {
  it("a form route cannot take the logo path", () => {
    const { core, assets } = setup();
    expect(() => createBrandWorker({ brand_id: "brand-a", hostname: "brand-a.example", brand: "Brand A", formRoute: "/brand/logo", amount_buckets: [500], core, assets })).toThrow();
  });
});
