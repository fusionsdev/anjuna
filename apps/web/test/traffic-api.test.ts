import { adminContextFromHeaders, TrafficBreakdownResponse } from "@anjuna/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { call, makeEnv, sessions, setupDatabases } from "./helpers";

beforeAll(setupDatabases);

describe("GET /api/traffic/breakdown", () => {
  it("requires a session", async () => {
    expect((await call("/api/traffic/breakdown?period=today&by=source")).status).toBe(401);
  });
  it.each(["source", "domain", "device", "browser", "hour"])("allows an employee to read %s", async (by) => {
    const response = await call(`/api/traffic/breakdown?period=7d&by=${by}`, { cookie: await sessions.employee() });
    expect(response.status).toBe(200);
    const data = TrafficBreakdownResponse.parse(await response.json());
    expect(data).toMatchObject({ period: "7d", by });
    expect(data.rows).toHaveLength(by === "hour" ? 24 : 0);
  });
  it.each(["period=year&by=source", "period=today&by=sql", "period=7d&by=source&hostname=secret"])("rejects invalid query %s", async (query) => {
    expect((await call(`/api/traffic/breakdown?${query}`, { cookie: await sessions.owner() })).status).toBe(422);
  });
  it("forwards the session identity and query through CORE, with no leads D1 binding", async () => {
    const cookie = await sessions.employee();
    const payload = { period: "30d", by: "domain", from: "2026-10-01T00:00:00.000Z", to: "2026-10-22T12:00:00.000Z", timezone: "America/New_York", rows: [{ key: "brand-a.example", visits: 10, leads: 2 }], brands: [] };
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/admin/traffic/breakdown");
      expect(new URL(request.url).search).toBe("?period=30d&by=domain");
      expect(adminContextFromHeaders(request.headers)).toMatchObject({ actor_role: "employee" });
      return Response.json(payload);
    });
    const environment = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    expect(environment).not.toHaveProperty("LEADS");
    const response = await call("/api/traffic/breakdown?period=30d&by=domain", { cookie, env: environment });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects malformed core responses", async () => {
    const environment = makeEnv({ MOCK_CORE: "0", CORE: { fetch: async () => Response.json({ rows: [], secret: "must-not-leak" }) } as unknown as Fetcher });
    const response = await call("/api/traffic/breakdown?period=today&by=source", { cookie: await sessions.owner(), env: environment });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("must-not-leak");
  });
});
