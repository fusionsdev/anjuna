import { AdminError, CAMPAIGN_JOB_ROLES } from "@anjuna/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_ROLE_TABLE } from "../src/server/panel-roles";
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

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const AT = "2026-01-02T03:04:05.000Z";

const listBody = {
  campaigns: [{
    draft_job_id: DRAFT_ID, campaign_id: "123456", brand_id: "petvet", account: "5381163935", name: "petvet-search-1",
    daily_budget: 500, currency: "THB", daily_budget_thb: 500, state: "draft", updated_at: AT,
    geo: { country: "US" }, final_url: "https://petvetpay.com/",
  }],
  brands: [{ brand_id: "petvet", currency: "THB", thb_per_unit: 1, committed_thb_day: 0 }],
  caps: { total_thb_day: 3000, brand_thb_day: 3000 },
  enabled_total_thb_day: 0,
};

const jobBody = (kind: string, payload: Record<string, unknown>) => ({
  job: {
    id: JOB_ID, kind, status: "queued", payload, result: null, attempts: 0, idempotency_key: "campaign:abcdefgh",
    requested_by: "u1", next_attempt_at: null, created_at: AT, updated_at: AT,
  },
  created: true,
});
const ref = { campaign_id: "123456", brand_id: "petvet", account: "5381163935", project: null, name: "petvet-search-1" };

/** A core stand-in that records each request and answers by path and job kind. */
function fakeCore() {
  const seen: Array<{ path: string; method: string; role: string | null; body: unknown }> = [];
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    seen.push({ path: url.pathname, method: request.method, role: request.headers.get("x-actor-role"), body });
    if (url.pathname === "/admin/adkit/campaigns") return Response.json(listBody);
    const kind = (body as { kind: string }).kind;
    if (kind === "campaign.draft.create") {
      const { kind: _k, ...rest } = body as Record<string, unknown>;
      return Response.json(jobBody(kind, { ...rest, account: "5381163935", project: null }), { status: 201 });
    }
    return Response.json(jobBody(kind, ref), { status: 201 });
  });
  return { seen, fetch, env: makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher }) };
}

const draft = {
  brand_id: "petvet", name: "petvet-search-1", daily_budget: 500, bid_strategy: "maximize_conversions",
  geo: { country: "US" }, keywords: ["pet loans"], final_url: "https://petvetpay.com/",
};

describe("panel campaign routes (T13 Part B)", () => {
  it("the panel role table matches who core lets queue each campaign job", () => {
    for (const { action, min_role } of Object.values(CAMPAIGN_JOB_ROLES)) {
      expect(PANEL_ROLE_TABLE[action as keyof typeof PANEL_ROLE_TABLE]).toBe(min_role);
    }
    expect(PANEL_ROLE_TABLE.viewCampaigns).toBe("employee");
  });

  it("GET /api/ads/campaigns forwards to core for an employee and an owner", async () => {
    const core = fakeCore();
    for (const cookie of [employee, owner]) {
      const res = await call("/api/ads/campaigns", { cookie, env: core.env });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(listBody);
    }
    expect(core.seen.map((s) => [s.path, s.role])).toEqual([["/admin/adkit/campaigns", "employee"], ["/admin/adkit/campaigns", "owner"]]);
    expect((await call("/api/ads/campaigns", { env: core.env })).status).toBe(401);
  });

  it("POST /api/ads/campaigns/draft lets an employee queue a draft and sends kind campaign.draft.create", async () => {
    const core = fakeCore();
    const res = await call("/api/ads/campaigns/draft", { cookie: employee, method: "POST", body: draft, env: core.env });
    expect(res.status).toBe(201);
    expect(core.seen).toEqual([{ path: "/admin/adkit/campaign-jobs", method: "POST", role: "employee", body: { ...draft, kind: "campaign.draft.create" } }]);
  });

  it.each([
    ["another job kind", { ...draft, kind: "campaign.enable" }],
    ["a campaign id", { ...draft, campaign_id: "123456" }],
    ["a missing budget", { ...draft, daily_budget: undefined }],
    ["an account from the browser", { ...draft, account: "111-111-1111" }],
  ])("POST /api/ads/campaigns/draft refuses %s with 422 before core", async (_label, body) => {
    const core = fakeCore();
    const res = await call("/api/ads/campaigns/draft", { cookie: owner, method: "POST", body, env: core.env });
    expect(res.status).toBe(422);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("POST /api/ads/campaigns/:id/enable is 403 for an employee on the server, before core", async () => {
    const core = fakeCore();
    const res = await call("/api/ads/campaigns/123456/enable", { cookie: employee, method: "POST", body: {}, env: core.env });
    expect(res.status).toBe(403);
    expect(AdminError.parse(await res.json())).toMatchObject({ error: "forbidden_role", required_role: "owner" });
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("POST /api/ads/campaigns/:id/enable queues campaign.enable for the owner and sends only the campaign id", async () => {
    const core = fakeCore();
    const res = await call("/api/ads/campaigns/123456/enable", { cookie: owner, method: "POST", body: { daily_budget: 1 }, env: core.env });
    expect(res.status).toBe(201);
    expect(core.seen).toEqual([{ path: "/admin/adkit/campaign-jobs", method: "POST", role: "owner", body: { kind: "campaign.enable", campaign_id: "123456" } }]);
  });

  it("POST /api/ads/campaigns/:id/pause is owner only on the server", async () => {
    const core = fakeCore();
    expect((await call("/api/ads/campaigns/123456/pause", { cookie: employee, method: "POST", body: {}, env: core.env })).status).toBe(403);
    expect(core.fetch).not.toHaveBeenCalled();
    expect((await call("/api/ads/campaigns/123456/pause", { cookie: owner, method: "POST", body: {}, env: core.env })).status).toBe(201);
    expect(core.seen.map((s) => s.body)).toEqual([{ kind: "campaign.pause", campaign_id: "123456" }]);
  });

  it("POST /api/ads/campaigns/:id/status-check is allowed for an employee", async () => {
    const core = fakeCore();
    const res = await call("/api/ads/campaigns/123456/status-check", { cookie: employee, method: "POST", body: {}, env: core.env });
    expect(res.status).toBe(201);
    expect(core.seen).toEqual([{ path: "/admin/adkit/campaign-jobs", method: "POST", role: "employee", body: { kind: "campaign.status_check", campaign_id: "123456" } }]);
  });

  it.each(["abc", "12%2034", "1".repeat(21)])("answers 404 for the campaign id %s without calling core", async (id) => {
    const core = fakeCore();
    const res = await call(`/api/ads/campaigns/${id}/enable`, { cookie: owner, method: "POST", body: {}, env: core.env });
    expect(res.status).toBe(404);
    expect(core.fetch).not.toHaveBeenCalled();
  });

  it("passes a core cap refusal through unchanged", async () => {
    const refusal = { error: "invalid", request_id: "req_test_1", issues: [{ path: "daily_budget", message: "total_cap: 3500 THB/day is above ads_cap_total_thb_day 3000 THB/day" }] };
    const fetch = vi.fn(async () => Response.json(refusal, { status: 422 }));
    const env = makeEnv({ MOCK_CORE: "0", CORE: { fetch } as unknown as Fetcher });
    const res = await call("/api/ads/campaigns/123456/enable", { cookie: owner, method: "POST", body: {}, env });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: refusal.issues });
  });
});
