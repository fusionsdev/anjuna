import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstallAdsRoutingResponse, InstallMailingListResponse } from "@anjuna/contracts";
import { createHarness, type Harness } from "./helpers.js";

// The install workflow's sync_runtime calls: ads routing into NULL brand_runtime columns, and the brand's own listmonk list.
// listmonk is the outbound stub below; the real ListmonkClient talks to it over HTTP.
const listmonk = { lists: [] as Array<{ id: number; name: string; tags: string[] }>, calls: [] as string[], fail: false };

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    listmonk: { LISTMONK_URL: "https://listmonk.example", LISTMONK_USER: "api", LISTMONK_TOKEN: "fixture-token" },
    outbound: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "listmonk.example" || url.pathname !== "/api/lists") throw new Error(`Unexpected external request: ${request.url}`);
      listmonk.calls.push(`${request.method} ${url.search}`);
      if (listmonk.fail) return new Response("upstream down", { status: 502 });
      if (request.method === "GET") {
        const query = url.searchParams.get("query") ?? "";
        return Response.json({ data: { results: listmonk.lists.filter((list) => list.name.includes(query)) } });
      }
      const body = await request.json() as { name: string; tags: string[]; type: string; optin: string };
      expect(body).toMatchObject({ type: "private", optin: "single" });
      const list = { id: 500 + listmonk.lists.length, name: body.name, tags: body.tags };
      listmonk.lists.push(list);
      return Response.json({ data: list });
    },
  });
});
// h.reset() would clear audit_log, which is append-only once written; only the LEADS tables used here are cleared.
beforeEach(async () => {
  await h.db.batch(["mailing_outbox", "leads", "brand_runtime", "account_credentials"].map((table) => h.db.prepare(`DELETE FROM ${table}`)));
  await h.seedAccount("account-a", "account-a-token");
  listmonk.lists = [];
  listmonk.calls = [];
  listmonk.fail = false;
});
afterAll(async () => { await h?.mf.dispose(); });

