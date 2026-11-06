import { AdminError, PanelSpendReportResponse } from "@anjuna/contracts";
import spendFixture from "@anjuna/contracts/fixtures/admin/spend.response.json";
import { env } from "cloudflare:workers";
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
  await env.FACTORY.prepare("DELETE FROM panel_settings").run();
  owner = await sessions.owner();
  employee = await sessions.employee();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/spend (owner only)", () => {
  it("returns the core spend report to the owner with USD at the default rate of 35", async () => {
    const response = await call("/api/spend?period=7d", { cookie: owner });
    expect(response.status).toBe(200);
    const body = PanelSpendReportResponse.parse(await response.json());
    expect(body).toMatchObject({ period: "7d", from: spendFixture.from, to: spendFixture.to, totals: spendFixture.totals });
    expect(body.brands.map((b) => [b.brand_id, b.currency, b.cost, b.cost_usd])).toEqual([
      ["brand-a", "THB", 10500, 300],
      ["brand-b", "THB", 1948, 55.66],
    ]);
    expect(body.total_cost_usd).toBe(355.66);
    expect(body.fx).toEqual({ thbPerUsd: 35 });
  });

  it("converts with the stored fx_thb_per_usd rate", async () => {
    expect((await call("/api/settings/fx", { cookie: owner, method: "PUT", body: { thbPerUsd: 32 } })).status).toBe(200);
    const body = PanelSpendReportResponse.parse(await (await call("/api/spend?period=7d", { cookie: owner })).json());
    expect(body.fx).toEqual({ thbPerUsd: 32 });
    expect(body.total_cost_usd).toBe(389);
  });

  it("returns 403 forbidden_role to an employee without calling core, and no USD figure in the JSON", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const response = await call("/api/spend?period=7d", {
      cookie: employee,
      env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }),
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(AdminError.parse(JSON.parse(text))).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    for (const key of ["cost_usd", "total_cost_usd", "profit", "cost", "fx"]) expect(text).not.toContain(`"${key}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes a core error through without USD fields", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "core_unavailable" }, { status: 502 }));
    const response = await call("/api/spend?period=7d", { cookie: owner, env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("cost_usd");
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

describe("/api/settings/fx (owner only)", () => {
  it("reads 35 THB per USD when nothing is stored", async () => {
    const response = await call("/api/settings/fx", { cookie: owner });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thbPerUsd: 35, updated_at: null });
  });

  it("stores the owner's rate with who set it and when", async () => {
    const response = await call("/api/settings/fx", { cookie: owner, method: "PUT", body: { thbPerUsd: 36.5 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ thbPerUsd: 36.5 });
    expect(await (await call("/api/settings/fx", { cookie: owner })).json()).toMatchObject({ thbPerUsd: 36.5 });
    const row = await env.FACTORY.prepare("SELECT value_json, updated_by FROM panel_settings WHERE key = 'fx_thb_per_usd'").first<{ value_json: string; updated_by: string }>();
    expect(row?.value_json).toBe("36.5");
    expect(row?.updated_by).toMatch(/.+/);
  });

  it.each([[0], [-1], ["35"], [null], [1001]])("rejects rate %j with 422 and keeps the old one", async (rate) => {
    const response = await call("/api/settings/fx", { cookie: owner, method: "PUT", body: { thbPerUsd: rate } });
    expect(response.status).toBe(422);
    expect(await (await call("/api/settings/fx", { cookie: owner })).json()).toMatchObject({ thbPerUsd: 35 });
  });

  it("returns 403 to an employee for read and write", async () => {
    expect((await call("/api/settings/fx", { cookie: employee })).status).toBe(403);
    expect((await call("/api/settings/fx", { cookie: employee, method: "PUT", body: { thbPerUsd: 1 } })).status).toBe(403);
    expect(await (await call("/api/settings/fx", { cookie: owner })).json()).toMatchObject({ thbPerUsd: 35 });
  });
});

describe("api.spend", () => {
  it("GETs /api/spend with the period", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(spendFixture));
    expect(await api.spend("30d")).toEqual(spendFixture);
    expect(fetch).toHaveBeenCalledWith("/api/spend?period=30d", expect.objectContaining({ method: "GET" }));
  });
});
