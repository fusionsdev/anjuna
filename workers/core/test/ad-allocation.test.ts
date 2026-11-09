import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AdAllocationAssignResponse, AdAllocationResponse, AdminError, AlertsReportResponse, SpendReportResponse,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_alloc_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_alloc_emp" };

// Every date is fixed: the window is pinned with ?now=, so no test depends on today's date.
const NOW = "2026-11-08T12:00:00.000Z";
const SHARED = "5381163935";
const ALONE = "1111111111";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h?.mf.dispose(); });
// h.reset() also deletes audit_log, which its append-only trigger refuses once a test wrote a row, so this
// file clears its own tables and reads audit rows by entity id.
beforeEach(async () => {
  await h.db.batch(["ad_spend", "ad_spend_unallocated", "ad_spend_campaign", "campaign_brand_map", "click_sessions", "brand_runtime"]
    .map((table) => h.db.prepare(`DELETE FROM ${table}`)));
  await h.factory.prepare("DELETE FROM panel_settings WHERE key = 'ads_allocation_mode'").run();
  await h.seedBrand("petvetpay", "t-pv");
  await h.seedBrand("bisoncash", "t-bc");
  await h.seedBrand("brand-a", "t-a");
  await h.db.batch([
    h.db.prepare("UPDATE brand_runtime SET google_ads_account = ?1 WHERE brand_id IN ('petvetpay', 'bisoncash')").bind(SHARED),
    h.db.prepare("UPDATE brand_runtime SET google_ads_account = ?1 WHERE brand_id = 'brand-a'").bind(ALONE),
  ]);
});

const campaignRow = (account: string, date: string, hour: number | null, campaign: string, cost: number, currency = "THB", clicks = 1, updatedAt = "x", offset = 0) =>
  h.db.prepare("INSERT INTO ad_spend_campaign VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)").bind(account, date, hour, campaign, cost, currency, clicks, updatedAt, offset);
const mapRow = (campaign: string, brand: string, source: string, account = SHARED) =>
  h.db.prepare("INSERT INTO campaign_brand_map VALUES (?1, ?2, ?3, ?4, 'x', 'x')").bind(account, campaign, brand, source);
