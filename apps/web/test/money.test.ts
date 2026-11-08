import { SpendReportResponse } from "@anjuna/contracts";
import { describe, expect, it } from "vitest";
import { toUsd, withUsd } from "../src/server/money";

describe("toUsd", () => {
  it("divides baht by the rate", () => {
    expect(toUsd(12448, "THB", 35)).toBeCloseTo(355.66, 2);
  });

  it("returns a dollar amount unchanged", () => {
    expect(toUsd(5, "USD", 35)).toBe(5);
  });

  it.each([0, -35, Number.NaN, Number.POSITIVE_INFINITY])("throws on rate %s", (rate) => {
    expect(() => toUsd(1, "THB", rate)).toThrow(RangeError);
    expect(() => toUsd(1, "USD", rate)).toThrow(RangeError);
  });
});

describe("withUsd", () => {
  const report = SpendReportResponse.parse({
    period: "7d", from: "2026-10-16", to: "2026-10-22",
    totals: { cost_by_currency: { THB: 12448, USD: 20 }, clicks: 5, impressions: 50 },
    brands: [
      { brand_id: "brand-a", currency: "THB", cost: 12448, clicks: 3, impressions: 30, updated_at: "2026-10-22T09:00:00.000Z" },
      { brand_id: "brand-b", currency: "USD", cost: 20, clicks: 2, impressions: 20, updated_at: "2026-10-22T09:00:00.000Z" },
    ],
  });

  it("adds cost_usd per brand in cents, the USD total and the rate used", () => {
    const out = withUsd(report, 35);
    expect(out.brands.map((b) => [b.brand_id, b.currency, b.cost, b.cost_usd])).toEqual([
      ["brand-a", "THB", 12448, 355.66],
      ["brand-b", "USD", 20, 20],
    ]);
    expect(out.total_cost_usd).toBe(375.66);
    expect(out.fx).toEqual({ thbPerUsd: 35 });
    expect(out.totals).toEqual(report.totals);
  });
});
