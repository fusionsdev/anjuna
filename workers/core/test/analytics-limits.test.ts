import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANALYTICS_FORWARD_PATHS, ANALYTICS_KINDS, RpcError, type AnalyticsForwardRequest, type AnalyticsKind } from "@anjuna/contracts";
import { ANALYTICS_RATE_LIMITS } from "../src/analytics.js";
import { createHarness, fixtureText, ROOT, type Harness } from "./helpers.js";

const REAL_KEY = "phc_real_project_key_for_tests";
const REAL_DSN = "https://realpublickey@o4242.ingest.example/4242";
const LEAKS = /anjuna|aurum|phc_real|realpublickey|ingest\.example|o4242/i;
const LIMIT = 3;

const upstream: string[] = [];
const recordUpstream = async (request: Request) => { upstream.push(request.url); await request.text(); return new Response(null, { status: 200 }); };
const limiters = (extra: { fail?: boolean } = {}) => Object.fromEntries(Object.values(ANALYTICS_RATE_LIMITS).map(({ binding }) => [binding, { limit: LIMIT, ...extra }]));
const secrets = { POSTHOG_KEY: REAL_KEY, SENTRY_DSN: REAL_DSN };

let limited: Harness;
let unlimited: Harness;
beforeAll(async () => {
  limited = await createHarness({ bindings: secrets, outbound: recordUpstream, limiters: limiters() });
  // No rate limit binding at all, as in an environment whose wrangler config predates this change.
  unlimited = await createHarness({ bindings: secrets, outbound: recordUpstream });
});
afterAll(async () => { await Promise.all([limited?.mf.dispose(), unlimited?.mf.dispose()]); });
beforeEach(async () => {
  upstream.length = 0;
  for (const h of [limited, unlimited]) {
    await h.reset();
    await h.seedAccount();
    await h.seedBrand();
    await h.seedBrand("brand-b", "U", "account-b");
    await h.seedBrand("brand-c", "C", "account-a");
  }
  await limited.limiter!.fetch("https://limiter.test/", { method: "POST" });
});

