import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LeadsRpc, type FormLeadPayload, type LeadsRpcMethod, type SubmitLeadAccepted, type SubmitLeadRequest } from "@anjuna/contracts";
import { consentText } from "../src/rpc/consent.js";
import { createHarness, fixtureText, HANDOFF_KEY, hash, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness({ brand: true }); });
afterAll(async () => { await h?.mf.dispose(); });
beforeEach(async () => {
  await h.reset();
  await h.seedAccount();
  await h.seedBrand();
  await h.seedBrand("brand-b", "U", "account-b");
  await h.seedBrand("brand-c", "C", "account-a");
  await h.db.prepare(`UPDATE brand_runtime SET amount_buckets = '[750,1750]', aid = '10001',
    keyword_default = 'Fast Cash Loans', ab_config_json = ?1`)
    .bind(JSON.stringify(JSON.parse(fixtureText("rpc/brandSettings.response.json")).ab_config)).run();
  await h.db.batch([
    h.db.prepare("INSERT INTO zip_lookup VALUES ('60601','Chicago','IL')"),
    h.db.prepare("INSERT INTO zip_lookup VALUES ('75201','Dallas','TX')"),
    h.db.prepare("INSERT INTO zip_lookup VALUES ('00123','Example','TX')"),
  ]);
});

function payload(full = false): FormLeadPayload {
  const lead = JSON.parse(fixtureText(`form/lead.${full ? "full" : "lite"}_v1.json`)) as FormLeadPayload;
  lead.site.site_id = "form-default";
  lead.form_variant = full ? "full_v1" : "lite_v1";
  if (full) lead.lead.pay_date1 = new Date().toISOString().slice(0, 10);
  return lead;
}
function submit(lead = payload()): SubmitLeadRequest {
  return { brand_id: "brand-a", hostname: "brand-a.example", click_session_id: null,
    client: { ip: "203.0.113.7", user_agent: "Mozilla/5.0" }, experiment_id: "exp-2026-10", variant: lead.form_variant, lead };
}
async function rpc(method: LeadsRpcMethod, body: unknown, headers: Record<string, string> = {}) {
  return h.request(LeadsRpc[method].path, { method: "POST", headers: {
    authorization: "Bearer account-a-token", "content-type": "application/json", "x-consent-brand": "Brand%20A", "sec-gpc": "1", ...headers,
  }, body: JSON.stringify(body) });
}
async function accepted(input = submit()) {
  const response = await rpc("submitLead", input);
  const data = await response.json() as SubmitLeadAccepted;
  expect([response.status, data.status]).toEqual([201, "accepted"]);
  expect(LeadsRpc.submitLead.response.parse(data)).toEqual(data);
  return data;
}
const resolve = (token: string, brand_id = "brand-a") => rpc("resolveContinuation", { brand_id, token });

describe("RPC auth and public settings", () => {
  it.each(Object.keys(LeadsRpc) as LeadsRpcMethod[])("%s requires a credential and ownsBrand", async (method) => {
    expect((await rpc(method, { brand_id: "brand-a" }, { authorization: "Bearer wrong" })).status).toBe(401);
    const denied = await rpc(method, { brand_id: "brand-b" });
    expect([denied.status, await denied.json()]).toEqual([403, { error: "forbidden_brand" }]);
  });
  it("returns only the public brandSettings golden, reflecting database changes", async () => {
    const response = await rpc("brandSettings", { brand_id: "brand-a" });
    expect(await response.json()).toEqual(JSON.parse(fixtureText("rpc/brandSettings.response.json")));
    await h.db.prepare("UPDATE brand_runtime SET paused = 1, form_route = '/start' WHERE brand_id = 'brand-a'").run();
    expect(await (await rpc("brandSettings", { brand_id: "brand-a" })).json()).toMatchObject({ paused: true, form_route: "/start" });
  });
  it("rejects a hostname outside the owned brand", async () => {
    expect((await rpc("submitLead", { ...submit(), hostname: "brand-b.example" })).status).toBe(403);
    expect((await rpc("recordClick", { ...JSON.parse(fixtureText("rpc/recordClick.request.json")), hostname: "evil.example" })).status).toBe(403);
  });
  it("returns bounded invalid errors for malformed and oversized input", async () => {
    const malformed = await h.request("/rpc/submitLead", { method: "POST", headers: { authorization: "Bearer account-a-token" }, body: "{" });
    expect([malformed.status, await malformed.json()]).toEqual([400, { status: "invalid", message: "Invalid payload" }]);
    const input = submit(); input.lead.metadata.referrer = "x".repeat(65_000);
    expect((await rpc("submitLead", input)).status).toBe(413);
  });
});

