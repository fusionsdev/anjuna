import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_FORWARD_PATHS, ANALYTICS_KINDS, ANALYTICS_LIMITS, RpcError,
  type AnalyticsForwardRequest, type AnalyticsKind,
} from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, fixtureText, type Harness } from "./helpers.js";

const REAL_KEY = "phc_real_project_key_for_tests";
const REAL_DSN = "https://realpublickey@o4242.ingest.example/4242";
const PLACEHOLDER_DSN = "https://public@placeholder.invalid/0";
const LEAKS = /anjuna|aurum|phc_real|realpublickey|ingest\.example|o4242/i;

interface Upstream { url: string; method: string; headers: Record<string, string>; body: string }
const upstream: Upstream[] = [];
let upstreamStatus = 200;
let upstreamDown = false;

let open: Harness;
let configured: Harness;
beforeAll(async () => {
  // `open` is how production runs today: no PostHog key and no Sentry DSN. Any outbound request throws.
  open = await createHarness();
  configured = await createHarness({
    bindings: { POSTHOG_KEY: REAL_KEY, SENTRY_DSN: REAL_DSN },
    outbound: async (request) => {
      upstream.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
      if (upstreamDown) throw new Error("network down");
      return new Response("upstream-private-body", { status: upstreamStatus });
    },
  });
});
afterAll(async () => { await Promise.all([open?.mf.dispose(), configured?.mf.dispose()]); });
beforeEach(async () => {
  upstream.length = 0;
  upstreamStatus = 200;
  upstreamDown = false;
  for (const h of [open, configured]) {
    await h.reset();
    await h.seedAccount();
    await h.seedBrand();
    await h.seedBrand("brand-b", "U", "account-b");
  }
});

const golden = (kind: AnalyticsKind) => JSON.parse(fixtureText(`analytics/forward.${kind}.request.json`)) as AnalyticsForwardRequest;
const events = { event_type: "form_step_viewed", session_id: "session-1" };

