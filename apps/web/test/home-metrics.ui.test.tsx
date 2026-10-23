import { describe, expect, it } from "vitest";
import { delta, previousRange } from "../src/client/home-metrics";

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
