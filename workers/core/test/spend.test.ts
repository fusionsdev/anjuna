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

  it("stores the row currency, and THB for a row sent without one", async () => {
    const response = await ingest({ rows: [
      { brand_id: "brand-a", date: "2026-10-21", hour: 9, cost: 12448, currency: "THB", clicks: 3, impressions: 120 },
      { brand_id: "brand-b", date: "2026-10-21", hour: 9, cost: 500, clicks: 1, impressions: 10 },
    ] });
    expect(response.status).toBe(200);
    const { results } = await h.db.prepare("SELECT brand_id, cost, currency FROM ad_spend ORDER BY brand_id").all();
    expect(results).toEqual([
      { brand_id: "brand-a", cost: 12448, currency: "THB" },
      { brand_id: "brand-b", cost: 500, currency: "THB" },
    ]);
  });

  it("rejects a currency other than THB or USD with 400 and writes nothing", async () => {
    const response = await ingest({ rows: [{ brand_id: "brand-a", date: "2026-10-21", hour: 9, cost: 1, currency: "EUR", clicks: 1, impressions: 1 }] });
    expect(response.status).toBe(400);
    expect((await spendRows()).results).toEqual([]);
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
      totals: { cost_by_currency: { THB: 8.3, USD: 0 }, clicks: 7, impressions: 70 },
      brands: [
        { brand_id: "brand-a", currency: "THB", cost: 3.3, clicks: 3, impressions: 30 },
        { brand_id: "brand-b", currency: "THB", cost: 5, clicks: 4, impressions: 40 },
      ],
    });
    expect(Date.parse(day.brands[0]!.updated_at)).toBeGreaterThan(Date.now() - 60_000);

    expect(pick(await read("7d"))).toEqual({
      totals: { cost_by_currency: { THB: 25.3, USD: 0 }, clicks: 24, impressions: 240 },
      brands: [
        { brand_id: "brand-a", currency: "THB", cost: 13.3, clicks: 13, impressions: 130 },
        { brand_id: "brand-b", currency: "THB", cost: 12, clicks: 11, impressions: 110 },
      ],
    });
    const month = await read("30d");
    expect(month).toMatchObject({ period: "30d", from: daysAgo(29), to: today() });
    expect(pick(month)).toEqual({
      totals: { cost_by_currency: { THB: 45.3, USD: 0 }, clicks: 44, impressions: 440 },
      brands: [
        { brand_id: "brand-a", currency: "THB", cost: 13.3, clicks: 13, impressions: 130 },
        { brand_id: "brand-b", currency: "THB", cost: 32, clicks: 31, impressions: 310 },
      ],
    });
  });

  it("returns the stored currency per brand row and never sums baht with dollars", async () => {
    await ingest({ rows: [
      { brand_id: "brand-a", date: today(), hour: 1, cost: 12448, currency: "THB", clicks: 3, impressions: 30 },
      { brand_id: "brand-b", date: today(), hour: 1, cost: 20, currency: "USD", clicks: 2, impressions: 20 },
    ] });
    const body = SpendReportResponse.parse(await (await report("today")).json());
    expect(body.totals).toEqual({ cost_by_currency: { THB: 12448, USD: 20 }, clicks: 5, impressions: 50 });
    expect(body.brands.map(({ brand_id, currency, cost }) => ({ brand_id, currency, cost }))).toEqual([
      { brand_id: "brand-a", currency: "THB", cost: 12448 },
      { brand_id: "brand-b", currency: "USD", cost: 20 },
    ]);
  });

  it("returns zero totals and no brands when nothing was ingested", async () => {
    const response = await report("30d");
    expect(await response.json()).toMatchObject({ totals: { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 }, brands: [], daily: [] });
  });

  it("yesterday covers the one UTC day before today and nothing else", async () => {
    await ingest({ rows: [
      { brand_id: "brand-a", date: today(), hour: 1, cost: 100, clicks: 1, impressions: 1 },
      { brand_id: "brand-a", date: daysAgo(1), hour: 3, cost: 4, clicks: 2, impressions: 20 },
      { brand_id: "brand-b", date: daysAgo(1), cost: 6, clicks: 3, impressions: 30 },
      { brand_id: "brand-b", date: daysAgo(2), hour: 3, cost: 50, clicks: 5, impressions: 50 },
    ] });
    const response = await report("yesterday");
    expect(response.status).toBe(200);
    const body = SpendReportResponse.parse(await response.json());
    expect(body).toMatchObject({ period: "yesterday", from: daysAgo(1), to: daysAgo(1) });
    expect(spendPeriodRange("yesterday")).toEqual({ from: daysAgo(1), to: daysAgo(1) });
    expect(body.totals).toEqual({ cost_by_currency: { THB: 10, USD: 0 }, clicks: 5, impressions: 50 });
    expect(body.brands.map(({ brand_id, cost }) => [brand_id, cost])).toEqual([["brand-a", 4], ["brand-b", 6]]);
    expect(body.daily).toEqual([{ date: daysAgo(1), cost: 10, currency: "THB" }]);
  });

  it("daily is ascending by date with one entry per date and currency, summing brands and keeping currencies apart", async () => {
    await ingest({ rows: [
      // Posted out of date order on purpose.
      { brand_id: "brand-a", date: today(), hour: 0, cost: 1.1, clicks: 1, impressions: 1 },
      { brand_id: "brand-a", date: today(), hour: 1, cost: 2.2, clicks: 1, impressions: 1 },
      { brand_id: "brand-b", date: today(), hour: 1, cost: 5, currency: "USD", clicks: 1, impressions: 1 },
      { brand_id: "brand-a", date: daysAgo(4), hour: 9, cost: 40, currency: "THB", clicks: 1, impressions: 1 },
      { brand_id: "brand-b", date: daysAgo(4), hour: 9, cost: 60, currency: "THB", clicks: 1, impressions: 1 },
      { brand_id: "brand-b", date: daysAgo(2), cost: 8, currency: "USD", clicks: 1, impressions: 1 },
      // 8 days ago is outside 7d.
      { brand_id: "brand-a", date: daysAgo(8), hour: 9, cost: 999, clicks: 1, impressions: 1 },
    ] });
    const body = SpendReportResponse.parse(await (await report("7d")).json());
    expect(body.daily).toEqual([
      { date: daysAgo(4), cost: 100, currency: "THB" },
      { date: daysAgo(2), cost: 8, currency: "USD" },
      { date: today(), cost: 3.3, currency: "THB" },
      { date: today(), cost: 5, currency: "USD" },
    ]);
    // The daily series and the period totals add up per currency.
    const sum = (currency: string) => (body.daily ?? []).filter((d) => d.currency === currency).reduce((a, d) => a + d.cost, 0);
    expect(Math.round(sum("THB") * 100) / 100).toBe(body.totals.cost_by_currency.THB);
    expect(sum("USD")).toBe(body.totals.cost_by_currency.USD);
  });

  it("daily counts hourly rows over a whole-day row for the same brand and day", async () => {
    await ingest({ rows: [
      { brand_id: "brand-a", date: daysAgo(1), cost: 999, clicks: 1, impressions: 1 },
      { brand_id: "brand-a", date: daysAgo(1), hour: 12, cost: 10, clicks: 1, impressions: 1 },
      { brand_id: "brand-b", date: daysAgo(1), cost: 7, clicks: 1, impressions: 1 },
    ] });
    const body = SpendReportResponse.parse(await (await report("7d")).json());
    expect(body.daily).toEqual([{ date: daysAgo(1), cost: 17, currency: "THB" }]);
  });
});

