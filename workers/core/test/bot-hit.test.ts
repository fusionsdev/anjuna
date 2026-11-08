import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertsReportResponse, type AdminRequestContext } from "@anjuna/contracts";
import { botHour } from "../src/rpc/bot-hit.js";
import { createHarness, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness({ brand: true }); });
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => {
  await h.reset();
  await h.seedAccount();
  await h.seedBrand();
  await h.seedBrand("brand-b", "U", "account-b");
});

const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_bot_hit_0001" };
const post = (body: unknown, token = "account-a-token") => h.request("/rpc/botHit", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const hit = (kind: string, at: string, brand_id = "brand-a") => post({ brand_id, kind, path: "/", at });
const rows = async () => (await h.db.prepare("SELECT brand_id, hour, kind, hits FROM bot_hits ORDER BY brand_id, hour, kind").all()).results;
const stamp = () => new Date().toISOString();

describe("botHit rpc", () => {
  it("counts one row per brand, hour and kind with an upsert increment", async () => {
    const at = stamp();
    for (let i = 0; i < 3; i++) expect((await hit("googlebot", at)).status).toBe(200);
    await hit("adsbot", at);
    const hour = botHour(Date.parse(at));
    expect(await rows()).toEqual([
      { brand_id: "brand-a", hour, kind: "adsbot", hits: 1 },
      { brand_id: "brand-a", hour, kind: "googlebot", hits: 3 },
    ]);
  });

  it("buckets by core's clock when the brand clock is more than an hour off", async () => {
    await hit("googlebot", "2020-01-01T00:00:00.000Z");
    expect((await rows())[0]).toMatchObject({ hour: botHour(Date.now()) });
  });

  it("refuses another account's brand, a bad token, an unknown kind and extra fields", async () => {
    expect((await hit("adsbot", stamp(), "brand-b")).status).toBe(403);
    expect((await hit("adsbot", stamp()).then(() => post({ brand_id: "brand-a", kind: "adsbot", path: "/", at: stamp() }, "wrong"))).status).toBe(401);
    expect((await hit("human", stamp())).status).toBe(400);
    expect((await post({ brand_id: "brand-a", kind: "adsbot", path: "/", at: stamp(), ip: "203.0.113.7" })).status).toBe(400);
    expect((await post({ brand_id: "brand-a", kind: "adsbot", path: "no-slash", at: stamp() })).status).toBe(400);
    expect(await rows()).toHaveLength(1);
  });

  it("stores no ip, no user agent and no path", async () => {
    const columns = (await h.db.prepare("PRAGMA table_info(bot_hits)").all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).toEqual(["brand_id", "hour", "kind", "hits"]);
  });
});

describe("bot_hits in the alerts report", () => {
  const now = "2026-11-07T10:30:00.000Z";
  const seed = (brand: string, hour: string, kind: string, hits: number) =>
    h.db.prepare("INSERT INTO bot_hits (brand_id, hour, kind, hits) VALUES (?1, ?2, ?3, ?4)").bind(brand, hour, kind, hits).run();
  const report = async () => AlertsReportResponse.parse(await (await h.admin(`/admin/alerts?now=${now}`, employee)).json());

  it("is ok with empty counters", async () => {
    expect((await report()).bot_hits).toEqual({ state: "ok", detail: { window_hours: 24, brands: [], adsbot_hours: [] } });
  });

  it("alerts once per brand per hour with AdsBot hits and counts Googlebot without alerting", async () => {
    await seed("brand-a", "2026-11-07T10:00:00Z", "adsbot", 4);
    await seed("brand-a", "2026-11-07T09:00:00Z", "adsbot", 1);
    await seed("brand-a", "2026-11-07T10:00:00Z", "googlebot", 7);
    await seed("brand-b", "2026-11-07T10:00:00Z", "googlebot", 2);
    await seed("brand-b", "2026-11-07T10:00:00Z", "other-bot", 5);
    await seed("brand-a", "2026-11-05T10:00:00Z", "adsbot", 99);
    expect((await report()).bot_hits).toEqual({
      state: "alert",
      detail: {
        window_hours: 24,
        brands: [
          { brand: "brand-a", googlebot: 7, adsbot: 5, other_bot: 0 },
          { brand: "brand-b", googlebot: 2, adsbot: 0, other_bot: 5 },
        ],
        adsbot_hours: [
          { brand: "brand-a", hour: "2026-11-07T09:00:00Z", hits: 1 },
          { brand: "brand-a", hour: "2026-11-07T10:00:00Z", hits: 4 },
        ],
      },
    });
  });

  it("omits bot_hits and keeps the report 200 when the counter read fails", async () => {
    await h.db.prepare("ALTER TABLE bot_hits RENAME TO bot_hits_gone").run();
    try {
      const response = await h.admin(`/admin/alerts?now=${now}`, employee);
      expect(response.status).toBe(200);
      const body = AlertsReportResponse.parse(await response.json());
      expect(body.bot_hits).toBeUndefined();
      expect(body.conversion_stalled.state).toBe("ok");
    } finally {
      await h.db.prepare("ALTER TABLE bot_hits_gone RENAME TO bot_hits").run();
    }
  });

  it("stays ok when only Googlebot visited", async () => {
    await seed("brand-a", "2026-11-07T10:00:00Z", "googlebot", 3);
    expect((await report()).bot_hits?.state).toBe("ok");
  });
});
