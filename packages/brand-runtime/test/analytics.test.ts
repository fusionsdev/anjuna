import { describe, expect, it } from "vitest";
import { ANALYTICS_LIMITS, CoreError, HttpsCoreClient, createBrandWorker } from "../src/index.js";
import { setup } from "./helpers.js";

// posthog-js retries every response that is not 200 and not 4xx, so a 204 sends each event twice (FUS-339).
// The PostHog proxy answers the way PostHog's capture endpoint does. Everything else answers an empty 204.
const POSTHOG_OK = [200, '{"status":1}'] as const;
const EMPTY_OK = [204, ""] as const;
const answer = async (response: Response) => [response.status, await response.text()];

describe("ADR-0004 forwarding", () => {
  it.each([
    ["/_t", "posthog", "/"], ["/_t/i/v0/", "posthog", "/i/v0/"],
    ["/_e", "sentry", "/"], ["/api/telemetry", "telemetry", "/"], ["/api/errors", "errors", "/"],
  ])("forwards %s without swapping credentials or reflecting core content", async (path, kind, suffix) => {
    const { get, core } = setup();
    const body = kind === "sentry" ? '{"dsn":"https://placeholder@invalid.example/0"}\n{"type":"event"}\n{}' : '{"api_key":"placeholder","event":"form_started","disable_compression":true}';
    const response = await get(path!, { method: "POST", body, headers: { "content-type": "application/json", authorization: "client-controlled", cookie: "sensitive=value" } });
    expect(await answer(response)).toEqual(kind === "posthog" ? POSTHOG_OK : EMPTY_OK);
    expect(core.analytics).toEqual([{ kind, path: suffix, brand_id: "brand-a", hostname: "brand-a.example", content_type: "application/json", body }]);
  });
  it("answers a proxied PostHog POST with the static JSON success PostHog's capture endpoint sends", async () => {
    const { get } = setup();
    const response = await get("/_t/e/", { method: "POST", body: "{}" });
    expect(await answer(response)).toEqual(POSTHOG_OK);
    expect(Object.fromEntries(response.headers)).toEqual({ "cache-control": "no-store", "content-type": "application/json" });
  });
  it("supports configured proxy paths with exact Sentry and bounded PostHog prefixes", async () => {
    const { get } = setup({ proxies: { posthog: "/measure", sentry: "/fault" } });
    expect((await get("/measure/i/v0/", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await get("/fault", { method: "POST", body: "{}" })).status).toBe(204);
    for (const path of ["/_t", "/measures", "/fault/anything"]) expect((await get(path, { method: "POST" })).status).toBe(404);
  });
  it("permits disabling an optional proxy with an undefined setting", async () => {
    const { get } = setup({ proxies: { posthog: undefined, sentry: "/_e" } });
    expect((await get("/_t", { method: "POST" })).status).toBe(404);
    expect((await get("/_e", { method: "POST", body: "envelope" })).status).toBe(204);
  });
  it.each(["/api", "/request", "/privacy", "/assets", "/go/sub", "/"])("rejects colliding proxy path %s", (posthog) => {
    expect(() => setup({ proxies: { posthog } })).toThrow();
  });
  it("enforces actual bytes without trusting content-length", async () => {
    const { get, core } = setup();
    const response = await get("/api/telemetry", { method: "POST", body: "é".repeat(ANALYTICS_LIMITS.telemetry), headers: { "content-length": "1" } });
    expect(response.status).toBe(413);
    expect(core.analytics).toHaveLength(0);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(ANALYTICS_LIMITS.posthog));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } });
    expect((await get("/_t/i/v0/", { method: "POST", body: stream })).status).toBe(413);
    expect(core.analytics).toHaveLength(0);
  });
  it.each(["/_t", "/_e", "/api/telemetry", "/api/errors"])("drops %s with the same success answer when core rate limits it, so SDKs do not retry", async (path) => {
    const { get, core } = setup();
    core.failure = new CoreError(429);
    const response = await get(path, { method: "POST", body: "{}" });
    expect(await answer(response)).toEqual(path === "/_t" ? POSTHOG_OK : EMPTY_OK);
    expect([...response.headers.keys()].sort()).toEqual(path === "/_t" ? ["cache-control", "content-type"] : ["cache-control"]);
  });
  it("maps a 429 from the real transport the same way, and any other core status to 503", async () => {
    for (const [status, expected] of [[429, 204], [500, 503], [403, 503], [401, 503]] as const) {
      const core = new HttpsCoreClient({ credential: "test" }, async () => Response.json({ error: "rate_limited" }, { status }));
      const worker = createBrandWorker({ ...setup().config, core });
      const response = await worker.fetch(new Request("https://brand-a.example/api/telemetry", { method: "POST", body: "{}" }));
      expect(response.status).toBe(expected);
    }
  });
  it("answers a PostHog POST with a retriable 503 when core fails, and a 429 from core with the success answer", async () => {
    for (const [status, expected] of [[429, [...POSTHOG_OK]], [500, [503, '{"error":"unavailable"}']], [403, [503, '{"error":"unavailable"}']]] as const) {
      const core = new HttpsCoreClient({ credential: "test" }, async () => Response.json({ error: "x" }, { status }));
      const worker = createBrandWorker({ ...setup().config, core });
      const response = await worker.fetch(new Request("https://brand-a.example/_t/e/", { method: "POST", body: "{}" }));
      expect(await answer(response)).toEqual(expected);
    }
  });
  it("ignores a query string such as ?retry_count=1 when matching the PostHog proxy path", async () => {
    const { get, core } = setup();
    const response = await get("/_t/e/?retry_count=1&ip=0&ver=1.2&compression=gzip-js&_=1", { method: "POST", body: "{}" });
    expect(await answer(response)).toEqual(POSTHOG_OK);
    expect(core.analytics.map((forwarded) => forwarded.path)).toEqual(["/e/"]);
  });
  it("requires uncompressed payloads and masks core failure", async () => {
    const { get, core } = setup();
    expect((await get("/_t", { method: "POST", body: "compressed", headers: { "content-encoding": "gzip" } })).status).toBe(415);
    core.failure = new Error("private DSN or key");
    const response = await get("/_e", { method: "POST", body: "envelope" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