describe("POST /api/spend/campaign-ingest", () => {
  const ACCOUNT = "5381163935";
  const DATE = "2026-11-05";
  const campaignIngest = (body: unknown, authorization = `Bearer ${DRAIN_TOKEN}`) =>
    h.request("/api/spend/campaign-ingest", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const allocationRows = () => h.db.prepare(
    "SELECT brand_id, date, hour, cost, currency, clicks, impressions, allocation FROM ad_spend ORDER BY date, hour, brand_id",
  ).all();
  const unallocatedRows = () => h.db.prepare(
    "SELECT account, date, hour, cost, currency FROM ad_spend_unallocated ORDER BY date, hour",
  ).all();
  let n = 0;
  const paidClick = (brand: string, seenAt: string, campaign: string | null = null) =>
    h.db.prepare(`INSERT INTO click_sessions (click_session_id, gclid, utm_campaign, click_seen_at, first_seen_at, last_seen_at,
      created_at, hostname, brand_id) VALUES (?1, 'gclid-x', ?2, ?3, ?3, ?3, ?3, ?4, ?5)`)
      .bind(`cs-route-${++n}`, campaign, seenAt, `${brand}.example`, brand);
  const setMode = (mode: string) => h.factory.prepare(`INSERT INTO panel_settings (key, value_json, updated_by, updated_at)
    VALUES ('ads_allocation_mode', ?1, 'usr_owner_01', '2026-11-01T00:00:00.000Z')
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`).bind(JSON.stringify(mode)).run();
  const body = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    ({ account: ACCOUNT, currency: "THB", utc_offset_minutes: 0, rows, ...extra });
  const pick = (rows: Record<string, unknown>[], ...keys: string[]) => rows.map((r) => keys.map((k) => r[k]));

  beforeEach(async () => {
    await h.factory.prepare("DELETE FROM panel_settings WHERE key = 'ads_allocation_mode'").run();
    await h.seedBrand("petvetpay", "t-pv");
    await h.seedBrand("bisoncash", "t-bc");
    await h.db.batch([
      h.db.prepare("UPDATE brand_runtime SET google_ads_account = ?1 WHERE brand_id IN ('petvetpay', 'bisoncash')").bind(ACCOUNT),
      h.db.prepare("UPDATE brand_runtime SET google_ads_account = '1111111111' WHERE brand_id = 'brand-a'"),
      h.db.prepare("INSERT INTO campaign_brand_map VALUES (?1, '111', 'bisoncash', 'manual', ?2, ?2)").bind(ACCOUNT, "2026-11-01T00:00:00.000Z"),
    ]);
  });

  it.each(["", "Bearer wrong"])("returns the drain 401 for auth %j and writes nothing", async (authorization) => {
    const response = await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 1, clicks: 1, impressions: 1 }]), authorization);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
    expect((await allocationRows()).results).toEqual([]);
  });

  it("ignores a token in the query string and is POST only", async () => {
    expect((await h.request(`/api/spend/campaign-ingest?token=${DRAIN_TOKEN}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await h.request("/api/spend/campaign-ingest", { headers: { Authorization: `Bearer ${DRAIN_TOKEN}` } })).status).toBe(404);
  });

  it.each([
    ["malformed JSON", "{rows:"],
    ["a bad account", body([], { account: "538-116-3935" })],
    ["a missing currency", { account: ACCOUNT, utc_offset_minutes: 0, rows: [] }],
    ["a missing utc_offset_minutes", { account: ACCOUNT, currency: "THB", rows: [] }],
    ["a utc_offset_minutes above 840", body([], { utc_offset_minutes: 841 })],
    ["a utc_offset_minutes below -720", body([], { utc_offset_minutes: -721 })],
    ["a fractional utc_offset_minutes", body([], { utc_offset_minutes: 420.5 })],
    ["a non-numeric campaign id", body([{ date: DATE, hour: 1, campaign_id: "summer", cost: 1, clicks: 1, impressions: 1 }])],
    ["a negative cost", body([{ date: DATE, hour: 1, campaign_id: "222", cost: -1, clicks: 1, impressions: 1 }])],
    ["a cost above 1e9", body([{ date: DATE, hour: 1, campaign_id: "222", cost: 1e14, clicks: 1, impressions: 1 }])],
    ["a cost with 7 decimals (rounding before the slot sum would drift)", body([{ date: DATE, hour: 1, campaign_id: "222", cost: 0.0049996, clicks: 0, impressions: 0 }])],
    ["a brand_id field", body([{ brand_id: "petvetpay", date: DATE, hour: 1, campaign_id: "222", cost: 1, clicks: 1, impressions: 1 }])],
  ])("rejects %s with 400 and writes nothing", async (_name, payload) => {
    const response = await campaignIngest(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "invalid" });
    expect((await allocationRows()).results).toEqual([]);
  });

  it("rejects the same campaign twice in one hour, writing nothing", async () => {
    const row = { date: DATE, hour: 10, campaign_id: "222", cost: 1, clicks: 1, impressions: 1 };
    const response = await campaignIngest(body([row, { ...row, cost: 2 }]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "invalid", message: "Duplicate campaign row" });
    expect((await allocationRows()).results).toEqual([]);
  });

  it("rejects an account no brand of this core uses with 422", async () => {
    const response = await campaignIngest(body([{ date: DATE, hour: 1, campaign_id: "222", cost: 1, clicks: 1, impressions: 1 }], { account: "9999999999" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: "invalid", message: "Unknown account" });
  });

  it("splits PetVetPay and BisonCash so the brand rows add up to the posted cost", async () => {
    await h.db.batch([
      paidClick("petvetpay", `${DATE}T10:05:00.000Z`), paidClick("petvetpay", `${DATE}T10:20:00.000Z`),
      paidClick("petvetpay", `${DATE}T10:59:59.000Z`), paidClick("bisoncash", `${DATE}T10:30:00.000Z`),
      paidClick("bisoncash", `${DATE}T11:00:00.000Z`), // next hour, not counted for hour 10
    ]);
    const response = await campaignIngest(body([
      { date: DATE, hour: 10, campaign_id: "111", cost: 40, clicks: 8, impressions: 80 },
      { date: DATE, hour: 10, campaign_id: "222", cost: 100, clicks: 4, impressions: 40 },
      { date: DATE, hour: 11, campaign_id: "111", cost: 12.34, clicks: 2, impressions: 20 },
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted", upserted: 4, unallocated: 0 });
    expect((await allocationRows()).results).toEqual([
      { brand_id: "bisoncash", date: DATE, hour: 10, cost: 65, currency: "THB", clicks: 9, impressions: 90, allocation: "estimated" },
      { brand_id: "petvetpay", date: DATE, hour: 10, cost: 75, currency: "THB", clicks: 3, impressions: 30, allocation: "estimated" },
      { brand_id: "bisoncash", date: DATE, hour: 11, cost: 12.34, currency: "THB", clicks: 2, impressions: 20, allocation: "exact" },
      { brand_id: "petvetpay", date: DATE, hour: 11, cost: 0, currency: "THB", clicks: 0, impressions: 0, allocation: "exact" },
    ]);
    expect((await unallocatedRows()).results).toEqual([]);
  });

  it("rounds a slot once: two campaigns of 1.004 store a total of 2.01", async () => {
    await campaignIngest(body([
      { date: DATE, hour: 10, campaign_id: "111", cost: 1.004, clicks: 0, impressions: 0 },
      { date: DATE, hour: 10, campaign_id: "222", cost: 1.004, clicks: 0, impressions: 0 },
    ]));
    const costs = (await allocationRows()).results.map((r) => Number(r.cost));
    expect(costs.reduce((t, c) => t + Math.round(c * 100), 0)).toBe(201);
    for (const cost of costs) expect(Math.round(cost * 100) / 100).toBe(cost);
  });

  it("leaves the same rows when the same hour is posted twice", async () => {
    await h.db.batch([paidClick("petvetpay", `${DATE}T10:05:00.000Z`), paidClick("bisoncash", `${DATE}T10:06:00.000Z`)]);
    const payload = body([{ date: DATE, hour: 10, campaign_id: "222", cost: 10.01, clicks: 3, impressions: 9 }]);
    await campaignIngest(payload);
    const first = (await allocationRows()).results;
    expect((await campaignIngest(payload)).status).toBe(200);
    expect((await allocationRows()).results).toEqual(first);
    expect(first.map((r) => r.cost)).toEqual([5.01, 5]);
  });

  it("overwrites a brand's earlier share when a rerun gives the hour to the other brand", async () => {
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 10, clicks: 0, impressions: 0 }]));
    await h.db.prepare("INSERT INTO campaign_brand_map VALUES (?1, '222', 'petvetpay', 'manual', ?2, ?2)").bind(ACCOUNT, "2026-11-06T00:00:00.000Z").run();
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 10, clicks: 0, impressions: 0 }]));
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["bisoncash", 0, "exact"], ["petvetpay", 10, "exact"],
    ]);
  });

  it("drops the share of a brand that left the account and keeps rows without an account", async () => {
    const payload = body([{ date: DATE, hour: 10, campaign_id: "222", cost: 10, clicks: 0, impressions: 0 }]);
    await campaignIngest(payload);
    // brand-a wrote this slot through the account level ingest: account stays NULL.
    await ingest({ rows: [{ brand_id: "brand-a", date: DATE, hour: 10, cost: 4, clicks: 1, impressions: 1 }] });
    expect(pick((await allocationRows()).results, "brand_id", "cost")).toEqual([["bisoncash", 5], ["brand-a", 4], ["petvetpay", 5]]);
    await h.db.prepare("UPDATE brand_runtime SET google_ads_account = '2222222222' WHERE brand_id = 'bisoncash'").run();
    await campaignIngest(payload);
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["brand-a", 4, "exact"], ["petvetpay", 10, "exact"],
    ]);
    const accounts = await h.db.prepare("SELECT brand_id, account FROM ad_spend ORDER BY brand_id").all();
    expect(accounts.results).toEqual([{ brand_id: "brand-a", account: null }, { brand_id: "petvetpay", account: ACCOUNT }]);
  });

  it("uses the day's clicks when the hour has none, then an equal split", async () => {
    await h.db.batch([paidClick("petvetpay", `${DATE}T02:00:00.000Z`), paidClick("bisoncash", `${DATE}T03:00:00.000Z`),
      paidClick("bisoncash", `${DATE}T04:00:00.000Z`), paidClick("bisoncash", `${DATE}T05:00:00.000Z`)]);
    await campaignIngest(body([
      { date: DATE, hour: 20, campaign_id: "222", cost: 8, clicks: 0, impressions: 0 },
      { date: "2026-11-06", hour: 20, campaign_id: "222", cost: 0.05, clicks: 0, impressions: 0 },
    ]));
    expect(pick((await allocationRows()).results, "date", "brand_id", "cost", "allocation")).toEqual([
      [DATE, "bisoncash", 6, "estimated"], [DATE, "petvetpay", 2, "estimated"],
      ["2026-11-06", "bisoncash", 0.03, "estimated"], ["2026-11-06", "petvetpay", 0.02, "estimated"],
    ]);
  });

  it("buckets clicks by the account's local hour with utc_offset_minutes 420", async () => {
    // 03:10Z is 10:10 in Bangkok; 10:10Z is 17:10 in Bangkok.
    await h.db.batch([
      paidClick("petvetpay", `${DATE}T03:10:00.000Z`), paidClick("petvetpay", `${DATE}T03:20:00.000Z`),
      paidClick("petvetpay", `${DATE}T03:30:00.000Z`), paidClick("bisoncash", `${DATE}T10:10:00.000Z`),
    ]);
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 100, clicks: 0, impressions: 0 }], { utc_offset_minutes: 420 }));
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["bisoncash", 0, "estimated"], ["petvetpay", 100, "estimated"],
    ]);
  });

  it("counts a click before UTC midnight in the next local day and hour 0", async () => {
    // 2026-11-04T17:30Z is 00:30 on 2026-11-05 in Bangkok; 2026-11-05T00:30Z is 07:30 there.
    await h.db.batch([paidClick("petvetpay", "2026-11-04T17:30:00.000Z"), paidClick("bisoncash", `${DATE}T00:30:00.000Z`)]);
    await campaignIngest(body([
      { date: DATE, hour: 0, campaign_id: "222", cost: 100, clicks: 0, impressions: 0 },
      { date: DATE, hour: null, campaign_id: "222", cost: 30, clicks: 0, impressions: 0 },
    ], { utc_offset_minutes: 420 }));
    expect(pick((await allocationRows()).results, "hour", "brand_id", "cost")).toEqual([
      [null, "bisoncash", 15], [null, "petvetpay", 15], [0, "bisoncash", 0], [0, "petvetpay", 100],
    ]);
  });

  it("buckets by UTC with utc_offset_minutes 0", async () => {
    await h.db.batch([paidClick("petvetpay", "2026-11-04T17:30:00.000Z"), paidClick("bisoncash", `${DATE}T00:30:00.000Z`)]);
    await campaignIngest(body([{ date: DATE, hour: 0, campaign_id: "222", cost: 100, clicks: 0, impressions: 0 }]));
    expect(pick((await allocationRows()).results, "brand_id", "cost")).toEqual([["bisoncash", 100], ["petvetpay", 0]]);
  });

  it("counts only paid clicks of the account's brands as weights", async () => {
    await h.db.batch([
      paidClick("petvetpay", `${DATE}T10:05:00.000Z`),
      h.db.prepare(`INSERT INTO click_sessions (click_session_id, utm_source, click_seen_at, first_seen_at, last_seen_at, created_at, hostname, brand_id)
        VALUES ('cs-organic', 'newsletter', ?1, ?1, ?1, ?1, 'bisoncash.example', 'bisoncash')`).bind(`${DATE}T10:10:00.000Z`),
      paidClick("brand-a", `${DATE}T10:15:00.000Z`),
    ]);
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 9, clicks: 0, impressions: 0 }]));
    expect(pick((await allocationRows()).results, "brand_id", "cost")).toEqual([["bisoncash", 0], ["petvetpay", 9]]);
  });

  it("maps a campaign from 3 recent clicks of one brand before allocating", async () => {
    // Click times relative to the wall clock: the map window ends at the real now.
    const recent = `${daysAgo(1)}T09:00:00.000Z`;
    await h.db.batch([paidClick("petvetpay", recent, "333"), paidClick("petvetpay", recent, "333"),
      paidClick("petvetpay", recent, "333"), paidClick("bisoncash", `${DATE}T10:00:00.000Z`)]);
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "333", cost: 7, clicks: 1, impressions: 1 }]));
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["bisoncash", 0, "exact"], ["petvetpay", 7, "exact"],
    ]);
  });

  it("writes unmapped cost to ad_spend_unallocated and no brand row in exact_only mode", async () => {
    await setMode("exact_only");
    await h.db.batch([paidClick("petvetpay", `${DATE}T10:05:00.000Z`)]);
    const payload = body([
      { date: DATE, hour: 10, campaign_id: "111", cost: 40, clicks: 8, impressions: 80 },
      { date: DATE, hour: 10, campaign_id: "222", cost: 100.55, clicks: 4, impressions: 40 },
    ]);
    const response = await campaignIngest(payload);
    expect(await response.json()).toEqual({ status: "accepted", upserted: 2, unallocated: 100.55 });
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["bisoncash", 40, "exact"], ["petvetpay", 0, "exact"],
    ]);
    expect((await unallocatedRows()).results).toEqual([{ account: ACCOUNT, date: DATE, hour: 10, cost: 100.55, currency: "THB" }]);
    await campaignIngest(payload);
    expect((await unallocatedRows()).results).toHaveLength(1);
  });

  it("clears an hour's unallocated cost when the mode goes back to estimated", async () => {
    await setMode("exact_only");
    const payload = body([{ date: DATE, hour: null, campaign_id: "222", cost: 10, clicks: 0, impressions: 0 }]);
    await campaignIngest(payload);
    await setMode("estimated");
    await campaignIngest(payload);
    expect((await unallocatedRows()).results).toEqual([]);
    expect(pick((await allocationRows()).results, "brand_id", "hour", "cost")).toEqual([["bisoncash", null, 5], ["petvetpay", null, 5]]);
  });

  it.each(["estimated", "exact_only"])("gives a brand alone on its account an unmapped campaign as exact in %s mode", async (mode) => {
    await setMode(mode);
    const response = await campaignIngest(body(
      [{ date: DATE, hour: 10, campaign_id: "444", cost: 9.99, clicks: 3, impressions: 30 }], { account: "1111111111" },
    ));
    expect(await response.json()).toEqual({ status: "accepted", upserted: 1, unallocated: 0 });
    expect((await allocationRows()).results).toEqual([
      { brand_id: "brand-a", date: DATE, hour: 10, cost: 9.99, currency: "THB", clicks: 3, impressions: 30, allocation: "exact" },
    ]);
    expect((await unallocatedRows()).results).toEqual([]);
  });

  it("accepts an empty batch", async () => {
    const response = await campaignIngest(body([]));
    expect(await response.json()).toEqual({ status: "accepted", upserted: 0, unallocated: 0 });
  });

  it("marks a row exact again when the account level ingest overwrites it", async () => {
    await campaignIngest(body([{ date: DATE, hour: 10, campaign_id: "222", cost: 10, clicks: 0, impressions: 0 }]));
    await ingest({ rows: [{ brand_id: "petvetpay", date: DATE, hour: 10, cost: 3, clicks: 1, impressions: 1 }] });
    expect(pick((await allocationRows()).results, "brand_id", "cost", "allocation")).toEqual([
      ["bisoncash", 5, "estimated"], ["petvetpay", 3, "exact"],
    ]);
  });

  it("keeps the admin report shape and its totals equal to the posted cost", async () => {
    await h.db.batch([paidClick("petvetpay", `${today()}T00:10:00.000Z`)]);
    await campaignIngest(body([
      { date: today(), hour: 0, campaign_id: "111", cost: 33.33, clicks: 1, impressions: 1 },
      { date: today(), hour: 0, campaign_id: "222", cost: 66.67, clicks: 2, impressions: 2 },
    ]));
    const parsed = SpendReportResponse.parse(await (await report("today")).json());
    expect(parsed.totals.cost_by_currency.THB).toBe(100);
    expect(parsed.brands.map((b) => [b.brand_id, b.cost])).toEqual([["bisoncash", 33.33], ["petvetpay", 66.67]]);
  });
});