describe("V1 lead path", () => {
  it.each([false, true])("stores validated lite/full (%s), trusted identity, evidence, attribution and outbox", async (full) => {
    const input = submit(payload(full));
    input.lead.site.brand = "Forged brand"; input.lead.site.hostname = "evil.example";
    const data = await accepted(input);
    const lead = await h.db.prepare("SELECT * FROM leads WHERE lead_id = ?1").bind(data.lead_id).first();
    expect(lead).toMatchObject({ brand: "brand-a", hostname: "brand-a.example", site_id: "form-default",
      click_id: data.lead_id.replace(/-/g, ""), experiment_id: "exp-2026-10", variant: full ? "full_v1" : "lite_v1",
      keyword: input.lead.tracking.keyword, state: full ? "TX" : "IL" });
    if (!full) expect(lead).toMatchObject({ own_home: -1, direct_deposit: -1, monthly_income: -1 });
    const evidence = await h.db.prepare("SELECT * FROM consent_evidence").first();
    expect(evidence).toMatchObject({ consent_text_hash: hash(consentText("Brand A")), consent_brand: "Brand A", gpc: 1,
      ip_hash: hash("203.0.113.7:form-default"), user_agent: "Mozilla/5.0", consent_version: "consent-2026-02", hostname: "brand-a.example" });
    expect(await h.db.prepare("SELECT lead_id, brand, status FROM mailing_outbox").first()).toEqual({ lead_id: data.lead_id, brand: "brand-a", status: "pending" });
    expect(JSON.stringify(data)).not.toMatch(/example\.com|HANDOFF|postback|prepop|ip_hash/);
  });
  it.each([
    ["first_name", "X", "Invalid name"], ["email", "bad", "Invalid email"], ["home_phone", "123", "Invalid home phone"],
    ["birth_date", "2015-01-01", "Applicant must be 18-95"], ["monthly_income", "1", "Invalid monthly income"],
    ["requested_amount", "99", "Invalid requested amount"], ["zip", "1234", "Invalid ZIP code"],
  ])("preserves V1 validation for %s", async (key, value, message) => {
    const input = submit(); (input.lead.lead as Record<string, string>)[key!] = value!;
    const result = await rpc("submitLead", input);
    expect([result.status, await result.json()]).toEqual([400, { status: "invalid", message }]);
  });
  it("rejects the legacy site id and wrong consent/version", async () => {
    for (const [mutate, message] of [
      [(p: FormLeadPayload) => { p.site.site_id = "aurum-default"; }, "Invalid site"],
      [(p: FormLeadPayload) => { p.form_version = "old"; }, "Unsupported form version"],
      [(p: FormLeadPayload) => { p.consent.consent_version = "old"; }, "Invalid consent version"],
      [(p: FormLeadPayload) => { p.consent.partner_list_version = "old"; }, "Invalid partner list version"],
    ] as const) {
      const input = submit(); mutate(input.lead);
      expect(await (await rpc("submitLead", input)).json()).toEqual({ status: "invalid", message });
    }
  });
  it("requires trusted consent display context and preserves an absent GPC signal", async () => {
    for (const value of ["", "%not-encoded", "%0Aforged"]) {
      const invalid = await rpc("submitLead", submit(), { "x-consent-brand": value });
      expect([invalid.status, await invalid.json()]).toEqual([400, { status: "invalid", message: "Invalid consent context" }]);
    }
    expect((await rpc("submitLead", submit(), { "sec-gpc": "" })).status).toBe(201);
    expect(await h.db.prepare("SELECT gpc, consent_text_hash FROM consent_evidence").first()).toEqual({ gpc: null, consent_text_hash: hash(consentText("Brand A")) });
  });
  it("a duplicate lead_id hands off the CURRENT submission, never the stored applicant", async () => {
    const first = await accepted(submit(payload(true)));
    const attacker = submit(payload(true));
    Object.assign(attacker.lead.lead, { first_name: "Mallory", last_name: "Stone", email: "mallory@example.net",
      home_phone: "3125550199", address: "9 Other Rd", city: "Chicago", zip: "60601", state: "TX" });
    const response = await rpc("submitLead", attacker);
    const dup = await response.json() as SubmitLeadAccepted;
    expect([response.status, dup.status]).toEqual([200, "duplicate"]);
    const { url } = await (await resolve(dup.continuation)).json() as { url: string };
    const p = new URL(url).searchParams;
    expect(Object.fromEntries(["first_name", "last_name", "email", "home_phone", "address", "city", "zip", "state"].map((k) => [k, p.get(k)])))
      .toEqual({ first_name: "Mallory", last_name: "Stone", email: "mallory@example.net", home_phone: "3125550199",
        address: "9 Other Rd", city: "Chicago", zip: "60601", state: "IL" });
    expect([p.get("aid"), p.get("lead_id"), p.get("click_id"), p.get("clickid")])
      .toEqual(["10001", first.lead_id, first.lead_id.replace(/-/g, ""), first.lead_id.replace(/-/g, "")]);
    const stored = await h.db.prepare("SELECT first_name, email, home_phone FROM leads").first<Record<string, string>>();
    for (const value of Object.values(stored!)) expect(url).not.toContain(encodeURIComponent(value).replace(/%20/g, "+"));
    expect(await h.db.prepare("SELECT first_name, email, state FROM leads").first())
      .toEqual({ first_name: stored!.first_name, email: stored!.email, state: "TX" });
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM continuations WHERE applicant_json IS NOT NULL").first()).toEqual({ n: 0 });
  });
  it("a duplicate is screened on the CURRENT ZIP-derived state", async () => {
    const first = await accepted(submit(payload(true)));
    await h.db.prepare("INSERT INTO zip_lookup (zip, city, state) VALUES ('10001', 'New York', 'NY')").run();
    const retry = submit(payload(true));
    retry.lead.lead.zip = "10001";
    retry.lead.lead.state = "TX";
    const dup = await (await rpc("submitLead", retry)).json() as SubmitLeadAccepted;
    expect(await (await resolve(dup.continuation)).json()).toEqual({ url: `/request/complete?ref=${first.reference}` });
    expect(await h.db.prepare("SELECT state, status FROM leads").first()).toEqual({ state: "TX", status: "accepted" });
  });
  it("a real applicant who edits a field and resubmits the same lead_id is handed off with the edit", async () => {
    await accepted(submit(payload(true)));
    const edited = submit(payload(true));
    edited.lead.lead.home_phone = "2145550188";
    const dup = await (await rpc("submitLead", edited)).json() as SubmitLeadAccepted;
    const { url } = await (await resolve(dup.continuation)).json() as { url: string };
    expect(new URL(url).searchParams.get("home_phone")).toBe("2145550188");
  });
  it.each(["NY", "AR", "VT", "WV", "PR", "AE"])("ZIP-authoritative %s is recorded but never routed; a duplicate is screened on its own ZIP", async (state) => {
    await h.db.prepare("UPDATE zip_lookup SET state = ?1 WHERE zip = '75201'").bind(state).run();
    const input = submit(payload(true)); input.lead.lead.state = "TX";
    const first = await accepted(input);
    expect(await h.db.prepare("SELECT state, status FROM leads").first()).toEqual({ state, status: "rejected" });
    expect(await (await resolve(first.continuation)).json()).toEqual({ url: `/request/complete?ref=${first.reference}` });
    const blockedRetry = await (await rpc("submitLead", input)).json() as SubmitLeadAccepted;
    expect(await (await resolve(blockedRetry.continuation)).json()).toEqual({ url: `/request/complete?ref=${first.reference}` });
    input.lead.lead.zip = "60601";
    const routedRetry = await (await rpc("submitLead", input)).json() as SubmitLeadAccepted;
    const { url } = await (await resolve(routedRetry.continuation)).json() as { url: string };
    expect(new URL(url).searchParams.get("state")).toBe("IL");
    expect(await h.db.prepare("SELECT state, status FROM leads").first()).toEqual({ state, status: "rejected" });
  });
  it("unknown lite ZIP fails closed; an unknown full ZIP falls back to submitted state", async () => {
    const lite = submit(); lite.lead.lead.zip = "99999";
    expect(await (await resolve((await accepted(lite)).continuation)).json()).toHaveProperty("url", `/request/complete?ref=${lite.lead.lead_id.slice(-8)}`);
    const full = submit(payload(true)); full.lead.lead.zip = "99999";
    expect((await (await resolve((await accepted(full)).continuation)).json() as { url: string }).url).toContain("state=TX");
  });
  it("concurrent idempotent submissions write one lead/outbox and both receive continuations", async () => {
    const input = submit();
    const responses = await Promise.all([rpc("submitLead", input), rpc("submitLead", input)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    for (const response of responses) expect((await resolve((await response.json() as SubmitLeadAccepted).continuation)).status).toBe(200);
    for (const table of ["leads", "mailing_outbox", "consent_evidence"]) expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 1 });
  });
  it("another brand cannot reuse a lead id to read its continuation", async () => {
    await accepted();
    const input = { ...submit(), brand_id: "brand-c", hostname: "brand-c.example" };
    expect((await rpc("submitLead", input)).status).toBe(400);
  });
  it("preserves pinned V1 contact behavior: a new client lead_id is a new lead", async () => {
    const first = submit();
    await accepted(first);
    const next = structuredClone(first); next.lead.lead_id = randomUUID();
    await accepted(next);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 2 });
  });
  it("the click claim is single use even under concurrent submissions and stored click fields win", async () => {
    const click = await (await rpc("recordClick", JSON.parse(fixtureText("rpc/recordClick.request.json")))).json() as { click_session_id: string };
    const one = { ...submit(), ...click };
    one.lead.tracking = { gclid: "client-click", keyword: "client keyword" };
    const two = structuredClone(one); two.lead.lead_id = randomUUID();
    const responses = await Promise.all([rpc("submitLead", one), rpc("submitLead", two)]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const rows = (await h.db.prepare("SELECT tracking_json, variant, keyword FROM leads").all<{ tracking_json: string; variant: string; keyword: string }>()).results;
    expect(rows.map((r) => JSON.parse(r.tracking_json).gclid).sort()).toEqual(["Cj0KCQjwFIXTURE-gclid-1", "client-click"]);
    expect(rows.find((r) => r.variant === "a")?.keyword).toBe("fast cash loans");
  });
  it("a click from another brand is never claimed", async () => {
    const clickInput = { ...JSON.parse(fixtureText("rpc/recordClick.request.json")), brand_id: "brand-c", hostname: "brand-c.example" };
    const click = await (await rpc("recordClick", clickInput)).json() as { click_session_id: string };
    await accepted({ ...submit(), ...click });
    expect(await h.db.prepare("SELECT lead_id FROM click_sessions").first()).toEqual({ lead_id: null });
  });
  it("failed outbox rolls back lead, consent, continuation and click claim; retry keeps the paid click", async () => {
    const click = await (await rpc("recordClick", JSON.parse(fixtureText("rpc/recordClick.request.json")))).json() as { click_session_id: string };
    await h.db.prepare("CREATE TRIGGER fail_outbox BEFORE INSERT ON mailing_outbox BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
    const input = { ...submit(), ...click };
    try {
      const failure = await rpc("submitLead", input);
      expect([failure.status, await failure.json()]).toEqual([503, { status: "error", message: "Please try again in a moment." }]);
      for (const table of ["leads", "consent_evidence", "continuations", "mailing_outbox"]) expect(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
      expect(await h.db.prepare("SELECT lead_id FROM click_sessions").first()).toEqual({ lead_id: null });
    } finally { await h.db.prepare("DROP TRIGGER fail_outbox").run(); }
    await accepted(input);
    expect(JSON.parse((await h.db.prepare("SELECT tracking_json FROM leads").first<{ tracking_json: string }>())!.tracking_json).gclid).toBe("Cj0KCQjwFIXTURE-gclid-1");
  });
});

describe("continuations, click goldens and ZIP", () => {
  it("recordClick persists the golden attribution, pathname and referrer origin only", async () => {
    const input = JSON.parse(fixtureText("rpc/recordClick.request.json"));
    input.referrer_origin += "/private?email=hidden"; input.landing_path = "/go?email=hidden";
    const response = await rpc("recordClick", input);
    expect(LeadsRpc.recordClick.response.parse(await response.json()).click_session_id).toMatch(/^[a-f0-9]{64}$/);
    expect(await h.db.prepare("SELECT gclid, utm_source, utm_campaign, keyword, landing_path, referrer_origin, brand_id, variant FROM click_sessions").first())
      .toEqual({ ...input.params, landing_path: "/go", referrer_origin: "https://www.google.com", brand_id: "brand-a", variant: "a" });
    expect((await rpc("recordClick", { ...input, params: {} })).status).toBe(400);
  });
  it("ZIP left-pads and returns contract 404 on a miss", async () => {
    expect(await (await rpc("zip", { brand_id: "brand-a", zip: "123" })).json()).toEqual({ found: true, zip: "00123", city: "Example", state: "TX" });
    const missing = await rpc("zip", { brand_id: "brand-a", zip: "99999" });
    expect([missing.status, await missing.json()]).toEqual([404, { found: false }]);
  });
  it("builds the V1 prepop golden byte for byte and supports a relative base", async () => {
    const first = await accepted(submit(payload(true)));
    const expected = JSON.parse(fixtureText("rpc/resolveContinuation.response.json"));
    expected.url = expected.url.replace("pay_date1=2026-10-09", `pay_date1=${new Date().toISOString().slice(0, 10)}`);
    expect(await (await resolve(first.continuation)).json()).toEqual(expected);
    await h.db.prepare("UPDATE brand_runtime SET prepop_base = '/apply' WHERE brand_id = 'brand-a'").run();
    const retry = await rpc("submitLead", submit(payload(true)));
    expect(await (await resolve((await retry.json() as SubmitLeadAccepted).continuation)).json()).toEqual({ url: expected.url.replace("https://prepop.example", "https://brand-a.example") });
  });
  it("tokens are random, stored hashed, expire after 30 minutes, and are brand-bound and single use", async () => {
    const first = await accepted();
    const row = await h.db.prepare("SELECT * FROM continuations").first();
    expect(row).toMatchObject({ token_hash: hash(first.continuation), lead_id: first.lead_id, brand_id: "brand-a", used_at: null });
    expect(Date.parse(row!.expires_at as string) - Date.now()).toBeGreaterThan(1_790_000);
    expect(Date.parse(row!.expires_at as string) - Date.now()).toBeLessThanOrEqual(1_800_000);
    expect(JSON.stringify(row)).not.toContain(first.continuation);
    expect((await resolve(first.continuation, "brand-c")).status).toBe(404);
    expect((await resolve("unknown")).status).toBe(404);
    const concurrent = await Promise.all([resolve(first.continuation), resolve(first.continuation)]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 404]);
    const retry = await (await rpc("submitLead", submit())).json() as SubmitLeadAccepted;
    expect(retry.continuation).not.toBe(first.continuation);
    await h.db.prepare("UPDATE continuations SET expires_at = ?1").bind(new Date(Date.now() - 1).toISOString()).run();
    expect((await resolve(retry.continuation)).status).toBe(404);
  });
});

