import { describe, expect, it } from "vitest";
import {
  ANALYTICS_FORWARD_PATHS,
  ANALYTICS_KINDS,
  ANALYTICS_LIMITS,
  AnalyticsForwardRequest,
  RpcError,
  type AnalyticsForwardRequest as AnalyticsForwardRequestT,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const kinds = ["posthog", "sentry", "telemetry", "errors"] as const;
const golden = (kind: string) => fixture<AnalyticsForwardRequestT>(`analytics/forward.${kind}.request.json`);

describe("analytics forward table", () => {
  it("has the four ADR-0004 kinds, each with a /analytics/ path and a byte limit", () => {
    expect([...ANALYTICS_KINDS]).toEqual(kinds);
    for (const kind of kinds) expect(ANALYTICS_FORWARD_PATHS[kind]).toBe(`/analytics/${kind}`);
    expect(ANALYTICS_LIMITS).toEqual({ posthog: 256 * 1024, sentry: 1024 * 1024, telemetry: 64 * 1024, errors: 64 * 1024 });
  });
});

describe("rate limited answer", () => {
  it("is an RpcError, so core and the brand Worker share one error shape", () => {
    expect(RpcError.parse({ error: "rate_limited" })).toEqual({ error: "rate_limited" });
    expect(RpcError.safeParse({ error: "rate_limited", retry_after: 60 }).success).toBe(false);
  });
});

describe("AnalyticsForwardRequest", () => {
  it.each(kinds)("parses the %s golden unchanged", (kind) => {
    const data = golden(kind);
    expect(AnalyticsForwardRequest.parse(data)).toEqual(data);
  });
  it("rejects an unknown kind, an extra field and a missing field", () => {
    const data = golden("posthog");
    expect(AnalyticsForwardRequest.safeParse({ ...data, kind: "gate-interest" }).success).toBe(false);
    expect(AnalyticsForwardRequest.safeParse({ ...data, credential: "x" }).success).toBe(false);
    const { content_type: _omitted, ...missing } = data;
    expect(AnalyticsForwardRequest.safeParse(missing).success).toBe(false);
  });
  it.each(["", "e/", "//evil.example/", "/../x", "/a/../b", "/a//b", "/e?x=1", "/e#x", "/%2e%2e/x", "https://evil.example/e", "/e\n"])(
    "rejects the path %j because it is not a plain suffix", (path) => {
      expect(AnalyticsForwardRequest.safeParse({ ...golden("posthog"), path }).success).toBe(false);
    });
  it("accepts PostHog and Sentry style suffixes", () => {
    for (const path of ["/", "/e/", "/i/v0/e/", "/batch/", "/flags/"]) {
      expect(AnalyticsForwardRequest.safeParse({ ...golden("posthog"), path }).success).toBe(true);
    }
  });
  it("accepts an optional visitor block and rejects a raw IP or an unknown visitor field", () => {
    const data = golden("telemetry");
    const visitor = { user_agent: "Mozilla/5.0", edge_timezone: "America/Chicago", ip_hash: "a".repeat(64), click_session_id: "c".repeat(43) };
    expect(AnalyticsForwardRequest.parse({ ...data, visitor })).toEqual({ ...data, visitor });
    expect(AnalyticsForwardRequest.safeParse({ ...data, visitor: {} }).success).toBe(true);
    expect(AnalyticsForwardRequest.safeParse({ ...data, visitor: { ip: "203.0.113.9" } }).success).toBe(false);
    expect(AnalyticsForwardRequest.safeParse({ ...data, visitor: { ip_hash: "203.0.113.9" } }).success).toBe(false);
    expect(AnalyticsForwardRequest.safeParse({ ...data, visitor: { user_agent: "a".repeat(513) } }).success).toBe(false);
  });
  it("rejects a content type with control characters", () => {
    expect(AnalyticsForwardRequest.safeParse({ ...golden("errors"), content_type: "text/plain\r\nx: y" }).success).toBe(false);
  });
  it.each(kinds)("allows a %s body at its limit and rejects one byte more", (kind) => {
    const limit = ANALYTICS_LIMITS[kind];
    expect(AnalyticsForwardRequest.safeParse({ ...golden(kind), body: "a".repeat(limit) }).success).toBe(true);
    expect(AnalyticsForwardRequest.safeParse({ ...golden(kind), body: "a".repeat(limit + 1) }).success).toBe(false);
  });
  it("counts UTF-8 bytes, not characters", () => {
    const limit = ANALYTICS_LIMITS.errors;
    expect(AnalyticsForwardRequest.safeParse({ ...golden("errors"), body: "é".repeat(limit / 2) }).success).toBe(true);
    expect(AnalyticsForwardRequest.safeParse({ ...golden("errors"), body: "é".repeat(limit / 2 + 1) }).success).toBe(false);
  });
  it("applies the brand and hostname rules shared with LeadsRpc", () => {
    expect(AnalyticsForwardRequest.safeParse({ ...golden("posthog"), brand_id: "Brand A" }).success).toBe(false);
    expect(AnalyticsForwardRequest.safeParse({ ...golden("posthog"), hostname: "https://brand-a.example" }).success).toBe(false);
  });
});
