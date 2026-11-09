import { expect, it } from "vitest";
import { TrafficRealtimeQuery } from "../src/index.js";

it("defaults the period and validates bounded canonical brand filters", () => {
  expect(TrafficRealtimeQuery.parse({})).toEqual({ period: "24h" });
  expect(TrafficRealtimeQuery.parse({ period: "7d", brand: "brand-a,brand-b" })).toEqual({ period: "7d", brand: "brand-a,brand-b" });
  for (const query of [{ period: "1h" }, { brand: "a,,b" }, { brand: "a.example" }, { brand: Array(501).fill("a").join(",") }, { extra: true }]) {
    expect(TrafficRealtimeQuery.safeParse(query).success).toBe(false);
  }
});
