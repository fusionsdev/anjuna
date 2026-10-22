import { describe, expect, it } from "vitest";
import { SPEND_INGEST_MAX_ROWS, SpendIngestRequest, SpendQuery, spendPeriodRange } from "../src/index.js";

const row = { brand_id: "brand-a", date: "2026-10-21", hour: 13, cost: 12.5, clicks: 9, impressions: 300 };

describe("spend contract: POST /api/spend/ingest body", () => {
  it("accepts hourly rows, whole-day rows (hour null or absent) and zero values", () => {
    const parsed = SpendIngestRequest.parse({ rows: [row, { ...row, hour: null }, { ...row, hour: undefined, cost: 0, clicks: 0, impressions: 0 }] });
    expect(parsed.rows).toHaveLength(3);
    expect(SpendIngestRequest.safeParse({ rows: [] }).success).toBe(true);
  });

  it.each([
    ["hour 24", { hour: 24 }],
    ["hour -1", { hour: -1 }],
    ["fractional hour", { hour: 1.5 }],
    ["negative cost", { cost: -0.01 }],
    ["string cost", { cost: "12.50" }],
    ["fractional clicks", { clicks: 1.5 }],
    ["negative impressions", { impressions: -1 }],
    ["bad date", { date: "2026-13-01" }],
    ["timestamp date", { date: "2026-10-21T00:00:00Z" }],
    ["bad brand id", { brand_id: "Brand A" }],
    ["extra key", { source: "bing" }],
  ])("rejects %s", (_name, override) => {
    expect(SpendIngestRequest.safeParse({ rows: [{ ...row, ...override }] }).success).toBe(false);
  });

  it("rejects a missing rows array and more than SPEND_INGEST_MAX_ROWS rows", () => {
    expect(SpendIngestRequest.safeParse({}).success).toBe(false);
    expect(SpendIngestRequest.safeParse({ rows: Array(SPEND_INGEST_MAX_ROWS + 1).fill(row) }).success).toBe(false);
  });
});

describe("spend contract: GET /admin/spend", () => {
  it("accepts only today, 7d and 30d", () => {
    for (const period of ["today", "7d", "30d"]) expect(SpendQuery.safeParse({ period }).success).toBe(true);
    for (const period of ["", "1d", "90d", "TODAY"]) expect(SpendQuery.safeParse({ period }).success).toBe(false);
    expect(SpendQuery.safeParse({}).success).toBe(false);
  });

  it("maps a period to an inclusive UTC day range ending today", () => {
    const now = new Date("2026-10-22T23:59:59.000Z");
    expect(spendPeriodRange("today", now)).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(spendPeriodRange("7d", now)).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(spendPeriodRange("30d", now)).toEqual({ from: "2026-09-23", to: "2026-10-22" });
    expect(spendPeriodRange("7d", new Date("2026-03-02T00:00:00.000Z"))).toEqual({ from: "2026-02-24", to: "2026-03-02" });
  });
});
