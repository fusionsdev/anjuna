import { describe, expect, it } from "vitest";
import { delta, previousRange, spendTotals } from "../src/client/home-metrics";

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
    total_cost_usd: 375.66, fx: { thbPerUsd: 35 },
  });

  it("adds USD-billed spend to the baht figure at the server's rate and keeps the server's USD total", () => {
    expect(spendTotals(report(12448, 20, 5))).toEqual({ thb: 13148, usd: 375.66, clicks: 5 });
  });

  it("is null when the period has no AdKit rows", () => {
    expect(spendTotals(report(0, 0, 0, 0))).toBeNull();
  });
});
