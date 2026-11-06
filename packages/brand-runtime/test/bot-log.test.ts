import { describe, expect, it, vi } from "vitest";
import { classifyUserAgent, reportBotHit } from "../src/bot-log.js";
import entry from "../src/entry.js";
import { setup } from "./helpers.js";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const ADSBOT = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) AppleWebKit/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)";
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

describe("classifyUserAgent", () => {
  it.each([
    [GOOGLEBOT, "googlebot"],
    ["Mozilla/5.0 (compatible; Google-InspectionTool/1.0)", "googlebot"],
    ["AdsBot-Google (+http://www.google.com/adsbot.html)", "adsbot"],
    [ADSBOT, "adsbot"],
    ["Mediapartners-Google", "adsbot"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "other-bot"],
    [HUMAN, "human"],
    ["", "human"],
    [null, "human"],
  ] as const)("%s is %s", (ua, kind) => { expect(classifyUserAgent(ua)).toBe(kind); });
});

function fixture() {
  const { core: _core, assets, ...settings } = setup().config;
  const hits: unknown[] = [];
  const core = { fetch: vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/rpc/botHit") { hits.push(await request.json()); return Response.json({ ok: true }); }
    return new Response("{}", { status: 503 });
  }) };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { env: { ASSETS: assets, CORE: core, CORE_TOKEN: "t", BRAND_CONFIG: settings }, hits, ctx, settle: () => Promise.all(pending) };
}

const visit = (path: string, ua: string | null) =>
  new Request(`https://brand-a.example${path}`, { headers: ua ? { "user-agent": ua } : {} });

describe("bot logging at the brand entry", () => {
  it.each(["/", "/privacy"])("serves identical bytes and headers to Googlebot and a human on %s", async (path) => {
    const bot = fixture(); const human = fixture();
    const botRes = await entry.fetch(visit(path, GOOGLEBOT), bot.env, bot.ctx);
    const humanRes = await entry.fetch(visit(path, HUMAN), human.env, human.ctx);
    await Promise.all([bot.settle(), human.settle()]);
    expect([botRes.status, await botRes.text(), [...botRes.headers].sort()])
      .toEqual([humanRes.status, await humanRes.text(), [...humanRes.headers].sort()]);
    expect(bot.hits).toHaveLength(1);
    expect(human.hits).toHaveLength(0);
  });

  it("sends brand id, kind, path and time only: no ip and no user agent string", async () => {
    const f = fixture();
    await entry.fetch(visit("/?gclid=abc", ADSBOT), f.env, f.ctx);
    await f.settle();
    expect(f.hits).toEqual([{ brand_id: "brand-a", kind: "adsbot", path: "/", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
  });

  it("logs nothing for a human or a request without a user agent", async () => {
    const f = fixture();
    await entry.fetch(visit("/", HUMAN), f.env, f.ctx);
    await entry.fetch(visit("/", null), f.env, f.ctx);
    await f.settle();
    expect(f.hits).toEqual([]);
  });

  it("answers normally and never rejects when the log call fails", async () => {
    const f = fixture();
    const env = { ...f.env, CORE: { fetch: async () => { throw new Error("core down"); } } };
    const res = await entry.fetch(visit("/", GOOGLEBOT), env, f.ctx);
    expect(res.status).toBe(200);
    await expect(f.settle()).resolves.toBeDefined();
  });

  it("returns before the log call settles", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const env = { ...f.env, CORE: { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/rpc/botHit") await gate;
      return new Response("{}", { status: 503 });
    } } };
    const res = await entry.fetch(visit("/", GOOGLEBOT), env, f.ctx);
    expect(res.status).toBe(200);
    release();
    await f.settle();
  });
});

describe("reportBotHit", () => {
  it("swallows a rejected core call", async () => {
    await expect(reportBotHit({ botHit: async () => { throw new Error("x"); } },
      { brand_id: "b", request: visit("/", GOOGLEBOT) })).resolves.toBeUndefined();
  });
});
