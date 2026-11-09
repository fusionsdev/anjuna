import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, makeEnv, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;

beforeAll(setupDatabases);
beforeEach(async () => {
  resetState();
  owner = await sessions.owner();
  employee = await sessions.employee();
});

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function mintKey(scopes: string[]): Promise<{ key_id: string; secret: string; scopes: string[] }> {
  const response = await call("/api/api-keys", { cookie: owner, method: "POST", body: { label: "Ads bot", scopes } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { key: { key_id: string; secret: string; scopes: string[] } }).key;
}

const DRAFT = {
  brand_id: "maple-v1", name: "maple-v1-search-1", daily_budget: 500, bid_strategy: "maximize_conversions",
  geo: { country: "US" }, keywords: ["quick loan"], final_url: "https://maple-v1.example/",
};
const CAMPAIGN_ID = "22334455667";

/** A core stand-in for the ads admin routes: records each request and answers contract-valid bodies. */
function adsCore() {
  const seen: Array<{ method: string; path: string; search: string; role: string | null; actor: string | null; body: unknown }> = [];
  const now = "2026-11-09T08:00:00.000Z";
  const core = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json();
      seen.push({ method: request.method, path: url.pathname, search: url.search, role: request.headers.get("x-actor-role"), actor: request.headers.get("x-actor-id"), body });
      if (url.pathname === "/admin/adkit/campaigns") {
        return Response.json({ campaigns: [], caps: { total_thb_day: 3000, brand_thb_day: 3000 }, enabled_total_thb_day: 0 });
      }
      if (url.pathname === "/admin/adkit/campaign-jobs") {
        const b = body as Record<string, unknown>;
        const kind = b.kind as string;
        const ref = { campaign_id: b.campaign_id, brand_id: "maple-v1", account: "1234567890", project: null, name: "maple-v1-search-1" };
        const payload = kind === "campaign.draft.create"
          ? { brand_id: b.brand_id, account: "1234567890", project: null, name: b.name, daily_budget: b.daily_budget, bid_strategy: b.bid_strategy, geo: b.geo, keywords: b.keywords, final_url: b.final_url }
          : kind === "campaign.update_budget"
            ? { ...ref, daily_budget: b.daily_budget }
            : ref;
        return Response.json({
          created: true,
          job: {
            id: "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f", kind, status: "queued", payload, result: null, attempts: 0,
            idempotency_key: "k".repeat(64), requested_by: request.headers.get("x-actor-id"), next_attempt_at: null, created_at: now, updated_at: now,
          },
        }, { status: 201 });
      }
      if (url.pathname === "/admin/spend/rows") {
        return Response.json({
          from: url.searchParams.get("from") ?? "2026-11-03", to: url.searchParams.get("to") ?? "2026-11-09",
          rows: [
            { brand_id: "maple-v1", currency: "THB", allocation: "exact", cost: 120.5, clicks: 30, impressions: 900, updated_at: now },
            { brand_id: "maple-v1", currency: "THB", allocation: "estimated", cost: 40, clicks: 10, impressions: 300, updated_at: now },
            { brand_id: "maple-v1", currency: "USD", allocation: "exact", cost: 3, clicks: 1, impressions: 20, updated_at: now },
          ],
        });
      }
      return Response.json({ error: "not_found", resource: "route" }, { status: 404 });
    },
  } as unknown as Fetcher;
  return { seen, env: makeEnv({ MOCK_CORE: "0", CORE: core }) };
}

