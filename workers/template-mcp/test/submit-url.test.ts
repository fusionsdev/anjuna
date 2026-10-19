import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readZip, type FileMap } from "../src/archive";
import { NEXT_REJECTED, REDUCE_IMAGES, SPA_MESSAGE, isClientRenderedShell, submitTemplateUrl } from "../src/submit";
import { goodSite, serve, spaShell as spa, toZip } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };

const submit = (url: string) =>
  submitTemplateUrl(browserEnv, { url, template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: "bk_test", label: "tester" }, created_by: "bk_test" });
const badge = '<script src="https://bolt.new/badge.js?s=90e0b372"></script>';
const withBadge = (files: FileMap): FileMap =>
  new Map([...files].map(([path, bytes]) => [path, path.endsWith(".html") ? new TextEncoder().encode(new TextDecoder().decode(bytes).replace("</body>", `${badge}</body>`)) : bytes]));
const count = async () => (await env.FACTORY.prepare("SELECT count(*) AS n FROM template_versions").first<{ n: number }>())!.n;

beforeAll(setupDb);
beforeEach(async () => {
  await resetDb();
  vi.mocked(takeScreenshot).mockReset().mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
});
afterEach(() => vi.unstubAllGlobals());

describe("submitTemplateUrl", () => {
  it("tells a client-rendered shell from a static page", () => {
    expect(isClientRenderedShell(spa)).toBe(true);
    expect(isClientRenderedShell(goodSite())).toBe(false);
  });

  it("crawls a published static site and runs the full pipeline", async () => {
    serve(goodSite());
    expect(await submit("https://harbor.bolt.host/")).toMatchObject({ status: "awaiting_approval", template_version_id: "tv_harbor_v1" });
  });

  it("strips the badge script bolt.host injects and reports it as a warning", async () => {
    const pages = [...goodSite().keys()].filter((path) => path.endsWith(".html"));
    expect(pages).toHaveLength(5);

    serve(withBadge(goodSite()));
    const result = await submit("https://harbor.bolt.host/");
    expect(result).toMatchObject({ status: "awaiting_approval", issues: [] });
    expect(result.warnings.filter((w) => w.rule === "host-badge").map((w) => w.file).sort()).toEqual([...pages].sort());
    expect(result.warnings).toContainEqual(expect.objectContaining({ rule: "host-badge", file: "index.html" }));

    const stored = await env.FACTORY.prepare("SELECT r2_key FROM template_versions").first<{ r2_key: string }>();
    const zip = readZip(new Uint8Array(await (await env.ARTIFACTS.get(stored!.r2_key))!.arrayBuffer()));
    for (const path of pages) expect(new TextDecoder().decode(zip.get(path)!)).not.toContain("badge.js");

    await resetDb();
    serve(goodSite());
    const clean = await submit("https://harbor.bolt.host/");
    expect(clean.warnings).toEqual([]);
    expect(clean.sha256).toBe(result.sha256);
  });

  it("does not strip or warn when the URL serves a zip", async () => {
    const zip = toZip(withBadge(goodSite()));
    vi.stubGlobal("fetch", async () => new Response(zip, { headers: { "content-type": "application/zip" } }));
    const result = await submit("https://builds.example.com/site.zip");
    expect(result.warnings.some((w) => w.rule === "host-badge")).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ rule: "external" }));
  });

  it("stops a crawl whose pages add up to more than 30 MB with the archive-limits rejection", async () => {
    const site = goodSite();
    const index = new TextDecoder().decode(site.get("index.html")!);
    const links = [1, 2, 3, 4].map((n) => `<a href="/big${n}/">Page ${n}</a>`).join("");
    site.set("index.html", new TextEncoder().encode(index.replace("</main>", `${links}</main>`)));
    const big = new TextEncoder().encode(`<!doctype html><html><body>${"x".repeat(9 * 1024 * 1024)}</body></html>`);
    for (const n of [1, 2, 3, 4]) site.set(`big${n}/index.html`, big);
    serve(site);
    const result = await submit("https://harbor.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null, next_step: NEXT_REJECTED });
    expect(result.issues).toEqual([{ rule: "archive-limits", message: "The published site is larger than the import limits (2000 files / 30 MB).", fix: REDUCE_IMAGES }]);
    expect(await count()).toBe(0);
  });

  it("rejects an SPA with the static HTML instruction and stores nothing", async () => {
    serve(spa);
    const result = await submit("https://harbor.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null, next_step: SPA_MESSAGE });
    expect(result.issues[0]).toMatchObject({
      rule: "static-html", file: "index.html",
      message: "This site renders with JavaScript. Ask bolt.new to make it static HTML, then submit again.",
    });
    expect(await count()).toBe(0);
  });

  it("rejects a published URL that answers 'Website not found' with the publish-again fix", async () => {
    serve(new Map());
    const result = await submit("https://gone.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    expect(result.issues).toEqual([expect.objectContaining({ rule: "published-url", message: expect.stringContaining("404"), fix: expect.stringContaining("Publish the site again") })]);
    expect(await count()).toBe(0);
  });

  const unreachable: [string, () => Promise<Response>, RegExp][] = [
    ["a network error (DNS or TLS)", async () => { throw new TypeError("fetch failed"); }, /fetch failed/],
    ["a timeout", async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, /timed out/],
    ["more than 3 redirects", async () => new Response(null, { status: 302, headers: { location: "https://loop.bolt.host/next" } }), /redirect/i],
  ];
  it.each(unreachable)("rejects with rule published-url on %s", async (_name, handler, message) => {
    vi.stubGlobal("fetch", handler);
    const result = await submit("https://down.bolt.host/");
    expect(result).toMatchObject({ status: "rejected", template_version_id: null });
    expect(result.issues).toEqual([expect.objectContaining({ rule: "published-url", message: expect.stringMatching(message), fix: expect.stringContaining("Publish the site again") })]);
    expect(await count()).toBe(0);
  });
});
