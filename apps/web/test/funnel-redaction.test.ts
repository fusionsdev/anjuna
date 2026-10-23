import { FunnelReportResponse } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
beforeAll(async () => { await setupDatabases(); });
beforeEach(async () => { resetState(); owner = await sessions.owner(); employee = await sessions.employee(); });

describe("GET /api/funnel money redaction (mock core)", () => {
  const path = "/api/funnel?from=2026-10-01T00:00:00.000Z&to=2026-10-08T00:00:00.000Z";
  it("gives the owner revenue numbers", async () => {
    const body = FunnelReportResponse.parse(await (await call(path, { cookie: owner })).json());
    expect(body.rows.some((r) => typeof r.revenue === "number")).toBe(true);
  });
  it("gives an employee null revenue on every row", async () => {
    const body = FunnelReportResponse.parse(await (await call(path, { cookie: employee })).json());
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.revenue === null)).toBe(true);
  });
});
