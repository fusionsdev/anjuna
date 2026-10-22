import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminError, SpendReportResponse, spendPeriodRange, type AdminRequestContext } from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, fixtureText, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_spend_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_spend_emp" };

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => {
  await h.reset();
  await h.seedBrand("brand-a", "token-a");
  await h.seedBrand("brand-b", "token-b");
});
afterAll(async () => { await h?.mf.dispose(); });

const ingest = (body: unknown, authorization = `Bearer ${DRAIN_TOKEN}`) =>
  h.request("/api/spend/ingest", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const spendRows = () => h.db.prepare(
  "SELECT brand_id, date, hour, cost, clicks, impressions, source FROM ad_spend ORDER BY brand_id, date, hour",
).all();
const report = async (period: string, context = owner) => h.admin(`/admin/spend?period=${period}`, context);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

describe("POST /api/spend/ingest", () => {
  it.each(["", "Bearer wrong", "Basic wrong"])("returns the drain 401 for auth %j and writes nothing", async (authorization) => {
    const response = await ingest({ rows: [{ brand_id: "brand-a", date: today(), hour: 1, cost: 1, clicks: 1, impressions: 1 }] }, authorization);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
    expect((await spendRows()).results).toEqual([]);
  });

  it("ignores a token in the query string", async () => {
    const response = await h.request(`/api/spend/ingest?token=${DRAIN_TOKEN}`, { method: "POST", body: '{"rows":[]}' });
    expect(response.status).toBe(401);
  });

  it("fails closed with no configured drain secret", async () => {
    const worker = await h.mf.getWorker("no-drain-token");
    const response = await worker.fetch("https://core.aduplift.ai/api/spend/ingest", {
      method: "POST", headers: { Authorization: `Bearer ${DRAIN_TOKEN}` }, body: '{"rows":[]}',
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  });

  it("is POST only", async () => {
    const response = await h.request("/api/spend/ingest", { headers: { Authorization: `Bearer ${DRAIN_TOKEN}` } });
    expect(response.status).toBe(404);
  });

  it.each([
    ["malformed JSON", "{rows:"],
    ["a missing rows array", {}],
    ["hour 24", { rows: [{ brand_id: "brand-a", date: "2026-10-21", hour: 24, cost: 1, clicks: 1, impressions: 1 }] }],
    ["a negative cost", { rows: [{ brand_id: "brand-a", date: "2026-10-21", hour: 1, cost: -1, clicks: 1, impressions: 1 }] }],
    ["a bad date", { rows: [{ brand_id: "brand-a", date: "21/10/2026", cost: 1, clicks: 1, impressions: 1 }] }],
    ["a missing clicks field", { rows: [{ brand_id: "brand-a", date: "2026-10-21", cost: 1, impressions: 1 }] }],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    const response = await ingest(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "invalid" });
    expect((await spendRows()).results).toEqual([]);
  });

  it("rejects a batch that names a brand this core does not have, writing none of it", async () => {
    const response = await ingest({ rows: [
      { brand_id: "brand-a", date: "2026-10-21", hour: 1, cost: 1, clicks: 1, impressions: 1 },
      { brand_id: "brand-zz", date: "2026-10-21", hour: 1, cost: 1, clicks: 1, impressions: 1 },
    ] });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: "invalid", message: "Unknown brand_id", unknown_brand_ids: ["brand-zz"] });
    expect((await spendRows()).results).toEqual([]);
  });

  it("upserts: posting the same rows twice keeps one row per key with the latest values", async () => {
    const rows = [
      { brand_id: "brand-a", date: "2026-10-21", hour: 9, cost: 4.5, clicks: 3, impressions: 120 },
      { brand_id: "brand-a", date: "2026-10-21", hour: 10, cost: 2, clicks: 1, impressions: 80 },
      { brand_id: "brand-b", date: "2026-10-21", cost: 30, clicks: 12, impressions: 900 },
    ];
    for (let i = 0; i < 2; i++) {
      const response = await ingest({ rows });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "accepted", upserted: 3 });
    }
    expect((await spendRows()).results).toHaveLength(3);

    // A later sync reports more spend for hour 9 and the whole day of brand-b: values replace, never add.
    await ingest({ rows: [{ ...rows[0], cost: 6.25, clicks: 5 }, { ...rows[2], hour: null, cost: 31 }] });
    expect((await spendRows()).results).toEqual([
      { brand_id: "brand-a", date: "2026-10-21", hour: 9, cost: 6.25, clicks: 5, impressions: 120, source: "google" },
      { brand_id: "brand-a", date: "2026-10-21", hour: 10, cost: 2, clicks: 1, impressions: 80, source: "google" },
      { brand_id: "brand-b", date: "2026-10-21", hour: null, cost: 31, clicks: 12, impressions: 900, source: "google" },
    ]);
  });

  it("accepts an empty batch", async () => {
    expect(await (await ingest({ rows: [] })).json()).toEqual({ status: "accepted", upserted: 0 });
  });
});