const golden = (kind: AnalyticsKind) => JSON.parse(fixtureText(`analytics/forward.${kind}.request.json`)) as AnalyticsForwardRequest;
function forward(h: Harness, kind: AnalyticsKind, overrides: Partial<AnalyticsForwardRequest> = {}, headers: Record<string, string> = {}) {
  const brand = overrides.brand_id ?? "brand-a";
  return h.request(ANALYTICS_FORWARD_PATHS[kind], { method: "POST",
    headers: { authorization: "Bearer account-a-token", "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...golden(kind), hostname: `${brand}.example`, ...overrides }) });
}
const limitCalls = async () => (await limited.limiter!.fetch("https://limiter.test/")).json() as Promise<Array<{ binding: string; key: string }>>;
const sideEffects = async (h: Harness, kind: AnalyticsKind) => kind === "telemetry"
  ? (await h.db.prepare("SELECT COUNT(*) AS n FROM traffic_events").first<{ n: number }>())!.n
  : kind === "errors" ? (await h.db.prepare("SELECT COUNT(*) AS n FROM client_errors").first<{ n: number }>())!.n
  : upstream.length;

describe("analytics rate limit table", () => {
  it("covers every kind with a distinct binding and namespace", () => {
    expect(Object.keys(ANALYTICS_RATE_LIMITS)).toEqual([...ANALYTICS_KINDS]);
    const values = Object.values(ANALYTICS_RATE_LIMITS);
    expect(new Set(values.map((item) => item.binding)).size).toBe(4);
    expect(new Set(values.map((item) => item.namespace_id)).size).toBe(4);
    for (const { limit, period } of values) {
      expect(Number.isInteger(limit) && limit > 0).toBe(true);
      expect([10, 60]).toContain(period);
    }
  });
  it.each(["wrangler.jsonc", "wrangler.deploy.aduplift.jsonc", "wrangler.deploy.maimax.jsonc"])("%s declares exactly this table as ratelimits", (file) => {
    // wrangler.jsonc has full-line comments only.
    const config = JSON.parse(readFileSync(join(ROOT, "workers/core", file), "utf8").replace(/^\s*\/\/.*$/gm, "")) as { ratelimits?: unknown };
    expect(config.ratelimits).toEqual(Object.values(ANALYTICS_RATE_LIMITS).map(({ binding, namespace_id, limit, period }) => ({
      name: binding, namespace_id, simple: { limit, period },
    })));
  });
});

describe.each(ANALYTICS_KINDS)("%s rate limit", (kind) => {
  it("answers 429 over the limit with no database write and no outbound request", async () => {
    for (let i = 0; i < LIMIT; i++) expect((await forward(limited, kind)).status).toBe(204);
    expect(await sideEffects(limited, kind)).toBe(LIMIT);
    for (let i = 0; i < 3; i++) {
      const response = await forward(limited, kind);
      expect([response.status, RpcError.parse(await response.clone().json())]).toEqual([429, { error: "rate_limited" }]);
      expect(await response.text()).not.toMatch(LEAKS);
      expect([...response.headers.values()].join("\n")).not.toMatch(LEAKS);
    }
    expect(await sideEffects(limited, kind)).toBe(LIMIT);
  });
  it("counts per brand and kind through the kind's own binding", async () => {
    await forward(limited, kind);
    expect(await limitCalls()).toEqual([{ binding: ANALYTICS_RATE_LIMITS[kind].binding, key: `${kind}:brand-a` }]);
  });
  it("throttles one brand without touching another brand or another kind", async () => {
    const other = ANALYTICS_KINDS.find((item) => item !== kind)!;
    for (let i = 0; i < LIMIT + 1; i++) await forward(limited, kind);
    expect((await forward(limited, kind)).status).toBe(429);
    expect((await forward(limited, kind, { brand_id: "brand-c" })).status).toBe(204);
    expect((await forward(limited, other)).status).toBe(204);
  });
  it("is not enforced when the rate limit binding is absent", async () => {
    const responses = await Promise.all(Array.from({ length: 2 * LIMIT + 4 }, () => forward(unlimited, kind)));
    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 204));
  });
});

describe("check order", () => {
  it("spends no budget on requests that fail authentication, parsing or ownership", async () => {
    for (let i = 0; i < 2 * LIMIT; i++) {
      expect((await forward(limited, "errors", {}, { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await forward(limited, "errors", { content_type: undefined })).status).toBe(400);
      expect((await forward(limited, "errors", { brand_id: "brand-b" })).status).toBe(403);
      expect((await forward(limited, "errors", { hostname: "brand-b.example" })).status).toBe(403);
    }
    expect(await limitCalls()).toEqual([]);
    expect((await forward(limited, "errors")).status).toBe(204);
  });
});

describe("limiter failure", () => {
  it("lets the request through when the binding throws", async () => {
    const broken = await createHarness({ bindings: secrets, outbound: recordUpstream, limiters: limiters({ fail: true }) });
    try {
      await broken.seedAccount();
      await broken.seedBrand();
      for (let i = 0; i < LIMIT + 2; i++) expect((await forward(broken, "errors")).status).toBe(204);
    } finally { await broken.mf.dispose(); }
  });
});

describe("Workers Rate Limiting binding", () => {
  // Windows are aligned to the wall clock, so a minute rollover mid-test is retried once.
  it("limits through the real Miniflare binding", async () => {
    const real = await createHarness({
      ratelimits: { [ANALYTICS_RATE_LIMITS.errors.binding]: { namespace_id: ANALYTICS_RATE_LIMITS.errors.namespace_id, simple: { limit: 2, period: 60 } } },
    });
    try {
      await real.seedAccount();
      await real.seedBrand();
      for (let attempt = 0; attempt < 2; attempt++) {
        const window = Math.floor(Date.now() / 60_000);
        await real.db.prepare("DELETE FROM client_errors").run();
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await forward(real, "errors", {})).status);
        if (window !== Math.floor(Date.now() / 60_000)) continue;
        expect(statuses).toEqual([204, 204, 429]);
        expect((await real.db.prepare("SELECT COUNT(*) AS n FROM client_errors").first<{ n: number }>())!.n).toBe(2);
        return;
      }
      throw new Error("the rate limit window rolled over twice");
    } finally { await real.mf.dispose(); }
  });
});
