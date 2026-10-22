import { AdminError, SpendReportResponse } from "@anjuna/contracts";
import spendFixture from "@anjuna/contracts/fixtures/admin/spend.response.json";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
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

describe("GET /api/spend (owner only)", () => {
  it("returns the core spend report to the owner", async () => {
    const response = await call("/api/spend?period=7d", { cookie: owner });
    expect(response.status).toBe(200);
    expect(SpendReportResponse.parse(await response.json())).toEqual(spendFixture);
  });

  it("returns 403 forbidden_role to an employee without calling core", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const response = await call("/api/spend?period=7d", {
      cookie: employee,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(response.status).toBe(403);
    expect(AdminError.parse(await response.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    expect((await call("/api/spend?period=7d")).status).toBe(401);
  });

  it("rejects an unknown period with 422", async () => {
    expect((await call("/api/spend?period=90d", { cookie: owner })).status).toBe(422);
  });

  it("forwards the period and the owner's context to GET /admin/spend on core", async () => {
    const seen: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      seen.push(request);
      return Response.json({ ...spendFixture, period: "today" });
    });
    const response = await call("/api/spend?period=today", {
      cookie: owner,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(response.status).toBe(200);
    expect(new URL(seen[0]!.url).pathname).toBe("/admin/spend");
    expect(new URL(seen[0]!.url).searchParams.get("period")).toBe("today");
    expect(seen[0]!.headers.get("x-actor-role")).toBe("owner");
  });
});

describe("api.spend", () => {
  it("GETs /api/spend with the period", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(spendFixture));
    expect(await api.spend("30d")).toEqual(spendFixture);
    expect(fetch).toHaveBeenCalledWith("/api/spend?period=30d", expect.objectContaining({ method: "GET" }));
  });
});
