import { describe, expect, it } from "vitest";
import entry from "../src/entry.js";
import { setup } from "./helpers.js";

function fixture() {
  const { core: _core, assets, ...settings } = setup().config;
  const core = { fetch: async () => Response.json({ error: "not used" }, { status: 503 }) };
  return { ASSETS: assets, CORE: core, CORE_TOKEN: "t", BRAND_CONFIG: settings };
}

// Live settings calls (/rpc/brandSettings) fail so the static config applies; only analytics forwards are recorded.
const forwardTo = (forwarded: Request[]) => async (request: Request) => {
  if (new URL(request.url).pathname.startsWith("/rpc/")) return new Response("{}", { status: 503 });
  forwarded.push(request);
  return new Response(null, { status: 204 });
};

describe("factory entry", () => {
  it("accepts BRAND_CONFIG as the object a json binding provides", async () => {
    const res = await entry.fetch(new Request("https://brand-a.example/unknown"), fixture());
    expect(res.status).toBe(404);
  });

  it("forwards analytics to core at the contract path with no CORE_ANALYTICS_PATHS binding", async () => {
    const forwarded: Request[] = [];
    const env = { ...fixture(), CORE: { fetch: forwardTo(forwarded) } };
    for (const [path, kind] of [["/api/telemetry", "telemetry"], ["/api/errors", "errors"], ["/_t/e/", "posthog"], ["/_e", "sentry"]] as const) {
      const res = await entry.fetch(new Request(`https://brand-a.example${path}`, { method: "POST", body: "{}" }), env);
      expect([res.status, await res.text()]).toEqual(kind === "posthog" ? [200, '{"status":1}'] : [204, ""]);
      const request = forwarded.at(-1)!;
      expect([request.method, request.url, request.headers.get("authorization")]).toEqual(["POST", `https://core.aduplift.ai/analytics/${kind}`, "Bearer t"]);
      expect(await request.json()).toMatchObject({ brand_id: "brand-a", hostname: "brand-a.example", kind });
    }
    expect(forwarded).toHaveLength(4);
  });

  it("lets CORE_ANALYTICS_PATHS override the contract paths", async () => {
    const forwarded: Request[] = [];
    const env = { ...fixture(), CORE_ANALYTICS_PATHS: JSON.stringify({ telemetry: "/custom/telemetry" }),
      CORE: { fetch: forwardTo(forwarded) } };
    await entry.fetch(new Request("https://brand-a.example/api/telemetry", { method: "POST", body: "{}" }), env);
    await entry.fetch(new Request("https://brand-a.example/api/errors", { method: "POST", body: "{}" }), env);
    expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual(["/custom/telemetry", "/analytics/errors"]);
  });

  it("answers 503 when core fails an analytics forward", async () => {
    const res = await entry.fetch(new Request("https://brand-a.example/api/telemetry", { method: "POST", body: "{}" }), fixture());
    expect([res.status, await res.json()]).toEqual([503, { error: "unavailable" }]);
  });

  it("still accepts BRAND_CONFIG as a JSON string", async () => {
    const env = fixture();
    const res = await entry.fetch(new Request("https://brand-a.example/unknown"), {
      ...env, BRAND_CONFIG: JSON.stringify(env.BRAND_CONFIG),
    });
    expect(res.status).toBe(404);
  });
});
