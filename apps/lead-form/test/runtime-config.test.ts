import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, readRuntimeConfig } from "../src/lib/runtime-config";

describe("runtime config (BR-5)", () => {
  it("keeps the allowed fields", () => {
    expect(
      parseRuntimeConfig({
        amount: 3250,
        zip: "90210",
        keyword: "Fast Cash Loans",
        formRoute: "/request",
        brand: "Example Brand",
        variant: "lite_v1",
        proxies: { posthog: "/_ph", sentry: "/_st" },
      }),
    ).toEqual({
      amount: 3250,
      zip: "90210",
      keyword: "Fast Cash Loans",
      formRoute: "/request",
      brand: "Example Brand",
      variant: "lite_v1",
      proxies: { posthog: "/_ph", sentry: "/_st" },
    });
  });

  it("parses label like keyword: trimmed, capped at 60, absent when empty or not a string", () => {
    expect(parseRuntimeConfig({ label: " Vet Payment Plans " }).label).toBe("Vet Payment Plans");
    expect(parseRuntimeConfig({ label: "x".repeat(200) }).label).toHaveLength(60);
    for (const bad of [null, "", "   ", 7, ["a"]]) expect("label" in parseRuntimeConfig({ label: bad })).toBe(false);
    expect("label" in parseRuntimeConfig({ keyword: "Fast Cash" })).toBe(false);
  });

  it("drops unknown fields such as brand_id or secrets", () => {
    const cfg = parseRuntimeConfig({ brand: "B", brand_id: "b_123", token: "secret" }) as Record<string, unknown>;
    expect(cfg).toEqual({ brand: "B" });
  });

  it("caps the keyword at 60 chars and rejects a bad ZIP", () => {
    const cfg = parseRuntimeConfig({ keyword: "x".repeat(200), zip: "9021" });
    expect(cfg.keyword).toHaveLength(60);
    expect(cfg.zip).toBeUndefined();
  });

  it("only accepts same-origin proxy paths", () => {
    for (const bad of ["https://evil.example/ingest", "//evil.example", "/ok?x=1", "relative", 7]) {
      expect(parseRuntimeConfig({ proxies: { posthog: bad, sentry: bad } }).proxies).toBeUndefined();
    }
    expect(parseRuntimeConfig({ proxies: { posthog: "/_ph/" } }).proxies).toEqual({ posthog: "/_ph" });
  });

  it("returns {} for missing or malformed config", () => {
    expect(parseRuntimeConfig(null)).toEqual({});
    expect(parseRuntimeConfig([1, 2])).toEqual({});
    document.head.innerHTML = '<script type="application/json" id="cfg">{not json</script>';
    expect(readRuntimeConfig(document)).toEqual({});
    document.head.innerHTML = "";
    expect(readRuntimeConfig(document)).toEqual({});
  });
});
