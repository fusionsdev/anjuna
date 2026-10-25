// spec traffic
import { describe, expect, it } from "vitest";
import {
  ClientErrorsQuery,
  ClientErrorsResponse,
  TrafficReportResponse,
  trafficLogBuckets,
  trafficLogWindow,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const TRAFFIC = "admin/traffic-report.response.json";
const ERRORS = "admin/client-errors.response.json";

describe("traffic log windows", () => {
  it("trafficLogWindow 24h starts 23 hours before the current UTC hour", () => {
    const now = new Date("2026-11-02T12:34:00.000Z");
    const w = trafficLogWindow("24h", now);
    expect(w).toEqual({ from: "2026-11-01T13:00:00.000Z", to: "2026-11-02T12:34:00.000Z", bucket: "hour" });
    const buckets = trafficLogBuckets(w);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toBe(w.from);
    expect(buckets[23]).toBe("2026-11-02T12:00:00.000Z");
  });

  it("trafficLogWindow 7d and 30d are UTC calendar days including today", () => {
    const now = new Date("2026-11-02T12:34:00.000Z");
    const w7 = trafficLogWindow("7d", now);
    expect(w7).toEqual({ from: "2026-10-27T00:00:00.000Z", to: "2026-11-02T12:34:00.000Z", bucket: "day" });
    const b7 = trafficLogBuckets(w7);
    expect(b7).toHaveLength(7);
    expect(b7[6]).toBe("2026-11-02T00:00:00.000Z");
    const w30 = trafficLogWindow("30d", now);
    expect(w30.from).toBe("2026-10-04T00:00:00.000Z");
    expect(w30.bucket).toBe("day");
    expect(trafficLogBuckets(w30)).toHaveLength(30);
  });

  it("trafficLogBuckets keeps 24, 7 and 30 buckets when now is exactly on a UTC midnight", () => {
    const now = new Date("2026-11-02T00:00:00.000Z");
    expect(trafficLogBuckets(trafficLogWindow("24h", now))).toHaveLength(24);
    expect(trafficLogBuckets(trafficLogWindow("7d", now))).toHaveLength(7);
    expect(trafficLogBuckets(trafficLogWindow("30d", now))).toHaveLength(30);
  });
});

describe("traffic report and client errors schemas", () => {
  it("TrafficReportResponse rejects an extra field and a raw session id", () => {
    const body = fixture<{ recent: Record<string, unknown>[] }>(TRAFFIC);
    expect(TrafficReportResponse.safeParse(body).success).toBe(true);
    const leaked = { ...body, recent: [{ ...body.recent[0], session_id: "s-1" }, ...body.recent.slice(1)] };
    expect(TrafficReportResponse.safeParse(leaked).success).toBe(false);
    expect(TrafficReportResponse.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it("ClientErrorsQuery rejects a bad cursor, an unknown period and an extra key", () => {
    expect(ClientErrorsQuery.safeParse({ cursor: "0" }).success).toBe(false);
    expect(ClientErrorsQuery.safeParse({ cursor: "abc" }).success).toBe(false);
    expect(ClientErrorsQuery.safeParse({ cursor: "01" }).success).toBe(false);
    expect(ClientErrorsQuery.safeParse({ cursor: "1234567890123456" }).success).toBe(false);
    expect(ClientErrorsQuery.safeParse({ cursor: "123456789012345" }).success).toBe(true);
    expect(ClientErrorsQuery.safeParse({ period: "today" }).success).toBe(false);
    expect(ClientErrorsQuery.safeParse({ foo: 1 }).success).toBe(false);
    expect(ClientErrorsQuery.parse({})).toEqual({ period: "24h" });
  });

  it("ClientErrorsResponse accepts a null message and a null brand", () => {
    const body = ClientErrorsResponse.parse(fixture(ERRORS));
    const row = body.rows.find((r) => r.brand_id === null);
    expect(row).toMatchObject({ brand_id: null, hostname: null, error_message: null });
    expect(body.next_cursor).toBeNull();
  });
});
