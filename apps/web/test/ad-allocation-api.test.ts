import { AdAllocationResponse, AdminError } from "@anjuna/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

const NOW = "2026-11-08T12:00:00.000Z";
let owner: string;
let employee: string;

beforeAll(async () => { await setupDatabases(); });
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("/api/ad-allocation (owner only)", () => {
  it("returns the core allocation report to the owner", async () => {
    const response = await call(`/api/ad-allocation?now=${NOW}`, { cookie: owner });
    expect(response.status).toBe(200);
    const body = AdAllocationResponse.parse(await response.json());
    expect(body).toMatchObject({ mode: "estimated", from: "2026-11-02", to: "2026-11-08" });
    expect(body.campaigns.find((c) => c.campaign_id === "2222")).toMatchObject({ brand_id: null, source: null });
  });

  it("answers 403 to an employee on GET and on PATCH, and never calls core", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    const read = await call("/api/ad-allocation", { cookie: employee, env });
    expect(read.status).toBe(403);
    expect(AdminError.parse(await read.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    const write = await call("/api/ad-allocation", {
      cookie: employee, env, method: "PATCH", body: { account: "5381163935", campaign_id: "2222", brand_id: "brand-a" },
    });
    expect(write.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("assigning a campaign makes the next read show it as manual", async () => {
    const write = await call("/api/ad-allocation", {
      cookie: owner, method: "PATCH", body: { account: "5381163935", campaign_id: "2222", brand_id: "brand-b" },
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ campaign_id: "2222", brand_id: "brand-b", source: "manual" });
    const body = AdAllocationResponse.parse(await (await call(`/api/ad-allocation?now=${NOW}`, { cookie: owner })).json());
    expect(body.campaigns.find((c) => c.campaign_id === "2222")).toMatchObject({ brand_id: "brand-b", source: "manual" });
  });

  it("forwards the PATCH to core PATCH /admin/ad-allocation/campaign with the parsed body", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("PATCH");
      expect(new URL(request.url).pathname).toBe("/admin/ad-allocation/campaign");
      expect(await request.json()).toEqual({ account: "5381163935", campaign_id: "2222", brand_id: "brand-a" });
      return Response.json({ account: "5381163935", campaign_id: "2222", brand_id: "brand-a", source: "manual", updated_at: NOW });
    });
    const response = await call("/api/ad-allocation", {
      cookie: owner, method: "PATCH", env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
      body: { account: "5381163935", campaign_id: "2222", brand_id: "brand-a" },
    });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a body with a source field before core sees it", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const response = await call("/api/ad-allocation", {
      cookie: owner, method: "PATCH", env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
      body: { account: "5381163935", campaign_id: "2222", brand_id: "brand-a", source: "create" },
    });
    expect(response.status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
});