const read = async (context = owner) => h.admin(`/admin/ad-allocation?now=${NOW}`, context);
const assign = (body: unknown, context = owner) => h.admin(`/admin/ad-allocation/campaign?now=${NOW}`, context, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const alerts = async () => AlertsReportResponse.parse(await (await h.admin(`/admin/alerts?now=${NOW}`, owner)).json());

describe("GET /admin/ad-allocation", () => {
  it("lists only shared accounts, unmapped campaigns first with their 7 day cost, the mode and the unallocated total", async () => {
    await h.db.batch([
      campaignRow(SHARED, "2026-11-08", 9, "111", 40.25, "THB", 3),
      campaignRow(SHARED, "2026-11-02", 9, "111", 9.75),
      campaignRow(SHARED, "2026-11-01", 9, "111", 500), // outside the 7 day window (2026-11-02 to 2026-11-08)
      campaignRow(SHARED, "2026-11-08", 9, "222", 100),
      campaignRow(SHARED, "2026-11-08", 10, "333", 7),
      campaignRow(ALONE, "2026-11-08", 9, "999", 80), // brand-a is alone on its account
      mapRow("222", "petvetpay", "click"),
      mapRow("333", "brand-a", "manual"), // brand-a is not on this account: still unmapped
      h.db.prepare("INSERT INTO ad_spend_unallocated VALUES (?1, '2026-11-07', 3, 12.5, 'THB', 'x')").bind(SHARED),
      h.db.prepare("INSERT INTO ad_spend_unallocated VALUES (?1, '2026-10-01', 3, 99, 'THB', 'x')").bind(SHARED),
    ]);
    const response = await read();
    expect(response.status).toBe(200);
    const body = AdAllocationResponse.parse(await response.json());
    expect(body).toMatchObject({ mode: "estimated", from: "2026-11-02", to: "2026-11-08" });
    expect(body.accounts).toEqual([{
      account: SHARED, brands: ["bisoncash", "petvetpay"],
      cost_by_currency: { THB: 157, USD: 0 }, unmapped_cost_by_currency: { THB: 57, USD: 0 },
    }]);
    expect(body.campaigns).toEqual([
      { account: SHARED, campaign_id: "111", currency: "THB", cost: 50, clicks: 4, brand_id: null, source: null },
      { account: SHARED, campaign_id: "333", currency: "THB", cost: 7, clicks: 1, brand_id: null, source: null },
      { account: SHARED, campaign_id: "222", currency: "THB", cost: 100, clicks: 1, brand_id: "petvetpay", source: "click" },
    ]);
    expect(body.unallocated_by_currency).toEqual({ THB: 12.5, USD: 0 });
  });

  it("counts a whole-day row only for a day with no hourly rows, and keeps currencies apart", async () => {
    await h.db.batch([
      campaignRow(SHARED, "2026-11-07", null, "111", 30),
      campaignRow(SHARED, "2026-11-07", 4, "111", 10),
      campaignRow(SHARED, "2026-11-06", null, "111", 5),
      campaignRow(SHARED, "2026-11-06", 4, "111", 2, "USD"),
    ]);
    const body = AdAllocationResponse.parse(await (await read()).json());
    expect(body.campaigns.map((c) => [c.campaign_id, c.currency, c.cost])).toEqual([["111", "THB", 15], ["111", "USD", 2]]);
    expect(body.accounts[0]!.cost_by_currency).toEqual({ THB: 15, USD: 2 });
  });

  it("reads the exact_only mode from panel settings", async () => {
    await h.factory.prepare(`INSERT INTO panel_settings (key, value_json, updated_by, updated_at)
      VALUES ('ads_allocation_mode', '"exact_only"', 'usr_owner_01', '2026-11-01T00:00:00.000Z')`).run();
    expect(AdAllocationResponse.parse(await (await read()).json()).mode).toBe("exact_only");
  });

  it("answers 403 to an employee", async () => {
    const response = await read(employee);
    expect(response.status).toBe(403);
    expect(AdminError.parse(await response.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
  });
});

describe("PATCH /admin/ad-allocation/campaign", () => {
  it("writes source manual over a click row, so the next read shows manual, and audits it", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "222", 100), mapRow("222", "petvetpay", "click")]);
    const response = await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" });
    expect(response.status).toBe(200);
    expect(AdAllocationAssignResponse.parse(await response.json())).toMatchObject({ brand_id: "bisoncash", source: "manual" });
    const body = AdAllocationResponse.parse(await (await read()).json());
    expect(body.campaigns).toEqual([
      { account: SHARED, campaign_id: "222", currency: "THB", cost: 100, clicks: 1, brand_id: "bisoncash", source: "manual" },
    ]);
    const audit = await h.factory.prepare("SELECT actor_id, action, entity_type, entity_id, before_json, after_json FROM audit_log WHERE entity_id = ?1").bind(`${SHARED}:222`).all();
    expect(audit.results).toEqual([{
      actor_id: "usr_owner_01", action: "ad_allocation.assign", entity_type: "campaign", entity_id: `${SHARED}:222`,
      before_json: JSON.stringify({ brand_id: "petvetpay", source: "click" }), after_json: JSON.stringify({ brand_id: "bisoncash", source: "manual" }),
    }]);
  });

  it("maps an unmapped campaign, which then leaves the unmapped cost", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "444", 60)]);
    expect((await assign({ account: SHARED, campaign_id: "444", brand_id: "petvetpay" })).status).toBe(200);
    const body = AdAllocationResponse.parse(await (await read()).json());
    expect(body.accounts[0]!.unmapped_cost_by_currency).toEqual({ THB: 0, USD: 0 });
    expect(body.campaigns[0]).toMatchObject({ campaign_id: "444", brand_id: "petvetpay", source: "manual" });
  });

  it("answers 404 for a campaign the account never ingested and writes nothing", async () => {
    const response = await assign({ account: SHARED, campaign_id: "555", brand_id: "petvetpay" });
    expect(response.status).toBe(404);
    expect(AdminError.parse(await response.json())).toMatchObject({ error: "not_found", resource: "campaign" });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM campaign_brand_map").first<{ n: number }>())!.n).toBe(0);
  });

  it("re-allocates the stored slots: the other brand loses its share and the parts still add up to the account cost", async () => {
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
    const costs = [42.86, 42.86, 42.86, 42.86, 42.86, 42.86, 42.84]; // 300 baht over 7 days
    const post = await h.request("/api/spend/campaign-ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account: SHARED, currency: "THB", utc_offset_minutes: 0,
        rows: days.map((date, i) => ({ date, hour: null, campaign_id: "222", cost: costs[i], clicks: 1, impressions: 1 })) }),
    });
    expect(post.status).toBe(200);
    const totals = () => h.db.prepare(
      "SELECT brand_id, ROUND(SUM(cost), 2) AS cost, MIN(allocation) AS lo, MAX(allocation) AS hi FROM ad_spend GROUP BY brand_id ORDER BY brand_id").all();
    expect((await totals()).results).toEqual([
      { brand_id: "bisoncash", cost: 150, lo: "estimated", hi: "estimated" },
      { brand_id: "petvetpay", cost: 150, lo: "estimated", hi: "estimated" },
    ]);
    expect((await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" })).status).toBe(200);
    expect((await totals()).results).toEqual([
      { brand_id: "bisoncash", cost: 300, lo: "exact", hi: "exact" },
      { brand_id: "petvetpay", cost: 0, lo: "exact", hi: "exact" },
    ]);
    const body = AdAllocationResponse.parse(await (await read()).json());
    expect(body.accounts[0]!.unmapped_cost_by_currency).toEqual({ THB: 0, USD: 0 });
  });

  it("refuses a brand that is not on the account and writes nothing", async () => {
    const response = await assign({ account: SHARED, campaign_id: "444", brand_id: "brand-a" });
    expect(response.status).toBe(422);
    expect(AdminError.parse(await response.json())).toMatchObject({ error: "invalid" });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM campaign_brand_map").first<{ n: number }>())!.n).toBe(0);
  });

  it.each([
    ["a bad account", { account: "538-116-393", campaign_id: "444", brand_id: "petvetpay" }],
    ["a non-numeric campaign id", { account: SHARED, campaign_id: "summer", brand_id: "petvetpay" }],
    ["a source field", { account: SHARED, campaign_id: "444", brand_id: "petvetpay", source: "create" }],
  ])("rejects %s with 422 invalid", async (_name, body) => {
    expect((await assign(body)).status).toBe(422);
  });

  it("answers 403 to an employee and writes nothing", async () => {
    const response = await assign({ account: SHARED, campaign_id: "444", brand_id: "petvetpay" }, employee);
    expect(response.status).toBe(403);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM campaign_brand_map").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("alert ad_spend_unallocated", () => {
  it("fires at 21 percent unmapped cost of an account's 7 day cost", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "111", 21), campaignRow(SHARED, "2026-11-05", 9, "222", 79), mapRow("222", "petvetpay", "click")]);
    const block = (await alerts()).ad_spend_unallocated;
    expect(block).toEqual({
      state: "alert",
      detail: { window_days: 7, alert_at: 0.2, accounts: [{ account: SHARED, currency: "THB", share: 0.21 }] },
    });
  });

  it("does not fire at exactly 20 percent", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "111", 20), campaignRow(SHARED, "2026-11-05", 9, "222", 80), mapRow("222", "petvetpay", "click")]);
    expect((await alerts()).ad_spend_unallocated).toEqual({
      state: "ok", detail: { window_days: 7, alert_at: 0.2, accounts: [] },
    });
  });

  it("ignores cost outside the window and accounts used by one brand", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-01", 9, "111", 90), campaignRow(SHARED, "2026-11-08", 9, "222", 10), mapRow("222", "petvetpay", "click"),
      campaignRow(ALONE, "2026-11-08", 9, "999", 50)]);
    expect((await alerts()).ad_spend_unallocated?.state).toBe("ok");
  });
});

