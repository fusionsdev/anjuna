import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrandWorker, CoreError, HttpsCoreClient } from "../src/index.js";
import { createSettingsCache } from "../src/settings-cache.js";
import { cfg, cookieHeader, HANDOFF, setup } from "./helpers.js";
import settingsFixture from "../../contracts/fixtures/rpc/brandSettings.response.json";
import leadFixture from "../../contracts/fixtures/form/lead.lite_v1.json";
import exampleWorker from "../example/worker.js";

afterEach(() => vi.restoreAllMocks());
const live = () => ({ ...structuredClone(settingsFixture), flow_gate_mode: "param" as const });

describe("live brand settings", () => {
  it("the provisioned BRAND_CONFIG entrypoint retains its cache across requests", async () => {
    const { config, assets } = setup();
    const { core: _core, assets: _assets, ...staticConfig } = config;
    const fetch = vi.fn(async () => Response.json(live()));
    const env = { ASSETS: assets, CORE: { fetch }, CORE_TOKEN: "fixture-credential", BRAND_CONFIG: JSON.stringify(staticConfig) };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let i = 0; i < 2; i++) await (await exampleWorker.fetch(new Request("https://brand-a.example/"), env)).text();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_060_000);
    await (await exampleWorker.fetch(new Request("https://brand-a.example/"), env)).text();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("caches for 60 seconds, coalesces concurrent reads, then reflects pause/resume", async () => {
    const { get, core } = setup();
    core.settings = live();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const responses = await Promise.all([get("/"), get("/"), get("/request?" + HANDOFF)]);
    for (const response of responses) { expect(response.status).toBe(200); await response.text(); }
    expect(core.calls.brandSettings).toHaveLength(1);
    core.settings.paused = true;
    clock.mockReturnValue(1_059_999);
    expect((await get("/")).status).toBe(200);
    clock.mockReturnValue(1_060_000);
    for (const ua of ["Mozilla/5.0", "AdsBot-Google", "curl/8"]) {
      expect((await get("/", { headers: { "user-agent": ua, "cf-connecting-ip": "192.0.2.1" } })).status).toBe(503);
    }
    expect((await get("/request?" + HANDOFF)).status).toBe(503);
    expect(core.calls.brandSettings).toHaveLength(2);
    core.settings.paused = false;
    clock.mockReturnValue(1_120_000);
    expect((await get("/")).status).toBe(200);
  });
  it("applies live weights to new visitors, preserves existing assignment, and refreshes gate/route/keyword/buckets", async () => {
    const { get, core } = setup();
    core.settings = live();
    core.settings.ab_config!.variants = [{ id: "lite_v1", weight: 100 }, { id: "full_v1", weight: 0 }];
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = await get(`/request?${HANDOFF}`);
    const cookie = cookieHeader(first);
    expect((await cfg(first)).variant).toBe("lite_v1");
    core.settings.ab_config!.variants = [{ id: "lite_v1", weight: 0 }, { id: "full_v1", weight: 100 }];
    core.settings.keyword_default = "Quick Cash";
    core.settings.form_route = "/start";
    clock.mockReturnValue(1_060_000);
    expect((await cfg(await get(`/start?${HANDOFF}`, { headers: { cookie } }))).variant).toBe("lite_v1");
    expect(await cfg(await get(`/start?${HANDOFF}`))).toMatchObject({ variant: "full_v1", keyword: "Quick Cash", formRoute: "/start" });
    expect((await get(`/request?${HANDOFF}`)).status).toBe(404);
    core.settings.amount_buckets = [1750]; core.settings.flow_gate_mode = "signed_cookie";
    clock.mockReturnValue(1_120_000);
    expect((await get(`/go?${HANDOFF}`)).headers.get("location")).toBe("/");
    expect((await get("/go?requested_amount=1750&zip=60601")).status).toBe(302);
    expect(core.calls.issueHandoff).toHaveLength(1);
  });
  it("falls back to static config when core is unreachable, times out or sends invalid settings; retries after TTL", async () => {
    const { config, core } = setup({ coreTimeoutMs: 10, keyword_default: "Static Text" });
    const worker = createBrandWorker(config);
    const get = () => worker.fetch(new Request(`https://brand-a.example/request?${HANDOFF}`));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const remote = vi.spyOn(core, "brandSettings").mockRejectedValue(new CoreError(503));
    expect((await cfg(await get())).keyword).toBe("Static Text");
    expect((await cfg(await get())).keyword).toBe("Static Text");
    expect(remote).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_060_000);
    remote.mockImplementation(() => new Promise(() => {}));
    expect((await cfg(await get())).keyword).toBe("Static Text");
    clock.mockReturnValue(1_120_000);
    remote.mockResolvedValue({ status: 200, data: { ...live(), form_route: "/api/leads" } });
    expect((await cfg(await get())).keyword).toBe("Static Text");
    clock.mockReturnValue(1_180_000);
    remote.mockResolvedValue({ status: 200, data: live() });
    expect((await cfg(await get())).keyword).toBe("Fast Cash Loans");
    clock.mockReturnValue(1_240_000);
    remote.mockRejectedValue(new Error("down"));
    expect((await cfg(await get())).keyword).toBe("Static Text");
  });
  it("rejects secret/identity contamination and isolates caches by brand and client", async () => {
    const { config, core } = setup();
    const other = setup({ brand_id: "brand-b", hostname: "brand-b.example", brand: "Brand B" });
    const settingsFor = createSettingsCache();
    const remote = vi.spyOn(core, "brandSettings").mockResolvedValue({ status: 200, data: { ...live(), postback_token_hash: "secret" } } as never);
    expect((await settingsFor(config)).keyword_default).toBeNull();
    remote.mockResolvedValue({ status: 200, data: { ...live(), keyword_default: "Second Brand" } });
    expect((await settingsFor({ ...config, brand_id: "brand-c" })).keyword_default).toBe("Second Brand");
    expect((await settingsFor(other.config)).brand).toBe("Brand B");
    expect(other.core.calls.brandSettings).toHaveLength(1);
    expect((await settingsFor(config)).keyword_default).toBeNull();
  });
  it("forwards GPC and the configured consent brand, ignoring a forged header or browser brand", async () => {
    const { get, core } = setup();
    const submit = vi.spyOn(core, "submitLead");
    await get("/api/leads", { method: "POST", headers: { "sec-gpc": "1", "x-consent-brand": "Forged" },
      body: JSON.stringify({ ...leadFixture, site: { ...leadFixture.site, brand: "Forged" } }) });
    expect(submit).toHaveBeenCalledWith(expect.anything(), { consent_brand: "Brand A", gpc: "1" });
  });
  it("preserves ZIP not-found HTTP 404 across the brand boundary", async () => {
    const { get, core } = setup();
    vi.spyOn(core, "zip").mockResolvedValue({ status: 404, data: { found: false } });
    const response = await get("/api/zip?zip=99999");
    expect([response.status, await response.json()]).toEqual([404, { found: false }]);
  });
  // Deploy order: a brand runtime can reach a core deployed before site text, whose strict request schema answers 400.
  it("falls back through site text only to the bare request on 400s, and serves no site text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const send = vi.fn(async (request: Request) => {
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      if ("include_site_text" in body) return Response.json({ error: "invalid_request" }, { status: 400 });
      return Response.json({ ...live(), keyword_default: "Older Core" });
    });
    const { config } = setup({ core: new HttpsCoreClient({ credential: "test" }, send) });
    const settings = await createSettingsCache()(config);
    expect(bodies).toEqual([{ brand_id: "brand-a", include_site_text: true, include_theme: true }, { brand_id: "brand-a", include_site_text: true }, { brand_id: "brand-a" }]);
    expect(settings.keyword_default).toBe("Older Core");
    expect([settings.brand_name, settings.site_title, settings.site_description]).toEqual([null, null, null]);
  });

  it("does not ask again when core fails with a status other than 400", async () => {
    const send = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const { config } = setup({ core: new HttpsCoreClient({ credential: "test" }, send) });
    const settings = await createSettingsCache()(config);
    expect(send).toHaveBeenCalledTimes(1);
    expect(settings.keyword_default).toBeNull();
  });
});
