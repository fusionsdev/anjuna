// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VARIANTS, variantFromConfig } from "../src/lib/experiment";

describe("A/B variant from cfg.variant (FO-3)", () => {
  it("maps known server-assigned arms", () => {
    expect(variantFromConfig("lite_v1")).toEqual({ variant: VARIANTS.LITE, source: "server" });
    expect(variantFromConfig("lite")).toEqual({ variant: VARIANTS.LITE, source: "server" });
    expect(variantFromConfig("full_v1")).toEqual({ variant: VARIANTS.FULL, source: "server" });
    expect(variantFromConfig("FULL")).toEqual({ variant: VARIANTS.FULL, source: "server" });
  });

  it("falls back to lite_v1 (V1's 100% rollout) when missing or unknown", () => {
    expect(variantFromConfig(undefined)).toEqual({ variant: VARIANTS.LITE, source: "fallback" });
    expect(variantFromConfig("")).toEqual({ variant: VARIANTS.LITE, source: "fallback" });
    expect(variantFromConfig("b")).toEqual({ variant: VARIANTS.LITE, source: "fallback" });
  });

  it("keeps the exact lite_v1 string core keys its relaxed validation on", () => {
    expect(VARIANTS.LITE).toBe("lite_v1");
  });

  it("has no client-side randomness or stored assignment", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/lib/experiment.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(src).not.toMatch(/location\.search/);
  });
});