describe("campaign ingest keeps ad_spend_campaign and the spend report marks estimated brands", () => {
  const ingest = (rows: unknown[]) => h.request("/api/spend/campaign-ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ account: SHARED, currency: "THB", utc_offset_minutes: 0, rows }),
  });
  const campaignRows = () => h.db.prepare("SELECT date, hour, campaign_id, cost, currency, clicks FROM ad_spend_campaign ORDER BY date, hour, campaign_id").all();

  it("stores each campaign once per slot with the slot's hundredths, and a rerun replaces the slot", async () => {
    await h.db.batch([mapRow("111", "bisoncash", "manual")]);
    expect((await ingest([
      { date: "2026-11-05", hour: 10, campaign_id: "111", cost: 10.004, clicks: 2, impressions: 9 },
      { date: "2026-11-05", hour: 10, campaign_id: "222", cost: 5.004, clicks: 1, impressions: 4 },
    ])).status).toBe(200);
    expect((await campaignRows()).results).toEqual([
      { date: "2026-11-05", hour: 10, campaign_id: "111", cost: 10.01, currency: "THB", clicks: 2 },
      { date: "2026-11-05", hour: 10, campaign_id: "222", cost: 5, currency: "THB", clicks: 1 },
    ]);
    const brandSum = await h.db.prepare("SELECT ROUND(SUM(cost), 2) AS cost FROM ad_spend WHERE date = '2026-11-05' AND hour = 10").first<{ cost: number }>();
    expect(brandSum!.cost).toBe(15.01);

    await ingest([{ date: "2026-11-05", hour: 10, campaign_id: "111", cost: 3, clicks: 1, impressions: 1 }]);
    expect((await campaignRows()).results).toEqual([{ date: "2026-11-05", hour: 10, campaign_id: "111", cost: 3, currency: "THB", clicks: 1 }]);
  });

  it("gives each brand row allocation: estimated when an unmapped campaign was split, exact otherwise", async () => {
    // The spend report has no ?now=, so the row is dated today. The 7d period also covers it if the clock passes
    // midnight between the write and the read, so the assertion holds on any day at any time.
    const date = new Date().toISOString().slice(0, 10);
    await h.db.batch([mapRow("111", "bisoncash", "manual")]);
    await ingest([{ date, hour: 1, campaign_id: "222", cost: 10, clicks: 2, impressions: 2 }]);
    let report = SpendReportResponse.parse(await (await h.admin("/admin/spend?period=7d", owner)).json());
    expect(report.brands.map((b) => [b.brand_id, b.allocation])).toEqual([["bisoncash", "estimated"], ["petvetpay", "estimated"]]);

    await h.db.prepare("DELETE FROM ad_spend").run();
    await ingest([{ date, hour: 1, campaign_id: "111", cost: 10, clicks: 2, impressions: 2 }]);
    report = SpendReportResponse.parse(await (await h.admin("/admin/spend?period=7d", owner)).json());
    expect(report.brands.map((b) => [b.brand_id, b.allocation])).toEqual([["bisoncash", "exact"], ["petvetpay", "exact"]]);
  });
});