describe("GET /admin/spend", () => {
  it("returns 403 forbidden_role for an employee", async () => {
    const response = await report("7d", employee);
    expect(response.status).toBe(403);
    expect(AdminError.parse(await response.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
  });

  it.each(["", "90d", "TODAY"])("rejects period %j with 422", async (period) => {
    expect((await report(period)).status).toBe(422);
  });

  it("aggregates per brand over today, 7d and 30d, counting hourly rows over a whole-day row", async () => {
    await ingest({ rows: [
      // today: two hours for brand-a, a whole-day row for brand-b
      { brand_id: "brand-a", date: today(), hour: 0, cost: 1.1, clicks: 1, impressions: 10 },
      { brand_id: "brand-a", date: today(), hour: 1, cost: 2.2, clicks: 2, impressions: 20 },
      { brand_id: "brand-b", date: today(), cost: 5, clicks: 4, impressions: 40 },
      // 3 days ago: brand-a has both a whole-day row and hourly rows; only the hourly rows count
      { brand_id: "brand-a", date: daysAgo(3), cost: 999, clicks: 999, impressions: 999 },
      { brand_id: "brand-a", date: daysAgo(3), hour: 12, cost: 10, clicks: 10, impressions: 100 },
      // 6 days ago is inside 7d; 7 days ago is only inside 30d; 30 days ago is outside every period
      { brand_id: "brand-b", date: daysAgo(6), hour: 5, cost: 7, clicks: 7, impressions: 70 },
      { brand_id: "brand-b", date: daysAgo(7), hour: 5, cost: 20, clicks: 20, impressions: 200 },
      { brand_id: "brand-a", date: daysAgo(30), hour: 5, cost: 500, clicks: 500, impressions: 500 },
    ] });

    const read = async (period: string) => {
      const response = await report(period);
      expect(response.status).toBe(200);
      return SpendReportResponse.parse(await response.json());
    };
    const pick = (r: SpendReportResponse) => ({ totals: r.totals, brands: r.brands.map(({ updated_at: _, ...b }) => b) });

    const day = await read("today");
    expect(day).toMatchObject({ period: "today", ...spendPeriodRange("today") });
    expect(pick(day)).toEqual({
      totals: { cost: 8.3, clicks: 7, impressions: 70 },
      brands: [
        { brand_id: "brand-a", cost: 3.3, clicks: 3, impressions: 30 },
        { brand_id: "brand-b", cost: 5, clicks: 4, impressions: 40 },
      ],
    });
    expect(Date.parse(day.brands[0]!.updated_at)).toBeGreaterThan(Date.now() - 60_000);

    expect(pick(await read("7d"))).toEqual({
      totals: { cost: 25.3, clicks: 24, impressions: 240 },
      brands: [
        { brand_id: "brand-a", cost: 13.3, clicks: 13, impressions: 130 },
        { brand_id: "brand-b", cost: 12, clicks: 11, impressions: 110 },
      ],
    });
    const month = await read("30d");
    expect(month).toMatchObject({ period: "30d", from: daysAgo(29), to: today() });
    expect(pick(month)).toEqual({
      totals: { cost: 45.3, clicks: 44, impressions: 440 },
      brands: [
        { brand_id: "brand-a", cost: 13.3, clicks: 13, impressions: 130 },
        { brand_id: "brand-b", cost: 32, clicks: 31, impressions: 310 },
      ],
    });
  });

  it("returns zero totals and no brands when nothing was ingested", async () => {
    const response = await report("30d");
    expect(await response.json()).toMatchObject({ totals: { cost: 0, clicks: 0, impressions: 0 }, brands: [] });
  });
});