const post = (path: string, body: unknown, token = "account-a-token") =>
  h.factoryLifecycle(path, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const route = (brandId = "brand-a") => h.db.prepare("SELECT google_ads_account, google_conversion_action, adkit_project FROM brand_runtime WHERE brand_id = ?1")
  .bind(brandId).first();
const ads = { google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A" };

describe("ads routing at install", () => {
  it("copies the draft route into NULL columns and audits the copy once", async () => {
    await h.seedBrand();
    const response = await post("/ads-routing", { install_id: "ins-1", brand_id: "brand-a", account: "account-a", ads });
    expect(response.status).toBe(200);
    expect(InstallAdsRoutingResponse.parse(await response.json())).toEqual({ copied: ["google_ads_account", "google_conversion_action", "adkit_project"], kept: [] });
    expect(await route()).toEqual(ads);
    const audit = await h.factory.prepare("SELECT actor_id, before_json, after_json FROM audit_log WHERE action = 'lifecycle.runtime.ads_routing' AND json_extract(after_json, '$.install_id') = 'ins-1'").all();
    expect(audit.results).toEqual([{ actor_id: "system", before_json: JSON.stringify({ google_ads_account: null, google_conversion_action: null, adkit_project: null }), after_json: JSON.stringify({ ...ads, install_id: "ins-1" }) }]);

    // A retry of the same step finds every column set and changes nothing.
    const again = await post("/ads-routing", { install_id: "ins-1", brand_id: "brand-a", account: "account-a", ads });
    expect(await again.json()).toEqual({ copied: [], kept: ["google_ads_account", "google_conversion_action", "adkit_project"] });
    expect(Number((await h.factory.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'lifecycle.runtime.ads_routing' AND json_extract(after_json, '$.install_id') = 'ins-1'").first<{ n: number }>())!.n)).toBe(1);
  });

  it("never overwrites an owner-set value and fills only the NULL ones", async () => {
    await h.seedBrand();
    await h.db.prepare("UPDATE brand_runtime SET google_ads_account = '1234567890', google_conversion_action = '111' WHERE brand_id = 'brand-a'").run();
    const response = await post("/ads-routing", { install_id: "ins-2", brand_id: "brand-a", account: "account-a", ads: { ...ads, google_conversion_action: "222" } });
    expect(await response.json()).toEqual({ copied: ["adkit_project"], kept: ["google_ads_account", "google_conversion_action"] });
    expect(await route()).toEqual({ google_ads_account: "1234567890", google_conversion_action: "111", adkit_project: "proj_A" });
  });

  it("does not pair another account's conversion action with an owner-set account", async () => {
    await h.seedBrand();
    await h.db.prepare("UPDATE brand_runtime SET google_ads_account = '9999999999' WHERE brand_id = 'brand-a'").run();
    const response = await post("/ads-routing", { install_id: "ins-3", brand_id: "brand-a", account: "account-a", ads });
    expect(await response.json()).toEqual({ copied: ["adkit_project"], kept: ["google_ads_account", "google_conversion_action"] });
    expect(await route()).toEqual({ google_ads_account: "9999999999", google_conversion_action: null, adkit_project: "proj_A" });
  });

  it("does not copy a conversion action without its account", async () => {
    await h.seedBrand();
    const response = await post("/ads-routing", { install_id: "ins-4", brand_id: "brand-a", account: "account-a", ads: { google_conversion_action: "7754587837" } });
    expect(await response.json()).toEqual({ copied: [], kept: ["google_conversion_action"] });
    expect(await route()).toEqual({ google_ads_account: null, google_conversion_action: null, adkit_project: null });
  });

  it("refuses another account, an invalid route and a brand without runtime", async () => {
    await h.seedBrand("brand-b", "T", "account-b");
    expect((await post("/ads-routing", { install_id: "ins-5", brand_id: "brand-b", account: "account-a", ads })).status).toBe(403);
    expect((await post("/ads-routing", { install_id: "ins-5", brand_id: "brand-a", account: "account-a", ads: { google_ads_account: "123-456" } })).status).toBe(422);
    expect((await post("/ads-routing", { install_id: "ins-5", brand_id: "brand-a", account: "account-a", ads })).status).toBe(409);
    expect(await route("brand-b")).toEqual({ google_ads_account: null, google_conversion_action: null, adkit_project: null });
  });
});

describe("per-brand listmonk list at install", () => {
  const list = (brandId = "brand-a") => h.db.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = ?1").bind(brandId).first();

  it("creates the list named after the apex host, stores its id, and a retry makes no listmonk call", async () => {
    await h.seedBrand();
    const response = await post("/mailing-list", { install_id: "ins-1", brand_id: "brand-a", account: "account-a" });
    expect(response.status).toBe(200);
    expect(InstallMailingListResponse.parse(await response.json())).toEqual({ state: "created", list_id: 500 });
    expect(listmonk.lists).toEqual([{ id: 500, name: "brand-a.example", tags: ["brand-a"] }]);
    expect(await list()).toEqual({ listmonk_list_id: 500 });

    listmonk.calls = [];
    expect(await (await post("/mailing-list", { install_id: "ins-1", brand_id: "brand-a", account: "account-a" })).json()).toEqual({ state: "stored", list_id: 500 });
    expect(listmonk.calls).toEqual([]);
  });

  it("reuses a list an earlier attempt created before its id was stored", async () => {
    await h.seedBrand();
    listmonk.lists.push({ id: 77, name: "brand-a.example", tags: ["brand-a"] });
    expect(await (await post("/mailing-list", { install_id: "ins-2", brand_id: "brand-a", account: "account-a" })).json()).toEqual({ state: "found", list_id: 77 });
    expect(listmonk.lists).toHaveLength(1);
  });

  it("answers 502 with a clear message on a listmonk failure, stores nothing and keeps every lead", async () => {
    await h.seedBrand();
    await h.seedLead("lead-1");
    await h.db.prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES ('lead-1', 'brand-a', datetime('now'))").run();
    listmonk.fail = true;
    const response = await post("/mailing-list", { install_id: "ins-3", brand_id: "brand-a", account: "account-a" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "listmonk_failed", message: "listmonk list was not created: listmonk GET lists failed: 502" });
    expect(await list()).toEqual({ listmonk_list_id: null });
    expect(await h.db.prepare("SELECT (SELECT count(*) FROM leads) AS leads, (SELECT count(*) FROM mailing_outbox WHERE status = 'pending') AS pending").first()).toEqual({ leads: 1, pending: 1 });
  });

  it("refuses another account's brand and a brand without runtime", async () => {
    await h.seedBrand("brand-b", "T", "account-b");
    expect((await post("/mailing-list", { install_id: "ins-4", brand_id: "brand-b", account: "account-a" })).status).toBe(403);
    expect((await post("/mailing-list", { install_id: "ins-4", brand_id: "brand-a", account: "account-a" })).status).toBe(409);
    expect(listmonk.calls).toEqual([]);
  });
});

describe("per-brand listmonk list without listmonk credentials", () => {
  it("answers not_configured and makes no request", async () => {
    const local = await createHarness();
    try {
      await local.seedAccount("account-a", "account-a-token");
      await local.seedBrand();
      const response = await local.factoryLifecycle("/mailing-list", "account-a-token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ install_id: "ins-5", brand_id: "brand-a", account: "account-a" }),
      });
      expect(await response.json()).toEqual({ state: "not_configured", list_id: null });
    } finally {
      await local.mf.dispose();
    }
  });
});
