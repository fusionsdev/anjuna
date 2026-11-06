import { describe, expect, it } from "vitest";
import { sparklinePoints } from "../src/client/components/Sparkline";
import { delta, previousRange, spendSeries, spendTotals } from "../src/client/home-metrics";

describe("previousRange", () => {
  it("returns the window of equal length that ends where the range starts", () => {
    expect(previousRange({ from: "2026-10-17T00:00:00.000Z", to: "2026-10-24T00:00:00.000Z" }))
      .toEqual({ from: "2026-10-10T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" });
  });
  it("gives yesterday for a one-day range", () => {
    expect(previousRange({ from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" }))
      .toEqual({ from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z" });
  });
});

describe("delta", () => {
  it("rounds the percent change", () => {
    expect(delta(112, 100)).toEqual({ text: "▲ 12%", dir: "up" });
    expect(delta(95, 100)).toEqual({ text: "▼ 5%", dir: "down" });
    expect(delta(100, 100)).toEqual({ text: "0%", dir: "flat" });
  });
  it("shows a dash when the previous value is 0 or missing", () => {
    expect(delta(5, 0)).toEqual({ text: "–", dir: "flat" });
    expect(delta(5, null)).toEqual({ text: "–", dir: "flat" });
    expect(delta(null, 5)).toEqual({ text: "–", dir: "flat" });
  });
  it("returns null while either value is loading", () => {
    expect(delta(undefined, 5)).toBeNull();
    expect(delta(5, undefined)).toBeNull();
  });
});

describe("spendTotals", () => {
  const report = (THB: number, USD: number, clicks: number, brands = 1) => ({
    period: "7d" as const, from: "2026-10-16", to: "2026-10-22",
    totals: { cost_by_currency: { THB, USD }, clicks, impressions: 0 },
    brands: Array.from({ length: brands }, (_, i) => ({ brand_id: `b${i}`, currency: "THB" as const, cost: THB, cost_usd: 0, clicks, impressions: 0, updated_at: "2026-10-22T09:00:00.000Z" })),
    total_cost_usd: 375.66, fx: { thbPerUsd: 35 }, daily: [],
  });

  it("adds USD-billed spend to the baht figure at the server's rate and keeps the server's USD total", () => {
    expect(spendTotals(report(12448, 20, 5))).toEqual({ thb: 13148, usd: 375.66, clicks: 5 });
  });

  it("is null when the period has no AdKit rows", () => {
    expect(spendTotals(report(0, 0, 0, 0))).toBeNull();
  });
});

describe("spendSeries", () => {
  const report = (daily: Array<{ date: string; cost: number; currency: "THB" | "USD" }>) => ({
    period: "7d" as const, from: "2026-10-20", to: "2026-10-23",
    totals: { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 }, brands: [], total_cost_usd: 0, fx: { thbPerUsd: 35 }, daily,
  });

  it("returns one baht value per UTC day of the window, 0 for a day with no entry", () => {
    expect(spendSeries(report([{ date: "2026-10-21", cost: 100, currency: "THB" }, { date: "2026-10-23", cost: 50, currency: "THB" }])))
      .toEqual([0, 100, 0, 50]);
  });

  it("adds a USD entry at the server's rate to the baht of the same day, never as a bare number", () => {
    expect(spendSeries(report([{ date: "2026-10-22", cost: 100, currency: "THB" }, { date: "2026-10-22", cost: 2, currency: "USD" }])))
      .toEqual([0, 0, 170, 0]);
  });

  it("is null when core sent no daily rows", () => {
    expect(spendSeries(report([]))).toBeNull();
  });
});

describe("sparklinePoints", () => {
  it("scales to the largest value with the smallest on the floor", () => {
    expect(sparklinePoints([0, 5, 10], 96, 28)).toBe("0,26 48,14 96,2");
  });

  it("draws a flat floor line when every value is 0", () => {
    expect(sparklinePoints([0, 0], 96, 28)).toBe("0,26 96,26");
  });

  it("gives no points for fewer than two values", () => {
    expect(sparklinePoints([5])).toBe("");
    expect(sparklinePoints([])).toBe("");
  });
});