describe("signed handoffs", () => {
  it("signs amount/ZIP/brand/nonce/kid with a core-only key and verifies for 30 minutes", async () => {
    const response = await rpc("issueHandoff", { brand_id: "brand-a", requested_amount: 750, zip: "60601" });
    const data = LeadsRpc.issueHandoff.response.parse(await response.json());
    const [body, signature] = data.token.split(".");
    const signed = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(signed).toMatchObject({ brand_id: "brand-a", amount: 750, zip_hash: hash("60601"), kid: "1" });
    expect(signature).toBe(createHmac("sha256", HANDOFF_KEY).update(body!).digest("base64url"));
    expect(Date.parse(data.expires_at) / 1000 - signed.iat).toBe(1800);
    expect(await (await rpc("verifyHandoff", { brand_id: "brand-a", token: data.token })).json())
      .toEqual({ valid: true, requested_amount: 750, zip: "60601", expires_at: data.expires_at });
    expect(await (await rpc("verifyHandoff", { brand_id: "brand-c", token: data.token })).json()).toEqual({ valid: false, reason: "brand_mismatch" });
    const changed = Buffer.from(JSON.stringify({ ...signed, amount: 1750 })).toString("base64url");
    expect(await (await rpc("verifyHandoff", { brand_id: "brand-a", token: `${changed}.${signature}` })).json()).toEqual({ valid: false, reason: "bad_signature" });
    for (const iat of [Math.floor(Date.now() / 1000) - 1800, Math.floor(Date.now() / 1000) + 60]) {
      const expired = Buffer.from(JSON.stringify({ ...signed, iat })).toString("base64url");
      const token = `${expired}.${createHmac("sha256", HANDOFF_KEY).update(expired).digest("base64url")}`;
      expect(await (await rpc("verifyHandoff", { brand_id: "brand-a", token })).json()).toEqual({ valid: false, reason: "expired" });
    }
    expect((await rpc("issueHandoff", { brand_id: "brand-a", requested_amount: 999, zip: "60601" })).status).toBe(400);
    expect(await (await rpc("verifyHandoff", { brand_id: "brand-a", token: "garbage" })).json()).toEqual({ valid: false, reason: "malformed" });
    expect(JSON.stringify(data)).not.toContain(HANDOFF_KEY);
  });
});

