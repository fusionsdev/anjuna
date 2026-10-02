import { describe, expect, it, vi } from "vitest";
import { BrandLeadResponse, CLICK_TRIGGER_KEYS, RuntimeConfig } from "@anjuna/contracts";
import leadFixture from "../../contracts/fixtures/form/lead.lite_v1.json";
import { CoreError, createBrandWorker } from "../src/index.js";
import { cfg, cookieHeader, cookies, HANDOFF, setup } from "./helpers.js";

describe("route allowlist", () => {
  it.each(["/admin", "/admin/brands", "/api/postback", "/api/conversions/pending", "/rpc/submitLead", "/index.html", "/_f/index.html", "/_f/", "/request/unknown", "/unknown", "/api/gate-interest", "/privacy/index.html", "/_f/assets/missing.js", "/assets/missing.js"])("uniform 404 for %s", async (path) => {
    const response = await setup().get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
  it.each(["/", "/privacy", "/privacy/", "/terms", "/disclosures", "/do-not-sell", "/_f/assets/app.js", "/assets/app.js", "/_astro/app.js", "/favicon.svg", "/api/health"])("serves allowed GET %s", async (path) => {
    expect((await setup().get(path)).status).toBe(200);
  });
  it.each([["POST", "/"], ["DELETE", "/go"], ["GET", "/api/leads"], ["GET", "/_e"], ["POST", "/_f/assets/app.js"]])("rejects %s %s uniformly", async (method, path) => {
    const response = await setup().get(path!, { method });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
  it("HEAD has GET headers/status and no body", async () => {
    const response = await setup().get("/", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("");
  });
  it("www redirects to configured HTTPS apex retaining path and query", async () => {
    const { worker } = setup();
    const response = await worker.fetch(new Request(`https://www.brand-a.example/go?${HANDOFF}&gclid=123`));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://brand-a.example/go?${HANDOFF}&gclid=123`);
    expect((await worker.fetch(new Request("https://attacker.example/"))).status).toBe(404);
  });
  it("canonical static fetches cannot depend on visitor identity or conditional cache headers", async () => {
    const { get, assets } = setup();
    const response = await get("/?keyword=quick+cash&gclid=123", { headers: { "user-agent": "AdsBot-Google", "if-none-match": "unchanged", referer: "https://search.example/private" } });
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(assets.fetch.mock.calls[0]![0].url).toBe("https://brand-a.example/index.html");
    expect([...assets.fetch.mock.calls[0]![0].headers]).toEqual([]);
  });
});

describe("param gate", () => {
  it("is the default; /go carries only validated action and ad params", async () => {
    const { get, core } = setup();
    const response = await get(`/go?${HANDOFF}&gclid=ad-id&utm_campaign=test&keyword=quick+cash&unwanted=secret`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/request?${HANDOFF}&gclid=ad-id&utm_campaign=test&keyword=quick+cash`);
    expect(core.calls.issueHandoff).toHaveLength(0);
    const config = await cfg(await get(response.headers.get("location")!));
    expect(RuntimeConfig.parse(config)).toMatchObject({ amount: 750, zip: "60601", keyword: "Quick Cash", variant: "lite_v1" });
  });
  it.each(["", "requested_amount=700&zip=60601", "requested_amount=750&zip=6060", "requested_amount=750&zip=606011", "requested_amount=750&zip=abcde", "requested_amount=7.5e2&zip=60601"])("rejects invalid action %s on entry and form", async (query) => {
    for (const path of ["/go", "/request", "/request/"]) {
      const response = await setup().get(`${path}?${query}&gclid=keep&utm_source=ads&keyword=hello`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/?gclid=keep&utm_source=ads&keyword=hello");
    }
  });
});

describe("signed cookie gate", () => {
  it("issues a 30 minute host-only cookie and verifies server amounts instead of query overrides", async () => {
    const { get, core } = setup({ flow_gate_mode: "signed_cookie" });
    const go = await get(`/go?${HANDOFF}`);
    expect(cookies(go)[0]).toMatch(/^_vh=.*; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800$/);
    const form = await get("/request?requested_amount=5000&zip=00000", { headers: { cookie: cookieHeader(go) } });
    expect(await cfg(form)).toMatchObject({ amount: 750, zip: "60601" });
    expect(core.calls.issueHandoff[0]).toEqual({ brand_id: "brand-a", requested_amount: 750, zip: "60601" });
    expect(core.calls.verifyHandoff).toHaveLength(1);
  });
  it.each(["", "_vh=bogus", "_vh=%broken"])("rejects missing/bogus/malformed cookie %s even with valid params", async (cookie) => {
    const response = await setup({ flow_gate_mode: "signed_cookie" }).get(`/request?${HANDOFF}`, { headers: { cookie } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });
  it.each(["expired", "brand_mismatch"])("rejects a %s handoff", async (reason) => {
    const { get, core } = setup({ flow_gate_mode: "signed_cookie" });
    const go = await get(`/go?${HANDOFF}`);
    const handoff = [...core.handoffs.values()][0]!;
    if (reason === "expired") handoff.expires_at = new Date(0).toISOString();
    else handoff.brand_id = "different-brand";
    expect((await get(`/request?${HANDOFF}`, { headers: { cookie: cookieHeader(go) } })).status).toBe(302);
  });
  it("core outage fails open to valid params at both hops and emits operational signals", async () => {
    const onGateFallback = vi.fn();
    const { get, core } = setup({ flow_gate_mode: "signed_cookie", onGateFallback });
    core.failure = new Error("offline");
    const go = await get(`/go?${HANDOFF}`);
    expect(go.status).toBe(302);
    expect(cookies(go)).toEqual([]);
    expect((await get(go.headers.get("location")!)).status).toBe(200);
    expect((await get("/request")).status).toBe(302);
    expect(onGateFallback.mock.calls).toEqual([["issueHandoff"], ["verifyHandoff"], ["verifyHandoff"]]);
  });
  it("timeouts also fail open without waiting indefinitely", async () => {
    const { get, core } = setup({ flow_gate_mode: "signed_cookie", coreTimeoutMs: 10, onGateFallback: vi.fn() });
    vi.spyOn(core, "verifyHandoff").mockImplementation(() => new Promise(() => {}));
    expect((await get(`/request?${HANDOFF}`)).status).toBe(200);
  });
  it.each([401, 403])("does not treat core authorization error %i as an outage", async (status) => {
    const signal = vi.fn();
    const { get, core } = setup({ flow_gate_mode: "signed_cookie", onGateFallback: signal });
    core.failure = new CoreError(status);
    expect((await get(`/go?${HANDOFF}`)).headers.get("location")).toBe("/");
    expect((await get(`/request?${HANDOFF}`)).headers.get("location")).toBe("/");
    expect(signal).not.toHaveBeenCalled();
  });
});

describe("keyword and runtime config", () => {
  it.each(["<img src=x onerror=alert(1)>", '</script><script>alert("x")</script>', '<svg/onload=alert(1)>', 'fast & EASY "cash"', "😀", "a".repeat(100), "a".repeat(59) + "𐐨", "ß".repeat(60)])("neutralizes XSS keyword %s", async (raw) => {
    const { get } = setup();
    const query = new URLSearchParams({ keyword: raw });
    const landing = await (await get(`/?${query}`)).text();
    expect(landing).not.toMatch(/<(img|svg|script)\b/i);
    expect(landing).not.toContain('value="<');
    const form = await (await get(`/request?${HANDOFF}&${query}`)).text();
    expect(form.match(/<script\b/g)).toHaveLength(1);
    const config = JSON.parse(form.match(/id="cfg">(.*?)<\/script>/s)![1]!);
    expect(RuntimeConfig.safeParse(config).success).toBe(true);
    expect(config.keyword?.length ?? 0).toBeLessThanOrEqual(60);
  });
  it("text-only title case matches cfg.keyword; absent keyword preserves template text", async () => {
    const { get } = setup();
    expect(await (await get("/?keyword=fast+%26+EASY+cash")).text()).toContain('<span data-kw>Fast &amp; Easy Cash</span>');
    expect(await cfg(await get(`/request?${HANDOFF}&keyword=fast+%26+EASY+cash`))).toMatchObject({ keyword: "Fast & Easy Cash" });
    expect(await (await get("/")).text()).toContain("Default Heading");
    expect(await cfg(await get(`/request?${HANDOFF}`))).toMatchObject({ keyword: null });
  });
  it("escapes less-than in config and quotes in CTA inputs", async () => {
    const { get } = setup({ brand: "Safe </script><script>" });
    const form = await (await get(`/request?${HANDOFF}`)).text();
    expect(form).toContain('Safe \\u003c/script>\\u003cscript>');
    expect(form.match(/<script\b/g)).toHaveLength(1);
    const landing = await (await get('/?utm_term=%22%3E%3Cimg%20src=x%3E&gclid=keep')).text();
    expect(landing).toContain('name="utm_term" value="&#34;&#62;&#60;img src=x&#62;"');
    expect(landing).toContain('name="gclid" value="keep"');
  });
  it.each(["AnJuNa", "AURUM"])("does not reflect forbidden platform text %s", async (value) => {
    const { get } = setup({ keyword_default: value });
    for (const path of ["/", `/request?${HANDOFF}`, `/?keyword=${value}&utm_campaign=${value}`, `/request?${HANDOFF}&keyword=${value}`]) {
      expect(await (await get(path)).text()).not.toMatch(/anjuna|aurum/i);
    }
  });
});

describe("click capture", () => {
  it.each(CLICK_TRIGGER_KEYS)("captures V1 trigger %s using server identity and origin-only referrer", async (trigger) => {
    const { get, core } = setup();
    const response = await get(`/?${trigger}=click&keyword=quick+CASH`, { headers: { referer: "https://search.example/private?email=secret" } });
    expect(core.calls.recordClick[0]).toMatchObject({
      brand_id: "brand-a", hostname: "brand-a.example", landing_path: "/", referrer_origin: "https://search.example",
      params: { [trigger]: "click", keyword: "Quick Cash" },
    });
    expect(cookies(response)[0]).toMatch(/^_vc=click_.*HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    expect(cookies(response).join()).not.toMatch(/domain=/i);
  });
  it("untagged visits leave core untouched, even with an existing cookie", async () => {
    const { get, core } = setup();
    await get("/?utm_campaign=organic", { headers: { cookie: "_vc=click_00000000000000000000" } });
    expect(core.calls.recordClick).toHaveLength(0);
  });
  it("captures /go and refreshes attribution when a new click ID arrives", async () => {
    const { get, core } = setup();
    const landing = await get("/?gclid=first");
    const go = await get(`/go?${HANDOFF}&gclid=second`, { headers: { cookie: cookieHeader(landing) } });
    expect(go.status).toBe(302);
    expect(core.calls.recordClick[1]).toMatchObject({ landing_path: "/go", params: { gclid: "second" } });
    expect(cookieHeader(go)).not.toBe(cookieHeader(landing));
  });
  it("a failed or hanging capture never fails the landing or go", async () => {
    const { get, core } = setup({ coreTimeoutMs: 10 });
    core.failure = new Error("private core error");
    expect((await get("/?gclid=test")).status).toBe(200);
    expect((await get(`/go?${HANDOFF}&gclid=test`)).status).toBe(302);
    vi.spyOn(core, "recordClick").mockImplementation(() => new Promise(() => {}));
    const response = await get("/?gclid=test");
    expect(response.status).toBe(200);
    expect(cookies(response)).toHaveLength(0);
  });
});

describe("lead submit and continuation", () => {
  const submit = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.5", "user-agent": "browser", "x-forwarded-for": "attacker-ip" } });
  it("ignores client brand/hostname and forwards unchanged V1 payload plus consent evidence", async () => {
    const { get, core } = setup();
    const response = await get("/api/leads", submit({ ...leadFixture, brand_id: "attacker", hostname: "attacker.example" }));
    expect(response.status).toBe(201);
    expect(core.calls.submitLead[0]).toMatchObject({ brand_id: "brand-a", hostname: "brand-a.example", client: { ip: "192.0.2.5", user_agent: "browser" }, lead: leadFixture });
    const body = BrandLeadResponse.parse(await response.json());
    expect(body).toMatchObject({ status: "accepted", lead_id: leadFixture.lead_id });
    expect(JSON.stringify(body)).not.toMatch(/provider\.example|brand-b|anjuna|aurum/i);
    expect("redirect_url" in body && body.redirect_url).toMatch(/^\/request\/provider\?c=/);
    if (!("redirect_url" in body)) throw new Error("Expected success");
    const hop = await get(body.redirect_url);
    expect(hop.status).toBe(302);
    expect(hop.headers.get("location")).toBe("https://provider.example/prepop?click_id=test");
    expect(hop.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("passes click cookie and assigned experiment on submit; user agent is capped", async () => {
    const { get, core } = setup({ ab_config: { experiment_id: "exp1", variants: [{ id: "a", weight: 30 }, { id: "b", weight: 70 }] } });
    const init = submit(leadFixture);
    init.headers = { "cf-connecting-ip": "192.0.2.6", "user-agent": "x".repeat(700), cookie: "_vc=click_00000000000000000001; _ab=exp1.b" };
    expect((await get("/api/leads", init)).status).toBe(201);
    expect(core.calls.submitLead[0]).toMatchObject({ click_session_id: "click_00000000000000000001", experiment_id: "exp1", variant: "b" });
    expect(core.calls.submitLead[0]!.client.user_agent).toHaveLength(512);
  });
  it.each([null, {}, [], { ...leadFixture, consent: { ...leadFixture.consent, application_consent: false } }])("rejects invalid payload locally", async (payload) => {
    const { get, core } = setup();
    const response = await get("/api/leads", submit(payload));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "invalid", message: "Invalid payload" });
    expect(core.calls.submitLead).toHaveLength(0);
  });
  it("handles invalid JSON and malformed cookie without crashing", async () => {
    const { get, core } = setup();
    expect((await get("/api/leads", { method: "POST", body: "{" })).status).toBe(400);
    expect((await get("/api/leads", { ...submit(leadFixture), headers: { cookie: "_vc=%garbage" } })).status).toBe(201);
    expect(core.calls.submitLead[0]!.click_session_id).toBeNull();
  });
  it("preserves duplicate and validation responses and masks failures", async () => {
    const { get, core } = setup();
    const spy = vi.spyOn(core, "submitLead");
    spy.mockResolvedValueOnce({ status: 200, data: { status: "duplicate", lead_id: leadFixture.lead_id, reference: "ref", continuation: "continue_0000000000000001" } });
    const duplicate = await get("/api/leads", submit(leadFixture));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: "duplicate", redirect_url: "/request/provider?c=continue_0000000000000001" });
    spy.mockResolvedValueOnce({ status: 400, data: { status: "invalid", message: "Invalid ZIP code" } });
    expect((await get("/api/leads", submit(leadFixture))).status).toBe(400);
    spy.mockRejectedValueOnce(new Error("private-token"));
    const failure = await get("/api/leads", submit(leadFixture));
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ status: "error", message: "Please try again in a moment." });
  });
  it.each(["", "bogus", "expired_0000000000000000"])("unknown/expired continuation %s redirects home", async (token) => {
    const response = await setup().get(`/request/provider?c=${token}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });
  it("rejects unsafe continuation destinations, while preserving a core neutral thank-you path", async () => {
    const { get, core } = setup();
    core.continuations.set("unsafe", "javascript:alert(1)");
    expect((await get("/request/provider?c=unsafe")).headers.get("location")).toBe("/");
    core.continuations.set("neutral", "/thanks");
    expect((await get("/request/provider?c=neutral")).headers.get("location")).toBe("https://brand-a.example/thanks");
  });
  it("zip lookup uses the RPC contract and server brand", async () => {
    const { get, core } = setup();
    expect(await (await get("/api/zip?zip=60601&brand_id=other")).json()).toEqual({ found: true, zip: "60601", city: "Chicago", state: "IL" });
    expect(core.calls.zip[0]).toEqual({ brand_id: "brand-a", zip: "60601" });
    expect(await (await get("/api/zip?zip=1")).json()).toEqual({ found: false });
    expect((await get("/api/zip?zip=nope")).status).toBe(400);
  });
});

describe("pause and visitor parity", () => {
  it("AdsBot and browsers get byte-identical landing/form HTML despite UA/IP/referrer/ASN", async () => {
    const { get } = setup({ ab_config: { experiment_id: "exp1", variants: [{ id: "a", weight: 50 }, { id: "b", weight: 50 }] } });
    for (const path of ["/?keyword=quick+cash&gclid=123", `/request?${HANDOFF}&keyword=quick+cash&gclid=123`]) {
      const browser = await get(path, { headers: { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "192.0.2.1", referer: "https://search.example", "cf-asn": "123", cookie: "_ab=exp1.b" } });
      const bot = await get(path, { headers: { "user-agent": "AdsBot-Google (+http://www.google.com/adsbot.html)", "cf-connecting-ip": "198.51.100.1", referer: "https://other.example", "cf-asn": "456", cookie: "_ab=exp1.b" } });
      expect(await browser.text()).toBe(await bot.text());
    }
  });
  it("paused landing/form/go/API share the same neutral page and only refresh public settings", async () => {
    const { get, core, assets } = setup({ paused: true });
    const bodies = [];
    for (const path of ["/", `/request?${HANDOFF}`, "/go", "/api/health"]) {
      for (const ua of ["Mozilla/5.0", "AdsBot-Google"]) {
        const response = await get(path, { headers: { "user-agent": ua } });
        expect(response.status).toBe(503);
        expect(cookies(response)).toEqual([]);
        bodies.push(await response.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("Temporarily unavailable");
    expect(bodies[0]).not.toMatch(/anjuna|aurum|Brand A/i);
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(core.calls.brandSettings).toEqual([{ brand_id: "brand-a" }]);
    expect(Object.entries(core.calls).filter(([method]) => method !== "brandSettings").flatMap(([, calls]) => calls)).toHaveLength(0);
    expect((await get("/admin")).status).toBe(404);
  });
  it("a config loader can change pause and gate settings without rebuilding the worker", async () => {
    const { config } = setup();
    const loader = vi.fn(() => config);
    const worker = createBrandWorker(loader);
    expect((await worker.fetch(new Request("https://brand-a.example/"))).status).toBe(200);
    config.paused = true;
    expect((await worker.fetch(new Request("https://brand-a.example/"))).status).toBe(503);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
