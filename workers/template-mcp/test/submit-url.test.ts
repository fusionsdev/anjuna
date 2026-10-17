import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SPA_MESSAGE, isClientRenderedShell, submitTemplateUrl } from "../src/submit";
import { goodSite, serve, spaShell as spa } from "./fixtures";
import { resetDb, setupDb } from "./helpers";

vi.mock("../src/screenshots", () => ({ takeScreenshot: vi.fn() }));
import { takeScreenshot } from "../src/screenshots";

const browserEnv = { ...env, BROWSER: {} as Fetcher };

const submit = (url: string) =>
  submitTemplateUrl(browserEnv, { url, template_id: "harbor", template_name: "Harbor", submitted_by: { key_id: "bk_test", label: "tester" }, created_by: "bk_test" });
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
