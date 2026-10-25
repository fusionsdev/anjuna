import {
  AdminError,
  ClientErrorsResponse,
  TRAFFIC_RECENT_COLUMNS,
  TrafficReportResponse,
  trafficLogBuckets,
  trafficLogWindow,
} from "@anjuna/contracts";
import clientErrorsFixture from "@anjuna/contracts/fixtures/admin/client-errors.response.json";
import trafficFixture from "@anjuna/contracts/fixtures/admin/traffic-report.response.json";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trafficCsv } from "../src/server/traffic-log";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(async () => {
  await setupDatabases();
});
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const report = TrafficReportResponse.parse(trafficFixture);

describe("GET /api/traffic/report (FUS-379)", () => {
  it("returns the parsed report to an employee and an owner", async () => {
    for (const cookie of [employee, owner]) {
      const res = await call("/api/traffic/report?period=7d", { cookie });
      expect(res.status).toBe(200);
      const body = TrafficReportResponse.parse(await res.json());
      expect(body.period).toBe("7d");
      expect(body.totals).toEqual(trafficFixture.totals);
      expect(body.recent).toHaveLength(trafficFixture.recent.length);
    }
    const window = trafficLogWindow("24h");
    const day = TrafficReportResponse.parse(await (await call("/api/traffic/report", { cookie: employee })).json());
    expect(day.period).toBe("24h");
    expect(day.bucket).toBe("hour");
    expect(day.trend).toHaveLength(trafficLogBuckets(window).length);
    expect(day.trend.slice(1).every((t) => t.landing_views === 0)).toBe(true);
  });

  it("rejects an unknown period with 422 before core is called", async () => {
    const fetch = vi.fn(async () => Response.json(trafficFixture));
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    for (const path of ["/api/traffic/report?period=90d", "/api/traffic/report.csv?period=today", "/api/traffic/report?foo=1"]) {
      const res = await call(path, { cookie: employee, env });
      expect(res.status).toBe(422);
      expect(AdminError.parse(await res.json())).toMatchObject({ error: "invalid" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/traffic/report.csv (FUS-379)", () => {
  it("returns the recent table with the spec columns", async () => {
    const res = await call("/api/traffic/report.csv", { cookie: employee });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="traffic-24h.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const lines = (await res.text()).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe(TRAFFIC_RECENT_COLUMNS.join(","));
    expect(lines.slice(1, -1)).toHaveLength(trafficFixture.recent.length);
    expect(lines[1]).toBe("2026-11-02T12:31:07.000Z,lead_submitted,brand-a.example,brand-a,4,,mobile,chrome,google,3f9a1c0be274");

    const week = await call("/api/traffic/report.csv?period=30d", { cookie: owner });
    expect(week.headers.get("content-disposition")).toBe('attachment; filename="traffic-30d.csv"');
  });

  it("passes a core error through as JSON with its status", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await call("/api/traffic/report.csv?period=7d", {
      cookie: employee,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("trafficCsv", () => {
  it("neutralises a formula in source", () => {
    const row = { ...report.recent[0]!, source: "=HYPERLINK(1)" };
    const lines = trafficCsv({ ...report, recent: [row] }).split("\r\n");
    expect(lines[1]!.split(",")[8]).toBe("'=HYPERLINK(1)");
  });

  it("never writes a session id column", () => {
    const header = trafficCsv(report).split("\r\n")[0]!.split(",");
    expect(header).toEqual([...TRAFFIC_RECENT_COLUMNS]);
    for (const banned of ["session_id", "click_session_id", "brand"]) expect(header).not.toContain(banned);
  });
});

describe("GET /api/client-errors (FUS-379)", () => {
  it("hides error_message from an employee and shows it to an owner", async () => {
    const asEmployee = ClientErrorsResponse.parse(await (await call("/api/client-errors?period=7d", { cookie: employee })).json());
    expect(asEmployee.rows).toHaveLength(clientErrorsFixture.rows.length);
    expect(asEmployee.rows.every((r) => r.error_message === null)).toBe(true);

    const asOwner = ClientErrorsResponse.parse(await (await call("/api/client-errors?period=7d", { cookie: owner })).json());
    expect(asOwner.period).toBe("7d");
    expect(asOwner.rows.map((r) => r.error_message)).toEqual(clientErrorsFixture.rows.map((r) => r.error_message));
    expect(asOwner.rows.some((r) => r.error_message !== null)).toBe(true);
  });

  it("filters the mock by brand and type; counts ignore the type filter", async () => {
    const byBrand = ClientErrorsResponse.parse(await (await call("/api/client-errors?brand_id=brand-b", { cookie: owner })).json());
    expect(byBrand.rows.map((r) => r.id)).toEqual([41]);
    expect(byBrand.counts).toEqual([{ error_type: "submission_error", count: 1 }]);

    const byType = ClientErrorsResponse.parse(await (await call("/api/client-errors?error_type=timeout", { cookie: owner })).json());
    expect(byType.rows.map((r) => r.id)).toEqual([42, 40]);
    expect(byType.counts).toEqual(clientErrorsFixture.counts);
  });

  it("pages by cursor through the mock: older rows only, counts unchanged", async () => {
    const page = ClientErrorsResponse.parse(await (await call("/api/client-errors?cursor=42", { cookie: owner })).json());
    expect(page.rows.map((r) => r.id)).toEqual([41, 40]);
    expect(page.counts).toEqual(clientErrorsFixture.counts);
    expect(page.next_cursor).toBeNull();
  });

  it("rejects a bad cursor, a bad period and an extra key with 422 before core is called", async () => {
    const fetch = vi.fn(async () => Response.json(clientErrorsFixture));
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    for (const query of ["cursor=0", "period=today", "foo=1"]) {
      const res = await call(`/api/client-errors?${query}`, { cookie: employee, env });
      expect(res.status, query).toBe(422);
      expect(AdminError.parse(await res.json())).toMatchObject({ error: "invalid" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards period, brand_id, error_type and cursor to core", async () => {
    const seen: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      seen.push(request);
      return Response.json(clientErrorsFixture);
    });
    const res = await call("/api/client-errors?period=30d&brand_id=brand-a&error_type=timeout&cursor=42", {
      cookie: employee,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/admin/client-errors");
    expect(url.searchParams.get("period")).toBe("30d");
    expect(url.searchParams.get("brand_id")).toBe("brand-a");
    expect(url.searchParams.get("error_type")).toBe("timeout");
    expect(url.searchParams.get("cursor")).toBe("42");
    expect(seen[0]!.headers.get("x-actor-role")).toBe("employee");
  });
});

describe("traffic log routes without a session", () => {
  it("return 401", async () => {
    for (const path of ["/api/traffic/report", "/api/traffic/report.csv", "/api/client-errors"]) {
      expect((await call(path)).status, path).toBe(401);
    }
  });
});