describe("/api/v1/ads scopes", () => {
  it("a key without ads:draft gets 403 on POST campaigns and budget, and core is never called", async () => {
    const readOnly = await mintKey(["ads:read"]);
    const core = adsCore();
    const post = await call("/api/v1/ads/campaigns", { headers: bearer(readOnly.secret), method: "POST", body: DRAFT, env: core.env });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: "forbidden_scope", required_scope: "ads:draft" });
    expect((await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/budget`, { headers: bearer(readOnly.secret), method: "POST", body: { daily_budget: 100 }, env: core.env })).status).toBe(403);
    expect(core.seen).toHaveLength(0);
  });

  it("a key without ads:read gets 403 on GET campaigns and spend; an employee session gets 403 too", async () => {
    const draftOnly = await mintKey(["ads:draft"]);
    const core = adsCore();
    expect((await call("/api/v1/ads/campaigns", { headers: bearer(draftOnly.secret), env: core.env })).status).toBe(403);
    expect((await call("/api/v1/ads/spend", { headers: bearer(draftOnly.secret), env: core.env })).status).toBe(403);
    expect((await call("/api/v1/ads/campaigns", { cookie: employee, env: core.env })).status).toBe(403);
    expect((await call("/api/v1/ads/spend", { cookie: employee, env: core.env })).status).toBe(403);
    expect(core.seen).toHaveLength(0);
  });

  it("a key with ads:draft cannot enable: the enable route is 403 and no body can turn a draft into an enable or a publish", async () => {
    const key = await mintKey(["ads:read", "ads:draft"]);
    const core = adsCore();
    const enable = await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/enable`, { headers: bearer(key.secret), method: "POST", body: {}, env: core.env });
    expect(enable.status).toBe(403);
    expect(await enable.json()).toEqual({ error: "forbidden_scope", required_scope: "ads:enable" });
    for (const extra of [{ kind: "campaign.enable", campaign_id: CAMPAIGN_ID }, { publish: true }, { status: "ENABLED" }]) {
      const response = await call("/api/v1/ads/campaigns", { headers: bearer(key.secret), method: "POST", body: { ...DRAFT, ...extra }, env: core.env });
      expect(response.status).toBe(422);
    }
    expect(core.seen).toHaveLength(0);
  });

  it("ads:enable is held by no owner session by default and only by a key minted with it", async () => {
    const core = adsCore();
    expect((await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/enable`, { cookie: owner, method: "POST", body: {}, env: core.env })).status).toBe(403);
    expect(core.seen).toHaveLength(0);

    const key = await mintKey(["ads:enable"]);
    expect(key.scopes).toEqual(["ads:enable"]);
    const response = await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/enable`, { headers: bearer(key.secret), method: "POST", body: {}, env: core.env });
    expect(response.status).toBe(201);
    expect(core.seen).toEqual([expect.objectContaining({ path: "/admin/adkit/campaign-jobs", actor: key.key_id, body: { kind: "campaign.enable", campaign_id: CAMPAIGN_ID } })]);
    expect((await call("/api/v1/ads/campaigns/not-a-number/enable", { headers: bearer(key.secret), method: "POST", body: {}, env: core.env })).status).toBe(404);
  });
});

