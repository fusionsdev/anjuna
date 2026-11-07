import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allocateSpend, deriveCampaignMap, splitCost, splitUnits } from "../src/spend-allocation.js";
import { createHarness, type Harness } from "./helpers.js";

const units = (value: number) => Math.round(value * 100);
const sumUnits = (values: number[]) => values.reduce((total, value) => total + units(value), 0);

describe("splitUnits", () => {
  it("gives the remainder to the largest fractional parts, ties to the lower index", () => {
    expect(splitUnits(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(splitUnits(7, [2, 1])).toEqual([5, 2]);
  });

  it("splits equally when every weight is 0", () => {
    expect(splitUnits(5, [0, 0])).toEqual([3, 2]);
  });

  it.each([[[]], [[1, -1]], [[1, Number.NaN]], [[Number.POSITIVE_INFINITY]]])("rejects weights %j", (weights) => {
    expect(() => splitUnits(10, weights)).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN])("rejects total %s", (total) => {
    expect(() => splitUnits(total, [1])).toThrow(RangeError);
  });
});

describe("splitCost", () => {
  it("splits 100 by 3 to 1 into 75 and 25", () => {
    expect(splitCost(100, [3, 1])).toEqual([75, 25]);
  });

  it("keeps every satang of 0.10 split three ways", () => {
    const parts = splitCost(0.1, [1, 1, 1]);
    expect(parts).toEqual([0.04, 0.03, 0.03]);
    expect(sumUnits(parts)).toBe(10);
  });

  it("splits equally when every weight is 0, never NaN", () => {
    expect(splitCost(5, [0, 0])).toEqual([2.5, 2.5]);
  });

  it("gives 0 to a zero weight", () => {
    expect(splitCost(9.99, [5, 0])).toEqual([9.99, 0]);
  });

  it("returns numbers with at most 2 decimals", () => {
    for (const part of splitCost(123.45, [7, 11, 13])) expect(Math.round(part * 100) / 100).toBe(part);
  });
});

describe("allocateSpend", () => {
  const brandClicks = { petvetpay: 3, bisoncash: 1 };

  it("gives a mapped campaign to its brand as exact and never estimates it", () => {
    const result = allocateSpend({
      campaigns: [{ campaign_id: "111", cost: 40, clicks: 8, impressions: 80 }],
      map: new Map([["111", "bisoncash"]]),
      brandClicks,
      mode: "estimated",
    });
    expect(result).toEqual({
      rows: [{ brand_id: "bisoncash", cost: 40, clicks: 8, impressions: 80, allocation: "exact" }],
      unallocated: 0,
    });
  });

  it("splits an unmapped campaign 3 to 1 across PetVetPay and BisonCash with 3 and 1 clicks", () => {
    const result = allocateSpend({
      campaigns: [
        { campaign_id: "111", cost: 40, clicks: 8, impressions: 80 },
        { campaign_id: "222", cost: 100, clicks: 4, impressions: 40 },
      ],
      map: new Map([["111", "bisoncash"]]),
      brandClicks,
      mode: "estimated",
    });
    expect(result.unallocated).toBe(0);
    expect(result.rows).toEqual([
      { brand_id: "bisoncash", cost: 40, clicks: 8, impressions: 80, allocation: "exact" },
      { brand_id: "bisoncash", cost: 25, clicks: 1, impressions: 10, allocation: "estimated" },
      { brand_id: "petvetpay", cost: 75, clicks: 3, impressions: 30, allocation: "estimated" },
    ]);
  });

  it("gives a brand with zero clicks 0, and splits equally when no brand has clicks", () => {
    const campaigns = [{ campaign_id: "222", cost: 10, clicks: 2, impressions: 2 }];
    const oneSided = allocateSpend({ campaigns, map: new Map(), brandClicks: { a: 4, b: 0 }, mode: "estimated" });
    expect(oneSided.rows.find((r) => r.brand_id === "b")).toEqual({ brand_id: "b", cost: 0, clicks: 0, impressions: 0, allocation: "estimated" });
    const none = allocateSpend({ campaigns, map: new Map(), brandClicks: { a: 0, b: 0 }, mode: "estimated" });
    expect(none.rows.map((r) => r.cost)).toEqual([5, 5]);
  });

  it("treats a map row for a brand outside the account as unmapped", () => {
    const result = allocateSpend({
      campaigns: [{ campaign_id: "333", cost: 8, clicks: 0, impressions: 0 }],
      map: new Map([["333", "other-account-brand"]]),
      brandClicks: { a: 1, b: 1 },
      mode: "estimated",
    });
    expect(result.rows.map((r) => [r.brand_id, r.cost, r.allocation])).toEqual([["a", 4, "estimated"], ["b", 4, "estimated"]]);
    // An object prototype key is not a brand of the account.
    const proto = allocateSpend({
      campaigns: [{ campaign_id: "333", cost: 8, clicks: 0, impressions: 0 }],
      map: new Map([["333", "constructor"]]),
      brandClicks: { a: 1, b: 1 },
      mode: "exact_only",
    });
    expect(proto).toEqual({ rows: [], unallocated: 8 });
  });

  it("keeps the unmapped cost off every brand in exact_only mode", () => {
    const result = allocateSpend({
      campaigns: [
        { campaign_id: "111", cost: 40, clicks: 8, impressions: 80 },
        { campaign_id: "222", cost: 100.55, clicks: 4, impressions: 40 },
      ],
      map: new Map([["111", "bisoncash"]]),
      brandClicks,
      mode: "exact_only",
    });
    expect(result).toEqual({
      rows: [{ brand_id: "bisoncash", cost: 40, clicks: 8, impressions: 80, allocation: "exact" }],
      unallocated: 100.55,
    });
  });

  it.each(["estimated", "exact_only"] as const)("gives a brand alone on its account every campaign as exact in %s mode", (mode) => {
    const result = allocateSpend({
      campaigns: [
        { campaign_id: "111", cost: 40, clicks: 8, impressions: 80 },
        { campaign_id: "222", cost: 10.5, clicks: 2, impressions: 20 },
        { campaign_id: "333", cost: 1, clicks: 1, impressions: 1 },
      ],
      map: new Map([["111", "solo"], ["333", "brand-on-another-account"]]),
      brandClicks: { solo: 0 },
      mode,
    });
    expect(result).toEqual({
      rows: [{ brand_id: "solo", cost: 51.5, clicks: 11, impressions: 101, allocation: "exact" }],
      unallocated: 0,
    });
  });

  it("rounds the slot total once: two campaigns of 1.004 make 2.01", () => {
    const result = allocateSpend({
      campaigns: [
        { campaign_id: "111", cost: 1.004, clicks: 0, impressions: 0 },
        { campaign_id: "222", cost: 1.004, clicks: 0, impressions: 0 },
      ],
      map: new Map([["111", "a"], ["222", "b"]]),
      brandClicks: { a: 0, b: 0 },
      mode: "estimated",
    });
    expect(result.rows.map((r) => [r.brand_id, r.cost])).toEqual([["a", 1.01], ["b", 1]]);
    const exactOnly = allocateSpend({
      campaigns: [
        { campaign_id: "111", cost: 0.333333, clicks: 0, impressions: 0 },
        { campaign_id: "222", cost: 0.333333, clicks: 0, impressions: 0 },
        { campaign_id: "333", cost: 0.333334, clicks: 0, impressions: 0 },
      ],
      map: new Map([["111", "a"]]),
      brandClicks: { a: 0, b: 0 },
      mode: "exact_only",
    });
    expect(sumUnits(exactOnly.rows.map((r) => r.cost)) + units(exactOnly.unallocated)).toBe(100);
  });

  it("returns nothing for no campaigns", () => {
    expect(allocateSpend({ campaigns: [], map: new Map(), brandClicks, mode: "estimated" })).toEqual({ rows: [], unallocated: 0 });
  });

  it("puts unmapped cost in unallocated when the account has no brands", () => {
    const result = allocateSpend({
      campaigns: [{ campaign_id: "222", cost: 3, clicks: 1, impressions: 1 }], map: new Map(), brandClicks: {}, mode: "estimated",
    });
    expect(result).toEqual({ rows: [], unallocated: 3 });
  });

  it("adds brand parts and unallocated up to the account cost to the satang for 200 random inputs", () => {
    // Mulberry32 with a fixed seed: the same 200 cases on every run.
    let seed = 0x5eed_2026;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (max: number) => Math.floor(random() * (max + 1));
    for (let run = 0; run < 200; run++) {
      const brandIds = Array.from({ length: 1 + int(4) }, (_, i) => `brand-${i}`);
      const brandClicks = Object.fromEntries(brandIds.map((id) => [id, random() < 0.3 ? 0 : int(500)]));
      // AdKit reports micros: costs carry up to 6 decimals.
      const campaigns = Array.from({ length: int(8) }, (_, i) => ({
        campaign_id: String(1000 + i), cost: int(50_000_000_000) / 1_000_000, clicks: int(1000), impressions: int(100_000),
      }));
      // round2 of the exact raw sum, on integer micros (half up).
      const rawUnits = Math.round(campaigns.reduce((t, c) => t + Math.round(c.cost * 1_000_000), 0) / 10_000);
      const map = new Map(campaigns.filter(() => random() < 0.4).map((c) => [c.campaign_id, brandIds[int(brandIds.length - 1)]!]));
      const mode = random() < 0.5 ? "estimated" as const : "exact_only" as const;
      const result = allocateSpend({ campaigns, map, brandClicks, mode });
      const context = JSON.stringify({ run, brandClicks, campaigns, map: [...map], mode });
      expect(sumUnits(result.rows.map((r) => r.cost)) + units(result.unallocated), context).toBe(rawUnits);
      expect(result.rows.reduce((t, r) => t + r.clicks, 0), context)
        .toBe(campaigns.filter((c) => mode === "estimated" || brandIds.length === 1 || map.has(c.campaign_id)).reduce((t, c) => t + c.clicks, 0));
      if (brandIds.length === 1) expect(result.unallocated, context).toBe(0);
      for (const row of result.rows) {
        expect(Number.isFinite(row.cost) && row.cost >= 0, context).toBe(true);
        expect(Math.round(row.cost * 100) / 100, context).toBe(row.cost);
      }
      if (mode === "exact_only") expect(result.rows.every((r) => r.allocation === "exact"), context).toBe(true);
    }
  });
});

describe("deriveCampaignMap", () => {
  const NOW = new Date("2026-11-08T12:00:00.000Z");
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBrand("petvetpay", "t1");
    await h.seedBrand("bisoncash", "t2");
    await h.seedBrand("solo", "t3");
    await h.db.batch([
      h.db.prepare("UPDATE brand_runtime SET google_ads_account = '5381163935' WHERE brand_id IN ('petvetpay', 'bisoncash')"),
      h.db.prepare("UPDATE brand_runtime SET google_ads_account = '1111111111' WHERE brand_id = 'solo'"),
    ]);
  });
  afterAll(async () => { await h?.mf.dispose(); });

  let n = 0;
  const click = (brand: string, campaign: string | null, seenAt = "2026-11-07T10:00:00.000Z") =>
    h.db.prepare(`INSERT INTO click_sessions (click_session_id, gclid, utm_campaign, click_seen_at, first_seen_at, last_seen_at,
      created_at, hostname, brand_id) VALUES (?1, 'g', ?2, ?3, ?3, ?3, ?3, ?4, ?5)`)
      .bind(`cs-${++n}`, campaign, seenAt, `${brand}.example`, brand);
  const mapRows = () => h.db.prepare("SELECT account, campaign_id, brand_id, source FROM campaign_brand_map ORDER BY campaign_id").all();

  it("maps a campaign seen on 3 clicks of one brand to that brand and its account", async () => {
    await h.db.batch([click("petvetpay", "111"), click("petvetpay", "111"), click("petvetpay", "111"),
      click("bisoncash", "222"), click("bisoncash", "222")]);
    expect(await deriveCampaignMap(h.db, NOW)).toBe(1);
    expect((await mapRows()).results).toEqual([{ account: "5381163935", campaign_id: "111", brand_id: "petvetpay", source: "click" }]);
  });

  it("leaves a campaign seen on two brands unmapped", async () => {
    await h.db.batch([click("petvetpay", "111"), click("petvetpay", "111"), click("petvetpay", "111"), click("bisoncash", "111")]);
    expect(await deriveCampaignMap(h.db, NOW)).toBe(0);
    expect((await mapRows()).results).toEqual([]);
  });

  it("removes a click mapping once a second brand shows the campaign", async () => {
    await h.db.batch([click("petvetpay", "111"), click("petvetpay", "111"), click("petvetpay", "111")]);
    await deriveCampaignMap(h.db, NOW);
    await click("bisoncash", "111").run();
    await deriveCampaignMap(h.db, NOW);
    expect((await mapRows()).results).toEqual([]);
  });

  it("keeps a manual row and a create row over clicks", async () => {
    await h.db.batch([
      h.db.prepare(`INSERT INTO campaign_brand_map VALUES ('5381163935', '111', 'bisoncash', 'manual', ?1, ?1),
        ('5381163935', '222', 'bisoncash', 'create', ?1, ?1)`).bind("2026-11-01T00:00:00.000Z"),
      click("petvetpay", "111"), click("petvetpay", "111"), click("petvetpay", "111"),
      click("petvetpay", "222"), click("petvetpay", "222"), click("petvetpay", "222"), click("bisoncash", "222"),
    ]);
    expect(await deriveCampaignMap(h.db, NOW)).toBe(0);
    expect((await mapRows()).results).toEqual([
      { account: "5381163935", campaign_id: "111", brand_id: "bisoncash", source: "manual" },
      { account: "5381163935", campaign_id: "222", brand_id: "bisoncash", source: "create" },
    ]);
  });

  it("ignores clicks older than 30 days, non-numeric campaign values and brands without an account", async () => {
    await h.db.prepare("UPDATE brand_runtime SET google_ads_account = NULL WHERE brand_id = 'solo'").run();
    await h.db.batch([
      click("petvetpay", "111", "2026-10-01T00:00:00.000Z"), click("petvetpay", "111", "2026-10-01T00:00:00.000Z"),
      click("petvetpay", "111", "2026-10-01T00:00:00.000Z"),
      click("petvetpay", "{campaignid}"), click("petvetpay", "{campaignid}"), click("petvetpay", "{campaignid}"),
      click("petvetpay", null), click("petvetpay", null), click("petvetpay", null),
      click("solo", "999"), click("solo", "999"), click("solo", "999"),
    ]);
    expect(await deriveCampaignMap(h.db, NOW)).toBe(0);
    expect((await mapRows()).results).toEqual([]);
  });

  it("is idempotent", async () => {
    await h.db.batch([click("petvetpay", "111"), click("petvetpay", "111"), click("petvetpay", "111")]);
    await deriveCampaignMap(h.db, NOW);
    await deriveCampaignMap(h.db, NOW);
    expect((await mapRows()).results).toHaveLength(1);
  });
});
