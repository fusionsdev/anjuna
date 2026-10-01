import { describe, expect, it } from "vitest";
import { cleanKeyword, encodeRuntimeConfig, parseRuntimeConfig, RuntimeConfig } from "../src/index.js";
import { fixture } from "./helpers.js";

describe("brand runtime config (#cfg)", () => {
  it.each(["runtime-config/cfg.valid.json", "runtime-config/cfg.no-keyword.json"])("%s parses", (f) => {
    expect(RuntimeConfig.safeParse(fixture(f)).success).toBe(true);
  });

  it("rejects brand_id or any other unknown key (BR-5)", () => {
    expect(RuntimeConfig.safeParse(fixture("runtime-config/cfg.invalid.leaks-brand-id.json")).success).toBe(false);
    const ok = fixture<Record<string, unknown>>("runtime-config/cfg.valid.json");
    for (const leak of ["posthogKey", "sentryDsn", "token", "aid"]) {
      expect(RuntimeConfig.safeParse({ ...ok, [leak]: "x" }).success).toBe(false);
    }
  });

  it("covers the spike's cfg keys plus variant", () => {
    // spike/brand-worker: { amount, zip, keyword, formRoute, brand }
    const keys = Object.keys(RuntimeConfig.shape);
    for (const k of ["amount", "zip", "keyword", "formRoute", "brand", "variant"]) expect(keys).toContain(k);
  });

  it("brand and variant may not carry platform strings", () => {
    const ok = fixture<Record<string, unknown>>("runtime-config/cfg.valid.json");
    expect(RuntimeConfig.safeParse({ ...ok, brand: "Aurum Loans" }).success).toBe(false);
    expect(RuntimeConfig.safeParse({ ...ok, variant: "aurum-14-step" }).success).toBe(false);
  });

  it("formRoute cannot shadow reserved routes", () => {
    const ok = fixture<Record<string, unknown>>("runtime-config/cfg.valid.json");
    for (const r of ["/go", "/_f", "/api/leads", "/request/", "request"]) {
      expect(RuntimeConfig.safeParse({ ...ok, formRoute: r }).success).toBe(false);
    }
  });

  it("keyword must already be clean (BR-4)", () => {
    const ok = fixture<Record<string, unknown>>("runtime-config/cfg.valid.json");
    expect(RuntimeConfig.safeParse({ ...ok, keyword: "fast cash loans" }).success).toBe(false);
    expect(RuntimeConfig.safeParse({ ...ok, keyword: "<script>alert(1)</script>" }).success).toBe(false);
  });

  it("cleanKeyword matches the spike e2e expectations", () => {
    expect(cleanKeyword("fast cash loans")).toBe("Fast Cash Loans");
    expect(cleanKeyword("<script>alert(1)</script>")).toBe("Script Alert 1 Script");
    expect(cleanKeyword(null)).toBeNull();
    expect(cleanKeyword("!!!")).toBeNull();
    expect(cleanKeyword("x".repeat(80))!.length).toBeLessThanOrEqual(60);
  });

  it("encode escapes '<' and round-trips through parse", () => {
    const cfg = RuntimeConfig.parse(fixture("runtime-config/cfg.valid.json"));
    const text = encodeRuntimeConfig(cfg);
    expect(text).not.toContain("<");
    expect(parseRuntimeConfig(text)).toEqual(cfg);
    expect(parseRuntimeConfig("not json")).toBeNull();
    expect(parseRuntimeConfig(null)).toBeNull();
  });
});
