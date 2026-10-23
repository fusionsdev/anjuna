import { AdminError, ConversionsReportResponse } from "@anjuna/contracts";
import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

/** The fixture as an employee must see it: no money, and no free-text error for the two raw-text codes. */
const employeeFixture = {
  ...conversionsFixture,
  value_totals: null,
  rows: conversionsFixture.rows.map((r) => ({
    ...r,
    value: null,
    last_error: r.reason_code === "platform_error" || r.reason_code === "not_ready" ? null : r.last_error,
  })),
};

describe("GET /api/conversions", () => {
  it("returns the mock report with value to the owner", async () => {
    const response = await call("/api/conversions?period=30d", { cookie: owner });
    expect(response.status).toBe(200);
    const body = ConversionsReportResponse.parse(await response.json());
    expect(body.period).toBe("30d");
    expect(body.value_totals).toEqual(conversionsFixture.value_totals);
    expect(body.rows).toHaveLength(conversionsFixture.rows.length);
    expect(body.rows.every((r) => typeof r.value === "number")).toBe(true);
    expect(body.rows.find((r) => r.reason_code === "platform_error")?.last_error).toBe("INVALID_GCLID: The gclid could not be decoded");

    // Filters narrow the rows; the period totals keep counting the whole window.
    const filtered = ConversionsReportResponse.parse(
      await (await call("/api/conversions?period=7d&status=dead&brand=brand-a", { cookie: owner })).json(),
    );
    expect(filtered.rows.length).toBeGreaterThan(0);
    expect(filtered.rows.every((r) => r.status === "dead" && r.brand === "brand-a")).toBe(true);
    expect(filtered.rows.length).toBeLessThan(conversionsFixture.rows.length);
    expect(filtered.totals).toEqual(conversionsFixture.totals);
  });

  it("returns counts with null money to an employee", async () => {
    const response = await call("/api/conversions?period=7d", { cookie: employee });
    expect(response.status).toBe(200);
    const body = ConversionsReportResponse.parse(await response.json());
    expect(body.totals).toEqual(conversionsFixture.totals);
    expect(body.value_totals).toBeNull();
    expect(body.rows).toHaveLength(conversionsFixture.rows.length);
    expect(body.rows.every((r) => r.value === null)).toBe(true);

    // Raw platform text is hidden; the reason code still tells the employee what is wrong.
    const raw = body.rows.filter((r) => r.reason_code === "platform_error" || r.reason_code === "not_ready");
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.last_error === null)).toBe(true);
    expect(body.rows.find((r) => r.reason_code === "no_route")?.last_error).toBe("no route for brand=brand-a hostname=a.example");

    // Redaction works on a copy: the next owner request still gets the money.
    const again = ConversionsReportResponse.parse(await (await call("/api/conversions?period=7d", { cookie: owner })).json());
    expect(again.value_totals).toEqual(conversionsFixture.value_totals);
    expect(again.rows.every((r) => typeof r.value === "number")).toBe(true);
  });

  it("orders mock rows dead, pending, processing, uploaded, then newest updated_at first", async () => {
    const rank = { dead: 0, pending: 1, processing: 2, uploaded: 3 } as const;
    const stamp = (r: { updated_at?: string | null; created_at: string }) => r.updated_at ?? r.created_at;
    // The fixture file is not sorted, so an unsorted mock would fail here.
    const fixtureIds = conversionsFixture.rows.map((r) => r.lead_id);
    for (const cookie of [owner, employee]) {
      const body = ConversionsReportResponse.parse(await (await call("/api/conversions?period=30d", { cookie })).json());
      expect(new Set(body.rows.map((r) => r.status))).toEqual(new Set(["dead", "pending", "processing", "uploaded"]));
      expect(body.rows.map((r) => r.lead_id)).not.toEqual(fixtureIds);
      for (let i = 1; i < body.rows.length; i++) {
        const before = body.rows[i - 1]!;
        const after = body.rows[i]!;
        expect(rank[before.status], `${before.lead_id} then ${after.lead_id}`).toBeLessThanOrEqual(rank[after.status]);
        if (before.status === after.status) expect(stamp(before) >= stamp(after), `${before.lead_id} then ${after.lead_id}`).toBe(true);
      }
    }
  });

  it("returns 401 without a session", async () => {
    expect((await call("/api/conversions?period=7d")).status).toBe(401);
  });

  it("rejects an unknown period or status with 422", async () => {
    const fetch = vi.fn(async () => Response.json(employeeFixture));
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    for (const query of ["period=90d", "period=7d&status=lost", "status=dead"]) {
      const response = await call(`/api/conversions?${query}`, { cookie: owner, env });
      expect(response.status).toBe(422);
      expect(AdminError.parse(await response.json())).toMatchObject({ error: "invalid" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards period, status and brand and the employee context to GET /admin/conversions", async () => {
    const seen: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      seen.push(request);
      return Response.json({ ...employeeFixture, period: "30d" });
    });
    const response = await call("/api/conversions?period=30d&status=dead&brand=brand-b", {
      cookie: employee,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(response.status).toBe(200);
    expect(ConversionsReportResponse.parse(await response.json()).value_totals).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe("/admin/conversions");
    expect(url.searchParams.get("period")).toBe("30d");
    expect(url.searchParams.get("status")).toBe("dead");
    expect(url.searchParams.get("brand")).toBe("brand-b");
    expect(seen[0]!.headers.get("x-actor-role")).toBe("employee");
  });
});