function forward(h: Harness, kind: AnalyticsKind, overrides: Partial<AnalyticsForwardRequest> = {}, headers: Record<string, string> = {}) {
  return h.request(ANALYTICS_FORWARD_PATHS[kind], { method: "POST",
    headers: { authorization: "Bearer account-a-token", "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...golden(kind), ...overrides }) });
}
const json = (value: unknown) => JSON.stringify(value);

async function expectClean(response: Response) {
  expect(await response.clone().text()).not.toMatch(LEAKS);
  expect([...response.headers.values()].join("\n")).not.toMatch(LEAKS);
}
async function expectError(response: Response, status: number, error: RpcError["error"] | null) {
  expect(response.status).toBe(status);
  if (error) expect(RpcError.parse(await response.clone().json())).toEqual({ error });
  await expectClean(response);
}

describe.each(ANALYTICS_KINDS)("%s endpoint access", (kind) => {
  it("requires an account credential", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${DRAIN_TOKEN}`]) {
      const response = await forward(configured, kind, {}, authorization ? { authorization } : { authorization: "" });
      expect(response.status).toBe(401);
      await expectClean(response);
    }
    expect(upstream).toHaveLength(0);
    expect((await configured.db.prepare("SELECT COUNT(*) AS n FROM traffic_events").first<{ n: number }>())!.n).toBe(0);
    expect((await configured.db.prepare("SELECT COUNT(*) AS n FROM client_errors").first<{ n: number }>())!.n).toBe(0);
  });
  it("rejects a brand of another account and a hostname the brand does not own", async () => {
    await expectError(await forward(configured, kind, { brand_id: "brand-b", hostname: "brand-b.example" }), 403, "forbidden_brand");
    await expectError(await forward(configured, kind, { hostname: "brand-b.example" }), 403, "forbidden_brand");
    await expectError(await forward(configured, kind, { brand_id: "unknown" }), 403, "forbidden_brand");
    expect(upstream).toHaveLength(0);
  });
  it("rejects a malformed or mismatched envelope", async () => {
    const other = ANALYTICS_KINDS.find((item) => item !== kind)!;
    await expectError(await forward(configured, kind, { kind: other }), 400, "invalid");
    await expectError(await forward(configured, kind, { path: "/../x" }), 400, "invalid");
    await expectError(await forward(configured, kind, { content_type: undefined }), 400, "invalid");
    await expectError(await forward(configured, kind, { extra: "field" } as never), 400, "invalid");
    const raw = await configured.request(ANALYTICS_FORWARD_PATHS[kind], { method: "POST",
      headers: { authorization: "Bearer account-a-token" }, body: "not json" });
    await expectError(raw, 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("answers 413 for a body over its limit and for an envelope over the read cap", async () => {
    await expectError(await forward(configured, kind, { body: "a".repeat(ANALYTICS_LIMITS[kind] + 1) }), 413, "invalid");
    const huge = await configured.request(ANALYTICS_FORWARD_PATHS[kind], { method: "POST",
      headers: { authorization: "Bearer account-a-token" }, body: json({ ...golden(kind), body: "\u0001".repeat(ANALYTICS_LIMITS[kind] + 1000) }) });
    await expectError(huge, 413, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("serves POST only", async () => {
    const response = await configured.request(ANALYTICS_FORWARD_PATHS[kind], { headers: { authorization: "Bearer account-a-token" } });
    expect(response.status).toBe(404);
    await expectClean(response);
  });
});

describe("telemetry", () => {
  const row = () => configured.db.prepare("SELECT * FROM traffic_events").all<Record<string, unknown>>();
  it("stores an allowlisted event with the authenticated hostname and answers an empty 204", async () => {
    const response = await forward(configured, "telemetry");
    expect([response.status, await response.text()]).toEqual([204, ""]);
    const { results } = await row();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      event_type: "form_step_viewed", session_id: "5b0b4a7e-6a6e-4a63-9f1c-0d2f6d7c1a11", hostname: "brand-a.example",
      brand: "Brand A", form_version: "2026-01", form_variant: "lite_v1", build_id: "unknown", form_step: 2,
      device_class: "mobile", browser_family: "chrome", touch_capable: 1, click_session_id: null, clock_skew: 0,
      occurred_at: "2026-10-13T00:00:00.000Z",
    });
    expect(results[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(upstream).toHaveLength(0);
  });
  it("never trusts a client hostname, and nulls codes and enums outside the V1 sets", async () => {
    const body = json({ ...events, hostname: "other.example", error_code: "free text with PII", device_class: "fridge", browser_family: "lynx", form_step: 99 });
    expect((await forward(configured, "telemetry", { body })).status).toBe(204);
    expect((await row()).results[0]).toMatchObject({ hostname: "brand-a.example", error_code: null, device_class: null, browser_family: null, form_step: null });
  });
  it("accepts and drops events outside the allowlist and unparseable bodies", async () => {
    for (const body of [json({ ...events, event_type: "gate_interest" }), json({ event_type: "form_started" }), "not json", "[]", json({ ...events, session_id: " " })]) {
      expect((await forward(configured, "telemetry", { body })).status).toBe(204);
    }
    expect((await row()).results).toHaveLength(0);
  });
  it("substitutes server time and flags a client clock outside the V1 window", async () => {
    for (const occurred_at of ["2001-01-01T00:00:00.000Z", "garbage"]) {
      await forward(configured, "telemetry", { body: json({ ...events, occurred_at }) });
    }
    const { results } = await row();
    expect(results.map((item) => item.clock_skew)).toEqual([1, 1]);
    expect(results.every((item) => item.occurred_at === item.created_at)).toBe(true);
  });
  it("needs no PostHog or Sentry configuration", async () => {
    expect((await forward(open, "telemetry")).status).toBe(204);
    expect((await open.db.prepare("SELECT COUNT(*) AS n FROM traffic_events").first<{ n: number }>())!.n).toBe(1);
  });
  it("fails open when storage is unavailable, as V1 does", async () => {
    await configured.db.prepare("ALTER TABLE traffic_events RENAME TO traffic_events_away").run();
    try {
      const response = await forward(configured, "telemetry");
      expect([response.status, await response.text()]).toEqual([204, ""]);
    } finally { await configured.db.prepare("ALTER TABLE traffic_events_away RENAME TO traffic_events").run(); }
  });
});

describe("errors", () => {
  const rows = () => configured.db.prepare("SELECT * FROM client_errors").all<Record<string, unknown>>();
  it("stores the V1 columns, strips control characters and caps the message at 200", async () => {
    const response = await forward(configured, "errors", { body: json({
      error_type: "timeout", error_message: `a\u0000b${"x".repeat(300)}`, session_id: "session-1", screen_id: "step-14", occurred_at: "2026-10-13T00:00:00.000Z",
    }) });
    expect([response.status, await response.text()]).toEqual([204, ""]);
    const { results } = await rows();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ error_type: "timeout", session_id: "session-1", screen_id: "step-14", occurred_at: "2026-10-13T00:00:00.000Z" });
    expect(String(results[0]!.error_message)).toBe(`ab${"x".repeat(198)}`);
  });
  it("stores the golden", async () => {
    expect((await forward(configured, "errors")).status).toBe(204);
    expect((await rows()).results[0]).toMatchObject({ error_type: "timeout", error_message: "request timed out" });
  });
  it("drops a payload without an error type", async () => {
    for (const body of ["not json", json({ error_message: "x" })]) expect((await forward(configured, "errors", { body })).status).toBe(204);
    expect((await rows()).results).toHaveLength(0);
  });
  it("needs no PostHog or Sentry configuration", async () => {
    expect((await forward(open, "errors")).status).toBe(204);
    expect((await open.db.prepare("SELECT COUNT(*) AS n FROM client_errors").first<{ n: number }>())!.n).toBe(1);
  });
  it("answers 503 and leaks nothing when storage is unavailable", async () => {
    await configured.db.prepare("ALTER TABLE client_errors RENAME TO client_errors_away").run();
    try { await expectError(await forward(configured, "errors"), 503, "internal"); }
    finally { await configured.db.prepare("ALTER TABLE client_errors_away RENAME TO client_errors").run(); }
  });
});

describe("posthog proxy", () => {
  it("swaps the placeholder for the real key everywhere PostHog reads it and drops the visitor's headers", async () => {
    const response = await forward(configured, "posthog", {}, { cookie: "sensitive=value", "user-agent": "Visitor/1.0", "x-forwarded-for": "198.51.100.9" });
    expect([response.status, await response.text()]).toEqual([204, ""]);
    expect(upstream).toHaveLength(1);
    const call = upstream[0]!;
    expect([call.method, call.url]).toEqual(["POST", "https://us.i.posthog.com/e/"]);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers["x-forwarded-for"]).toBeUndefined();
    expect(JSON.parse(call.body)).toEqual({ api_key: REAL_KEY, event: "form_started", properties: { token: REAL_KEY, distinct_id: "anon-1" } });
    expect(call.body).not.toContain("placeholder");
  });
  it("swaps the key in batches and in flag requests", async () => {
    const batch = json({ api_key: "placeholder", batch: [{ event: "a", properties: { token: "placeholder", $set: { token: "user-data" } } }, { event: "b", properties: { token: "placeholder" } }] });
    expect((await forward(configured, "posthog", { path: "/batch/", body: batch })).status).toBe(204);
    expect((await forward(configured, "posthog", { path: "/flags/", body: json({ token: "placeholder", distinct_id: "anon-1" }) })).status).toBe(204);
    expect(upstream.map((call) => new URL(call.url).pathname)).toEqual(["/batch/", "/flags/"]);
    expect(JSON.parse(upstream[0]!.body)).toEqual({ api_key: REAL_KEY, batch: [
      { event: "a", properties: { token: REAL_KEY, $set: { token: "user-data" } } }, { event: "b", properties: { token: REAL_KEY } }] });
    expect(JSON.parse(upstream[1]!.body)).toEqual({ api_key: REAL_KEY, token: REAL_KEY, distinct_id: "anon-1" });
  });
  it.each(["/", "/static/array.js", "/admin/", "/e/../x", "/s/", "/e/extra/"])("forwards only ingest endpoints, not %s", async (path) => {
    const response = await forward(configured, "posthog", { path });
    // "/e/../x" fails the contract itself, every other path fails the endpoint allowlist.
    await expectError(response, 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("rejects a body that is not a JSON object or array of objects", async () => {
    for (const body of ["not json", "42", "null", "[1]", "data=abc"]) await expectError(await forward(configured, "posthog", { body }), 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("answers 502 without reflecting anything when PostHog fails or is unreachable", async () => {
    upstreamStatus = 500;
    await expectError(await forward(configured, "posthog"), 502, "internal");
    upstreamStatus = 401;
    await expectError(await forward(configured, "posthog"), 502, "internal");
    upstreamDown = true;
    await expectError(await forward(configured, "posthog"), 502, "internal");
  });
  it("uses POSTHOG_HOST when it is an https origin, and treats any other value as not configured", async () => {
    const stub = async (request: Request) => { upstream.push({ url: request.url, method: request.method, headers: {}, body: await request.text() }); return new Response(null, { status: 200 }); };
    for (const [host, expected] of [["https://eu.i.posthog.com", "https://eu.i.posthog.com/e/"], ["http://eu.i.posthog.com", null], ["https://user@eu.i.posthog.com", null], ["not a url", null]] as const) {
      const custom = await createHarness({ bindings: { POSTHOG_KEY: REAL_KEY, POSTHOG_HOST: host }, outbound: stub });
      try {
        await custom.seedAccount();
        await custom.seedBrand();
        expect((await forward(custom, "posthog")).status).toBe(204);
      } finally { await custom.mf.dispose(); }
      expect(upstream.map((call) => call.url)).toEqual(expected ? [expected] : []);
      upstream.length = 0;
    }
  });
  it("accepts and drops the event when no key is configured", async () => {
    const response = await forward(open, "posthog");
    expect([response.status, await response.text()]).toEqual([204, ""]);
    await expectError(await forward(open, "posthog", { body: "not json" }), 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
});

describe("sentry tunnel", () => {
  it("replaces only the DSN in the envelope header and keeps every later byte", async () => {
    const response = await forward(configured, "sentry");
    expect([response.status, await response.text()]).toEqual([204, ""]);
    expect(upstream).toHaveLength(1);
    const call = upstream[0]!;
    expect([call.method, call.url]).toEqual(["POST", "https://o4242.ingest.example/api/4242/envelope/"]);
    expect(call.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(call.headers.cookie).toBeUndefined();
    const [header, ...items] = call.body.split("\n");
    expect(JSON.parse(header!)).toEqual({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc", dsn: REAL_DSN, sent_at: "2026-10-13T00:00:00.000Z" });
    expect(items).toEqual(golden("sentry").body.split("\n").slice(1));
    expect(call.body).not.toContain(PLACEHOLDER_DSN);
  });
  it("sets the DSN when the envelope header has none, and keeps a header-only envelope valid", async () => {
    await forward(configured, "sentry", { body: json({ event_id: "e1" }) });
    expect(JSON.parse(upstream[0]!.body)).toEqual({ event_id: "e1", dsn: REAL_DSN });
  });
  it("supports a DSN with a path prefix", async () => {
    const prefixed = await createHarness({
      bindings: { SENTRY_DSN: "https://key@errors.example/relay/77" },
      outbound: async (request) => { upstream.push({ url: request.url, method: request.method, headers: {}, body: await request.text() }); return new Response(null, { status: 200 }); },
    });
    try {
      await prefixed.seedAccount();
      await prefixed.seedBrand();
      expect((await forward(prefixed, "sentry")).status).toBe(204);
      expect(upstream[0]!.url).toBe("https://errors.example/relay/api/77/envelope/");
    } finally { await prefixed.mf.dispose(); }
  });
  it.each(["/x", "/i/"])("accepts only the tunnel root, not %s", async (path) => {
    await expectError(await forward(configured, "sentry", { path }), 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("rejects an envelope whose header is not a JSON object", async () => {
    for (const body of ["not json\n{}", "[]\n{}", "", "\n{}"]) await expectError(await forward(configured, "sentry", { body }), 400, "invalid");
    expect(upstream).toHaveLength(0);
  });
  it("answers 502 without reflecting anything when Sentry fails or is unreachable", async () => {
    upstreamStatus = 429;
    await expectError(await forward(configured, "sentry"), 502, "internal");
    upstreamDown = true;
    await expectError(await forward(configured, "sentry"), 502, "internal");
  });
  it("accepts and drops the envelope when no DSN is configured or the configured DSN is unusable", async () => {
    const response = await forward(open, "sentry");
    expect([response.status, await response.text()]).toEqual([204, ""]);
    await expectError(await forward(open, "sentry", { body: "not json\n{}" }), 400, "invalid");
    const broken = await createHarness({ bindings: { SENTRY_DSN: "http://not-https@host.example/1" } });
    try {
      await broken.seedAccount();
      await broken.seedBrand();
      expect((await forward(broken, "sentry")).status).toBe(204);
    } finally { await broken.mf.dispose(); }
    expect(upstream).toHaveLength(0);
  });
});