describe("/api/v1/ads campaigns", () => {
  it("lists campaigns with the caps for ads:read", async () => {
    const key = await mintKey(["ads:read"]);
    const core = adsCore();
    const response = await call("/api/v1/ads/campaigns", { headers: bearer(key.secret), env: core.env });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ campaigns: [], caps: { total_thb_day: 3000, brand_thb_day: 3000 }, enabled_total_thb_day: 0 });
    expect(core.seen).toEqual([expect.objectContaining({ method: "GET", path: "/admin/adkit/campaigns", actor: key.key_id })]);
  });

  it("POST with ads:draft queues a draft job only, as the key", async () => {
    const key = await mintKey(["ads:draft"]);
    const core = adsCore();
    const response = await call("/api/v1/ads/campaigns", { headers: bearer(key.secret), method: "POST", body: DRAFT, env: core.env });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { job: { kind: string; status: string } }).job).toMatchObject({ kind: "campaign.draft.create", status: "queued" });
    expect(core.seen).toEqual([expect.objectContaining({ method: "POST", path: "/admin/adkit/campaign-jobs", actor: key.key_id, body: { kind: "campaign.draft.create", ...DRAFT } })]);
    expect(JSON.stringify(core.seen[0]!.body)).not.toContain("publish");
  });

  it("validates the draft body before any job", async () => {
    const key = await mintKey(["ads:draft"]);
    const core = adsCore();
    const bad = [{ ...DRAFT, daily_budget: -1 }, { ...DRAFT, name: "Bad Name" }, { ...DRAFT, final_url: "http://insecure.example/" }, { ...DRAFT, account: "1234567890" }];
    for (const body of bad) {
      expect((await call("/api/v1/ads/campaigns", { headers: bearer(key.secret), method: "POST", body, env: core.env })).status).toBe(422);
    }
    expect(core.seen).toHaveLength(0);
  });

  it("POST budget with ads:draft queues campaign.update_budget for the path id; a bad id or budget is refused first", async () => {
    const key = await mintKey(["ads:draft"]);
    const core = adsCore();
    const response = await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/budget`, { headers: bearer(key.secret), method: "POST", body: { daily_budget: 250 }, env: core.env });
    expect(response.status).toBe(201);
    expect(core.seen).toEqual([expect.objectContaining({ path: "/admin/adkit/campaign-jobs", body: { kind: "campaign.update_budget", campaign_id: CAMPAIGN_ID, daily_budget: 250 } })]);
    expect((await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/budget`, { headers: bearer(key.secret), method: "POST", body: { daily_budget: 0 }, env: core.env })).status).toBe(422);
    expect((await call(`/api/v1/ads/campaigns/${CAMPAIGN_ID}/budget`, { headers: bearer(key.secret), method: "POST", body: { daily_budget: 5, kind: "campaign.enable" }, env: core.env })).status).toBe(422);
    expect((await call("/api/v1/ads/campaigns/abc/budget", { headers: bearer(key.secret), method: "POST", body: { daily_budget: 5 }, env: core.env })).status).toBe(404);
    expect(core.seen).toHaveLength(1);
  });
});

describe("/api/v1/ads/spend", () => {
  it("returns allocation on every row, keeps currencies apart and carries no USD or profit figure", async () => {
    const key = await mintKey(["ads:read"]);
    const core = adsCore();
    const response = await call("/api/v1/ads/spend?brand=maple-v1&from=2026-11-03&to=2026-11-09", { headers: bearer(key.secret), env: core.env });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { from: string; to: string; rows: Array<{ allocation: string; currency: string; cost: number }> };
    expect(body.rows).toHaveLength(3);
    for (const row of body.rows) expect(["exact", "estimated"]).toContain(row.allocation);
    expect(body.rows.map((r) => [r.currency, r.allocation])).toEqual([["THB", "exact"], ["THB", "estimated"], ["USD", "exact"]]);
    expect(text).not.toMatch(/cost_usd|total_cost|profit|revenue|thbPerUsd/i);
    expect(core.seen).toEqual([expect.objectContaining({ method: "GET", path: "/admin/spend/rows", search: "?brand=maple-v1&from=2026-11-03&to=2026-11-09", actor: key.key_id })]);
  });

  it("refuses a bad range or brand with 422 before core, and a key in the query with 400", async () => {
    const key = await mintKey(["ads:read"]);
    const core = adsCore();
    for (const query of ["?from=2026-11-09", "?from=2026-11-09&to=2026-11-01", "?from=2020-01-01&to=2026-11-09", "?brand=Bad%20Brand", "?currency=USD"]) {
      expect((await call(`/api/v1/ads/spend${query}`, { headers: bearer(key.secret), env: core.env })).status).toBe(422);
    }
    expect((await call(`/api/v1/ads/spend?key=${key.secret}`, { headers: bearer(key.secret), env: core.env })).status).toBe(400);
    expect(core.seen).toHaveLength(0);
  });

  it("an owner session reads spend without a key", async () => {
    const core = adsCore();
    expect((await call("/api/v1/ads/spend", { cookie: owner, env: core.env })).status).toBe(200);
  });
});