it("a blocked-state lead lands on a served neutral page on the brand apex", async () => {
  await h.db.prepare("UPDATE zip_lookup SET state = 'NY' WHERE zip = '60601'").run();
  const brand = await h.mf.getWorker("brand");
  const res = await brand.fetch("https://brand-a.example/api/leads", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) });
  const { redirect_url } = await res.json() as { redirect_url: string };
  expect(res.status).toBe(201);
  expect(await h.db.prepare("SELECT state, status FROM leads").first()).toEqual({ state: "NY", status: "rejected" });
  const hop = await brand.fetch(`https://brand-a.example${redirect_url}`, { redirect: "manual" });
  await hop.text();
  expect(hop.status).toBe(302);
  const location = hop.headers.get("location")!;
  expect(new URL(location).origin).toBe("https://brand-a.example");
  expect(new URL(location).pathname).toBe("/request/complete");
  const page = await brand.fetch(location);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Your request has been received.");
  expect(html).not.toMatch(/prepop|lead_id=/);
});

it("Miniflare brand → recordClick → submitLead → continuation → postback(cid) → pending closes the money path", async () => {
  const brand = await h.mf.getWorker("brand");
  const landing = await brand.fetch("https://brand-a.example/?gclid=e2e-paid-click&keyword=fast+cash+loans");
  await landing.text();
  const cookies = landing.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookies).toContain("_vc=");
  const response = await brand.fetch("https://brand-a.example/api/leads", { method: "POST",
    headers: { "content-type": "application/json", cookie: cookies, "sec-gpc": "1", "user-agent": "AdsBot-Google", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(payload()) });
  const data = await response.json() as { redirect_url: string; lead_id: string };
  expect(response.status).toBe(201);
  expect(data.redirect_url).toMatch(/^\/request\/provider\?c=/);
  const hop = await brand.fetch(`https://brand-a.example${data.redirect_url}`, { redirect: "manual" });
  await hop.text();
  expect(hop.status).toBe(302);
  expect(hop.headers.get("referrer-policy")).toBe("no-referrer");
  const prepop = new URL(hop.headers.get("location")!);
  const cid = data.lead_id.replace(/-/g, "");
  expect(prepop.searchParams.get("click_id")).toBe(cid);
  const callback = await h.request(`/api/postback?token=T&cid=${cid}&payout=42&type=soldLead&lead_id=buyer-external-id`);
  expect(callback.status).toBe(200);
  expect(await callback.json()).toMatchObject({ lead_id: data.lead_id });
  expect(await h.queue(data.lead_id)).toMatchObject({ status: "pending", value: 42, gclid: "e2e-paid-click" });
  expect(await (await h.pending()).json()).toMatchObject({ conversions: [{ lead_id: data.lead_id, gclid: "e2e-paid-click", brand: "brand-a", hostname: "brand-a.example", value: 42 }] });
  expect(await h.db.prepare("SELECT gpc, user_agent, consent_text_hash FROM consent_evidence").first()).toEqual({ gpc: 1, user_agent: "AdsBot-Google", consent_text_hash: hash(consentText("Brand A")) });
});
