import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  await env.FACTORY.prepare("DELETE FROM panel_settings").run();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const audits = async () =>
  (await env.FACTORY.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.ads_caps'").first<{ n: number }>())!.n;

describe("/api/settings/ads-caps (owner only)", () => {
  it("reads 3000 baht per day for both caps when nothing is stored", async () => {
    const response = await call("/api/settings/ads-caps", { cookie: owner });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total_thb_day: 3000, brand_thb_day: 3000, updated_at: null });
  });

  it("stores both caps under the keys core reads and writes one audit row", async () => {
    const response = await call("/api/settings/ads-caps", { cookie: owner, method: "PUT", body: { total_thb_day: 5000, brand_thb_day: 2500.5 } });
    expect(response.status).toBe(200);
    expect(await (await call("/api/settings/ads-caps", { cookie: owner })).json()).toMatchObject({ total_thb_day: 5000, brand_thb_day: 2500.5 });
    const { results } = await env.FACTORY.prepare("SELECT key, value_json FROM panel_settings ORDER BY key").all<{ key: string; value_json: string }>();
    expect(results).toEqual([
      { key: "ads_cap_brand_thb_day", value_json: "2500.5" },
      { key: "ads_cap_total_thb_day", value_json: "5000" },
    ]);
    const audit = await env.FACTORY.prepare(
      "SELECT actor_role, entity_id, before_json, after_json FROM audit_log WHERE action = 'settings.ads_caps' ORDER BY id DESC LIMIT 1",
    ).first<Record<string, string>>();
    expect(audit).toEqual({
      actor_role: "owner", entity_id: "ads_caps",
      before_json: '{"total_thb_day":3000,"brand_thb_day":3000}', after_json: '{"total_thb_day":5000,"brand_thb_day":2500.5}',
    });
  });

  it.each([
    ["a brand cap above the total cap", { total_thb_day: 3000, brand_thb_day: 3000.01 }],
    ["a negative cap", { total_thb_day: -1, brand_thb_day: 0 }],
    ["a cap above 1e6", { total_thb_day: 1_000_001, brand_thb_day: 10 }],
    ["3 decimals", { total_thb_day: 3000.001, brand_thb_day: 10 }],
    ["a string", { total_thb_day: "3000", brand_thb_day: 10 }],
    ["a null", { total_thb_day: null, brand_thb_day: 10 }],
    ["a missing cap", { total_thb_day: 3000 }],
    ["an extra key", { total_thb_day: 3000, brand_thb_day: 10, ads_allocation_mode: "exact_only" }],
  ])("refuses %s with 422, keeps the caps and writes no audit row", async (_label, body) => {
    const before = await audits();
    const response = await call("/api/settings/ads-caps", { cookie: owner, method: "PUT", body });
    expect(response.status).toBe(422);
    expect(await audits()).toBe(before);
    expect(await (await call("/api/settings/ads-caps", { cookie: owner })).json()).toMatchObject({ total_thb_day: 3000, brand_thb_day: 3000 });
  });

  it("returns 403 to an employee for read and write", async () => {
    expect((await call("/api/settings/ads-caps", { cookie: employee })).status).toBe(403);
    expect((await call("/api/settings/ads-caps", { cookie: employee, method: "PUT", body: { total_thb_day: 1, brand_thb_day: 1 } })).status).toBe(403);
    expect(await (await call("/api/settings/ads-caps", { cookie: owner })).json()).toMatchObject({ total_thb_day: 3000 });
  });
});