describe("PATCH /admin/ad-allocation/campaign re-allocation", () => {
  const spendRow = (brand: string, date: string, hour: number | null, cost: number, allocation: string, updatedAt: string, account: string | null = SHARED, currency = "THB") =>
    h.db.prepare(`INSERT INTO ad_spend (brand_id, date, hour, cost, currency, clicks, impressions, source, allocation, account, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 'google', ?6, ?7, ?8)`).bind(brand, date, hour, cost, currency, allocation, account, updatedAt);
  const spendRows = (where = "1 = 1") => h.db.prepare(
    `SELECT brand_id, date, hour, cost, currency, allocation, account, updated_at FROM ad_spend WHERE ${where} ORDER BY date, hour, brand_id, currency`).all();
  const campaignRows = () => h.db.prepare("SELECT account, date, hour, campaign_id, cost, currency, updated_at FROM ad_spend_campaign ORDER BY account, date, hour, campaign_id, currency").all();
  let n = 0;
  const paidClick = (brand: string, seenAt: string) => h.db.prepare(`INSERT INTO click_sessions (click_session_id, gclid, click_seen_at, first_seen_at, last_seen_at,
    created_at, hostname, brand_id) VALUES (?1, 'gclid-x', ?2, ?2, ?2, ?2, ?3, ?4)`).bind(`cs-alloc-${++n}`, seenAt, `${brand}.example`, brand);

  it("keeps each slot's stored updated_at: a slot synced 5 hours ago stays 5 hours old", async () => {
    const old = "2026-11-08T07:00:00.000Z";
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "222", 100, "THB", 1, old), campaignRow(SHARED, "2026-11-08", 9, "333", 50, "THB", 1, old)]);
    expect((await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" })).status).toBe(200);
    const spend = (await spendRows()).results;
    expect(spend.length).toBe(2);
    expect(spend.map((r) => r.updated_at)).toEqual([old, old]);
    expect((await campaignRows()).results.map((r) => r.updated_at)).toEqual([old, old]);
  });

  it("never touches a slot before the window: a brand that left in October keeps its September rows", async () => {
    await h.db.batch([
      campaignRow(SHARED, "2026-09-10", 9, "222", 100), campaignRow(SHARED, "2026-11-08", 9, "222", 100),
      spendRow("oldbrand", "2026-09-10", 9, 40, "estimated", "2026-09-10T10:00:00.000Z"),
      spendRow("petvetpay", "2026-09-10", 9, 60, "estimated", "2026-09-10T10:00:00.000Z"),
    ]);
    const september = () => spendRows("date = '2026-09-10'");
    const before = (await september()).results;
    expect((await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" })).status).toBe(200);
    expect((await september()).results).toEqual(before);
    expect((await spendRows("date = '2026-11-08'")).results.map((r) => [r.brand_id, r.cost, r.allocation])).toEqual([["bisoncash", 100, "exact"], ["petvetpay", 0, "exact"]]);
  });

  it("is one batch: a failing statement leaves the map unchanged and writes no audit row", async () => {
    await h.db.batch([campaignRow(SHARED, "2026-11-08", 9, "222", 100), mapRow("222", "petvetpay", "click")]);
    const auditBefore = (await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?1").bind(`${SHARED}:222`).first<{ n: number }>())!.n;
    await h.db.prepare("CREATE TRIGGER boom BEFORE INSERT ON ad_spend BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    try {
      const outcome = await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" }).then((r) => r.status, () => 500);
      expect(outcome).toBeGreaterThanOrEqual(500);
    } finally {
      await h.db.prepare("DROP TRIGGER boom").run();
    }
    expect(await h.db.prepare("SELECT brand_id, source FROM campaign_brand_map WHERE campaign_id = '222'").first()).toEqual({ brand_id: "petvetpay", source: "click" });
    const audit = await h.factory.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?1").bind(`${SHARED}:222`).first<{ n: number }>();
    expect(audit!.n).toBe(auditBefore);
  });

  it("leaves another account and another campaign untouched, keeps two currencies apart, and a repeated PATCH gives identical rows", async () => {
    const other = "2222222222";
    await h.db.batch([
      campaignRow(SHARED, "2026-11-08", null, "222", 100), campaignRow(SHARED, "2026-11-08", null, "333", 50),
      campaignRow(SHARED, "2026-11-07", null, "222", 20, "USD"), // ad_spend_key has no currency, so a second currency needs its own day
      campaignRow(other, "2026-11-08", null, "222", 70),
      spendRow("brand-a", "2026-11-08", null, 70, "exact", "2026-11-08T08:00:00.000Z", other),
    ]);
    const untouchedBefore = (await spendRows(`account = '${other}'`)).results;
    const otherCampaignBefore = (await campaignRows()).results.filter((r) => r.account === other);
    expect((await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" })).status).toBe(200);
    const first = (await spendRows()).results;
    expect((await spendRows(`account = '${other}'`)).results).toEqual(untouchedBefore);
    expect((await campaignRows()).results.filter((r) => r.account === other)).toEqual(otherCampaignBefore);
    // THB: 222 (100) is bisoncash exact; 333 (50) stays split 25 / 25 (no clicks, equal weights). USD: 20 is bisoncash exact.
    expect(first.filter((r) => r.account === SHARED).map((r) => [r.brand_id, r.currency, r.cost, r.allocation])).toEqual([
      ["bisoncash", "USD", 20, "exact"], ["petvetpay", "USD", 0, "exact"], ["bisoncash", "THB", 125, "estimated"], ["petvetpay", "THB", 25, "estimated"],
    ]);
    const campaigns = (await campaignRows()).results;
    expect((await assign({ account: SHARED, campaign_id: "222", brand_id: "bisoncash" })).status).toBe(200);
    expect((await spendRows()).results).toEqual(first);
    expect((await campaignRows()).results).toEqual(campaigns);
  });

  it("weights the other campaigns of a slot by the stored utc_offset_minutes (a +420 slot near midnight)", async () => {
    // Slot 2026-11-05 hour 23 local (UTC+7). Local hour 23 is 16:00 UTC. petvetpay 3 paid clicks and bisoncash 1 in that hour;
    // bisoncash has 10 more at local hour 8. With offset 0 the hour would be empty and the day would weigh 3 : 11.
    await h.db.batch([
      campaignRow(SHARED, "2026-11-05", 23, "777", 100, "THB", 1, "x", 420), campaignRow(SHARED, "2026-11-05", 23, "888", 40, "THB", 1, "x", 420),
      ...[0, 1, 2].map((i) => paidClick("petvetpay", `2026-11-05T16:${10 + i}:00.000Z`)),
      paidClick("bisoncash", "2026-11-05T16:30:00.000Z"),
      ...Array.from({ length: 10 }, (_, i) => paidClick("bisoncash", `2026-11-05T01:${10 + i}:00.000Z`)),
    ]);
    expect((await assign({ account: SHARED, campaign_id: "888", brand_id: "bisoncash" })).status).toBe(200);
    expect((await spendRows()).results.map((r) => [r.brand_id, r.cost, r.allocation])).toEqual([["bisoncash", 65, "estimated"], ["petvetpay", 75, "estimated"]]);
  });
});
