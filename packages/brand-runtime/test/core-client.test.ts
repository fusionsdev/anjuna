import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_FORWARD_PATHS, ANALYTICS_KINDS, ANALYTICS_LIMITS, FormLeadPayload } from "@anjuna/contracts";
import { HttpsCoreClient, ServiceBindingCoreClient, CoreError, CoreUnavailable, type CoreClient } from "../src/index.js";
import leadFixture from "../../contracts/fixtures/form/lead.lite_v1.json";

const click = { brand_id: "brand-a", hostname: "brand-a.example", landing_path: "/", referrer_origin: null, params: { gclid: "test" } };
const accepted = { status: "accepted", lead_id: leadFixture.lead_id, reference: "ref", continuation: "continue_00000000000001" };

describe.each(["HTTPS", "Service Binding"])("%s core transport", (kind) => {
  function client(body: unknown, status = 200) {
    const send = vi.fn(async (_request: Request) => Response.json(body, { status }));
    const options = { credential: "test-account-credential", analyticsPaths: { posthog: "/forward/events" } };
    const core: CoreClient = kind === "HTTPS" ? new HttpsCoreClient(options, send) : new ServiceBindingCoreClient({ fetch: send }, options);
    return { core, send };
  }
  it("authenticates the contract endpoint with the account credential and server body", async () => {
    const { core, send } = client({ click_session_id: "click_00000000000000001" });
    expect(await core.recordClick(click)).toEqual({ status: 200, data: { click_session_id: "click_00000000000000001" } });
    const request = send.mock.calls[0]![0];
    expect(request.url).toBe("https://core.aduplift.ai/rpc/recordClick");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBe("Bearer test-account-credential");
    expect(await request.json()).toEqual(click);
  });
  it("uses submitLead schema and preserves HTTP status for money-path responses", async () => {
    const { core, send } = client(accepted, 201);
    const body = { brand_id: "brand-a", hostname: "brand-a.example", click_session_id: null, client: { ip: "192.0.2.1", user_agent: "test" }, lead: FormLeadPayload.parse(leadFixture) };
    expect(await core.submitLead(body)).toEqual({ status: 201, data: accepted });
    expect(new URL(send.mock.calls[0]![0].url).pathname).toBe("/rpc/submitLead");
    const invalid = client({ status: "invalid", message: "Invalid payload" }, 400);
    expect(await invalid.core.submitLead(body)).toEqual({ status: 400, data: { status: "invalid", message: "Invalid payload" } });
  });
  it("implements zip, continuation, issue and verify with the shared contracts", async () => {
    const zip = client({ found: false });
    expect((await zip.core.zip({ brand_id: "brand-a", zip: "123" })).data).toEqual({ found: false });
    expect(new URL(zip.send.mock.calls[0]![0].url).pathname).toBe("/rpc/zip");
    const continuation = client({ url: "https://provider.example/prepop" });
    await continuation.core.resolveContinuation({ brand_id: "brand-a", token: "continue_000000000001" });
    expect(new URL(continuation.send.mock.calls[0]![0].url).pathname).toBe("/rpc/resolveContinuation");
    const issue = client({ token: "handoff_000000000000001", expires_at: "2030-01-01T00:00:00Z" });
    await issue.core.issueHandoff({ brand_id: "brand-a", requested_amount: 750, zip: "60601" });
    expect(new URL(issue.send.mock.calls[0]![0].url).pathname).toBe("/rpc/issueHandoff");
    const verify = client({ valid: false, reason: "expired" });
    await verify.core.verifyHandoff({ brand_id: "brand-a", token: "handoff_000000000000001" });
    expect(new URL(verify.send.mock.calls[0]![0].url).pathname).toBe("/rpc/verifyHandoff");
  });
  it("fetches public settings and forwards authenticated consent headers without changing submit JSON", async () => {
    const settings = { flow_gate_mode: "param", paused: false, amount_buckets: [750], ab_config: null, keyword_default: null, form_route: "/request" };
    const remote = client(settings);
    expect(await remote.core.brandSettings({ brand_id: "brand-a" })).toEqual({ status: 200, data: settings });
    expect(new URL(remote.send.mock.calls[0]![0].url).pathname).toBe("/rpc/brandSettings");
    const { core, send } = client(accepted, 201);
    const body = { brand_id: "brand-a", hostname: "brand-a.example", click_session_id: null, client: { ip: "192.0.2.1", user_agent: "test" }, lead: FormLeadPayload.parse(leadFixture) };
    await core.submitLead(body, { gpc: "1", consent_brand: "Brand Å" });
    const request = send.mock.calls[0]![0];
    expect(request.headers.get("sec-gpc")).toBe("1");
    expect(decodeURIComponent(request.headers.get("x-consent-brand")!)).toBe("Brand Å");
    expect(await request.json()).toEqual(body);
    expect(await client({ found: false }, 404).core.zip({ brand_id: "brand-a", zip: "99999" })).toEqual({ status: 404, data: { found: false } });
  });
  it("validates request/response shapes and exposes no raw core errors", async () => {
    const { core, send } = client({ error: "forbidden_brand" }, 403);
    await expect(core.recordClick(click)).rejects.toMatchObject({ status: 403, message: "Core request failed" });
    await expect(core.recordClick({ ...click, hostname: "https://evil.example" })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    await expect(client({ click_session_id: "short" }).core.recordClick(click)).rejects.toBeInstanceOf(CoreError);
  });
  it("forwards capped analytics to configured core endpoints with authentication", async () => {
    const { core, send } = client({ ignored: "private-secret" });
    const body = { brand_id: "brand-a", hostname: "brand-a.example", kind: "posthog" as const, path: "/i/v0/", content_type: "application/json", body: '{"api_key":"placeholder"}' };
    expect(await core.forwardAnalytics(body)).toBeUndefined();
    const request = send.mock.calls[0]![0];
    expect(request.url).toBe("https://core.aduplift.ai/forward/events");
    expect(request.headers.get("authorization")).toBe("Bearer test-account-credential");
    expect(await request.json()).toEqual(body);
  });
});

describe.each(ANALYTICS_KINDS)("analytics forward of %s", (kind) => {
  const body = { brand_id: "brand-a", hostname: "brand-a.example", kind, path: "/", content_type: "application/json", body: "{}",
    ...(kind === "telemetry" ? { visitor: { country: "US", region: "Texas" } } : {}) };
  it.each(["HTTPS", "Service Binding"])("posts the envelope to the contract path over %s with no path option", async (transport) => {
    const send = vi.fn(async (_request: Request) => new Response(null, { status: 204 }));
    const options = { credential: "test-account-credential" };
    const core: CoreClient = transport === "HTTPS" ? new HttpsCoreClient(options, send) : new ServiceBindingCoreClient({ fetch: send }, options);
    await core.forwardAnalytics(body);
    const request = send.mock.calls[0]![0];
    expect(request.url).toBe(`https://core.aduplift.ai${ANALYTICS_FORWARD_PATHS[kind]}`);
    expect(request.headers.get("authorization")).toBe("Bearer test-account-credential");
    expect(await request.json()).toEqual(body);
  });
  it("rejects an envelope that breaks the contract before sending, and a core error status after", async () => {
    const send = vi.fn(async (_request: Request) => new Response(null, { status: 503 }));
    const core = new HttpsCoreClient({ credential: "test" }, send);
    await expect(core.forwardAnalytics({ ...body, path: "/../x" })).rejects.toThrow();
    await expect(core.forwardAnalytics({ ...body, visitor: { country: "invalid" } })).rejects.toThrow();
    await expect(core.forwardAnalytics({ ...body, body: "a".repeat(ANALYTICS_LIMITS[kind] + 1) })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(core.forwardAnalytics(body)).rejects.toMatchObject({ status: 503 });
  });
});

it("a stalled response body is also subject to the transport timeout", async () => {
  const send = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
  const core = new HttpsCoreClient({ credential: "test", timeoutMs: 10 }, send);
  await expect(core.recordClick(click)).rejects.toBeInstanceOf(CoreUnavailable);
  expect(send.mock.calls).toHaveLength(1);
});

it.each(["http://core.example", "https://user:pass@core.example", "https://core.example/path", "https://core.example?other"])("rejects unsafe core origin %s", (origin) => {
  expect(() => new HttpsCoreClient({ origin, credential: "test" })).toThrow();
});
