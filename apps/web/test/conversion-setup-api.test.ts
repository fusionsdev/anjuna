import { AdminError, ConversionSetupStateResponse } from "@anjuna/contracts";
import conversionSetupFixture from "@anjuna/contracts/fixtures/admin/conversion-setup.response.json";
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

describe("GET /api/brands/:id/conversion-setup (owner only)", () => {
  it("GET /api/brands/:id/conversion-setup forwards to core for the owner and answers 403 for an employee", async () => {
    const seen: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      seen.push(request);
      return Response.json(conversionSetupFixture);
    });
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });

    const ok = await call("/api/brands/brand-a/conversion-setup", { cookie: owner, env });
    expect(ok.status).toBe(200);
    expect(ConversionSetupStateResponse.parse(await ok.json())).toEqual(conversionSetupFixture);
    expect(new URL(seen[0]!.url).pathname).toBe("/admin/brands/brand-a/conversion-setup");
    expect(seen[0]!.headers.get("x-actor-role")).toBe("owner");

    const denied = await call("/api/brands/brand-a/conversion-setup", { cookie: employee, env });
    expect(denied.status).toBe(403);
    expect(AdminError.parse(await denied.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers the fixture from the mock core and 401 without a session", async () => {
    const res = await call("/api/brands/brand-a/conversion-setup", { cookie: owner });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(conversionSetupFixture);
    expect((await call("/api/brands/brand-a/conversion-setup")).status).toBe(401);
  });

  it("answers 404 for a malformed brand id without calling core", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const res = await call("/api/brands/Not%20A%20Brand/conversion-setup", {
      cookie: owner,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(res.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("api.conversionSetup", () => {
  it("GETs /api/brands/:id/conversion-setup and parses the state", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(conversionSetupFixture));
    expect(await api.conversionSetup("brand-a")).toEqual(conversionSetupFixture.conversion_setup);
    expect(fetch).toHaveBeenCalledWith("/api/brands/brand-a/conversion-setup", expect.objectContaining({ method: "GET" }));
  });
});
