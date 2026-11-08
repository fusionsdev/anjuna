import { describe, expect, it } from "vitest";
import { checkBudget } from "../src/ads-caps.js";

const caps = { capBrand: 3000, capTotal: 3000, enabledTotalToday: 0, enabledBrandToday: 0 };

describe("checkBudget", () => {
  it("allows a budget equal to both caps", () => {
    expect(checkBudget({ ...caps, requested: 3000 })).toEqual({ ok: true });
  });

  it("refuses 3001 against caps of 3000 as brand_cap", () => {
    expect(checkBudget({ ...caps, requested: 3001 })).toEqual({ ok: false, reason: "brand_cap" });
  });

  it("refuses when enabledTotalToday plus requested passes the total cap", () => {
    expect(checkBudget({ ...caps, capBrand: 3000, capTotal: 5000, enabledTotalToday: 4500, requested: 600 }))
      .toEqual({ ok: false, reason: "total_cap" });
    expect(checkBudget({ ...caps, capBrand: 3000, capTotal: 5000, enabledTotalToday: 4400, requested: 600 })).toEqual({ ok: true });
  });

  it("refuses when enabledBrandToday plus requested passes the brand cap", () => {
    expect(checkBudget({ ...caps, capTotal: 10000, enabledTotalToday: 2500, enabledBrandToday: 2500, requested: 501 }))
      .toEqual({ ok: false, reason: "brand_cap" });
  });

  it("never lets a brand cap above the total cap pass the total", () => {
    expect(checkBudget({ ...caps, capBrand: 9000, capTotal: 3000, requested: 3000.01 })).toEqual({ ok: false, reason: "total_cap" });
  });

  it("compares in satang, so 0.1 plus 0.2 fits a cap of 0.3", () => {
    expect(checkBudget({ capBrand: 0.3, capTotal: 0.3, enabledTotalToday: 0.1, enabledBrandToday: 0.1, requested: 0.2 })).toEqual({ ok: true });
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("refuses a requested budget of %s", (requested) => {
    expect(checkBudget({ ...caps, requested }).ok).toBe(false);
  });

  it("refuses when a cap is not a number", () => {
    expect(checkBudget({ ...caps, capTotal: Number.NaN, requested: 1 }).ok).toBe(false);
  });
});
