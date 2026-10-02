import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONV_LEASE_STALE_MS, type Postback } from "@anjuna/contracts";
import { createHarness, DRAIN_TOKEN, fixtureText, hash, ROOT, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await h.reset(); });
afterAll(async () => { await h?.mf.dispose(); });

describe("skeleton and authentication", () => {
  it("pins the account/domain and placeholder bindings without workers.dev or secrets", () => {
    const text = readFileSync(join(ROOT, "workers/core/wrangler.jsonc"), "utf8");
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
    expect(config).toMatchObject({ name: "anjuna-core", account_id: "6cb8500c35210800451bd9a535482850",
      workers_dev: false, preview_urls: false, routes: [{ pattern: "core.aduplift.ai", custom_domain: true }] });
    expect(config.d1_databases.map((db: { binding: string; database_id: string }) => [db.binding, db.database_id]))
      .toEqual([["LEADS", "00000000-0000-0000-0000-000000000000"], ["FACTORY", "00000000-0000-0000-0000-000000000000"]]);
    expect(config.vars).toBeUndefined();
  });

  it("returns only the health body for every user agent", async () => {
    for (const ua of ["", "curl/8", "Googlebot", "AdsBot-Google", "Mozilla/5.0"]) {
      const response = await h.request("/api/health", { headers: { "User-Agent": ua } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
    }
  });

  it("uniformly rejects unknown routes, wrong methods and public admin requests", async () => {
    for (const [method, path] of [
      ["GET", "/"], ["GET", "/unknown"], ["GET", "/api/health/"], ["POST", "/api/health"],
      ["PUT", "/api/postback"], ["POST", "/api/conversions/pending"], ["GET", "/api/conversions/ack"],
      ["GET", "/api/conversions/unknown"], ["POST", "/rpc/test"], ["POST", "/rpc/submitLead"],
      ["POST", "/api/leads"], ["GET", "/admin/brands"], ["GET", "/admin/anything"],
    ]) {
      const response = await h.request(path!, { method });
      expect([response.status, await response.text(), response.headers.get("Content-Type")])
        .toEqual([404, "Not Found", "text/plain; charset=utf-8"]);
    }
  });

  it("keeps admin behind a named Service Binding even with forged internal host/headers", async () => {
    const testCore = await h.mf.getWorker("test-core");
    const panel = await h.mf.getWorker("panel");
    for (const host of ["core.aduplift.ai", "core.internal", "localhost", "app.aduplift.ai"]) {
      const response = await testCore.fetch(`https://${host}/admin/test`, {
        headers: { "X-Forwarded-Host": "core.internal", "X-Internal": "true", Authorization: `Bearer ${DRAIN_TOKEN}` },
      });
      expect([response.status, await response.text()]).toEqual([404, "Not Found"]);
    }
    const allowed = await panel.fetch("https://core.internal/admin/test");
    expect(await allowed.json()).toEqual({ reached: "service-binding" });
    const rejected = await panel.fetch("https://core.aduplift.ai/admin/test");
    expect(rejected.status).toBe(404);
    expect((await panel.fetch("https://core.internal/api/health")).status).toBe(404);
    // The real entrypoint is reachable only through the binding and requires admin context.
    expect((await panel.fetch("https://core.internal/admin/brands", { headers: { "x-production": "1" } })).status).toBe(401);
  });

  it.each([undefined, "Bearer wrong", "Basic account-a-token", "account-a-token", "Bearer"])(
    "rejects missing/wrong account credentials: %s", async (authorization) => {
      await h.seedAccount();
      const worker = await h.mf.getWorker("test-core");
      const response = await worker.fetch("https://core.aduplift.ai/rpc/test", {
        method: "POST", headers: authorization ? { Authorization: authorization } : {},
        body: JSON.stringify({ brand_id: "brand-a" }),
      });
      expect(response.status).toBe(401);
    },
  );

  it("identifies the account, rejects foreign brands, and revokes a rotated credential", async () => {
    await h.seedAccount();
    await h.seedAccount("account-b", "account-b-token");
    await h.seedBrand();
    await h.seedBrand("brand-b", "U", "account-b");
    const worker = await h.mf.getWorker("test-core");
    const rpc = (brand: string, token = "account-a-token") => worker.fetch("https://core.internal/rpc/test", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ brand_id: brand }),
    });
    expect(await (await rpc("brand-a")).json()).toEqual({ ok: true, account: "account-a" });
    expect((await rpc("brand-b")).status).toBe(403);
    expect((await rpc("missing-brand")).status).toBe(403);
    expect((await rpc("brand-b", "account-b-token")).status).toBe(200);
    await h.db.prepare("UPDATE account_credentials SET credential_hash = ?1, rotated_at = ?2 WHERE account = 'account-a'")
      .bind(hash("rotated-token"), new Date().toISOString()).run();
    expect((await rpc("brand-a")).status).toBe(401);
    expect((await rpc("brand-a", "rotated-token")).status).toBe(200);
    const row = await h.db.prepare("SELECT * FROM account_credentials WHERE account = 'account-a'").first();
    expect(row).toMatchObject({ account: "account-a", credential_hash: hash("rotated-token") });
    expect(row!.rotated_at).toBeTruthy();
  });

  it.each(["", "Bearer wrong", "Basic wrong"])("rejects both drain routes with auth %s", async (authorization) => {
    for (const [path, method] of [["pending", "GET"], ["ack", "POST"]]) {
      const response = await h.request(`/api/conversions/${path}?token=${DRAIN_TOKEN}`, {
        method, headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
    }
  });

  it("fails closed with no configured drain secret", async () => {
    const worker = await h.mf.getWorker("no-drain-token");
    const response = await worker.fetch("https://core.aduplift.ai/api/conversions/pending", {
      headers: { Authorization: `Bearer ${DRAIN_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it("applies both D1 migration sets, including account_credentials", async () => {
    const columns = await h.db.prepare("PRAGMA table_info(account_credentials)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(["account", "credential_hash", "created_at", "rotated_at"]);
    expect(await h.factory.prepare("SELECT count(*) AS n FROM audit_log").first()).toEqual({ n: 0 });
  });
});

const cases = JSON.parse(fixtureText("postback/cases.json")).cases as Array<{
  name: string; query: string; expect: Postback | null; queues_conversion?: boolean;
}>;

describe.each(["GET", "POST"])("postback V1 goldens via %s", (method) => {
  it.each(cases)("$name", async (testCase) => {
    await h.seedBrand();
    const cid = testCase.expect?.cid ?? new URLSearchParams(testCase.query).get("cid") ?? "abc123";
    await h.seedLead("lead-1", cid, "brand-a", { gclid: "stored-click" });
    const response = await h.request(`/api/postback?${testCase.query}`, { method });
    if (testCase.expect === null) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ status: "invalid", message: "Invalid postback" });
      expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
      return;
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted", lead_id: "lead-1" });
    expect(await h.db.prepare("SELECT event_type, payout FROM postback_events").first())
      .toEqual({ event_type: testCase.expect.type, payout: testCase.expect.payout });
    expect(await h.db.prepare("SELECT status FROM leads").first()).toEqual({ status: testCase.expect.type });
    const conversion = await h.queue();
    if (testCase.queues_conversion) expect(conversion).toMatchObject({ value: testCase.expect.payout, gclid: "stored-click", attempts: 0 });
    else expect(conversion).toBeNull();
  });
});

describe("postback isolation and V1 idempotency", () => {
  beforeEach(async () => { await h.seedBrand(); await h.seedLead(); });

  it.each(["", "wrong", "U"])("rejects missing/wrong/other-brand postback token %s without writes", async (token) => {
    await h.seedBrand("brand-b", "U", "account-b");
    const response = await h.request(`/api/postback?token=${token}&cid=abc123&type=soldLead&payout=25`);
    expect(response.status).toBe(401);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
    expect(await h.queue()).toBeNull();
  });

  it("fails closed for an unset, malformed or unconfigured brand hash", async () => {
    for (const stored of [null, "not-a-hash"]) {
      await h.db.prepare("UPDATE brand_runtime SET postback_token_hash = ?1").bind(stored).run();
      expect((await h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=25")).status).toBe(401);
    }
    await h.db.prepare("DELETE FROM brand_runtime").run();
    expect((await h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=25")).status).toBe(401);
  });

  it("keeps V1 header fallback, whitespace trim and query precedence", async () => {
    const response = await h.request("/api/postback?cid=abc123&type=soldLead&payout=25", {
      headers: { Authorization: "bEaReR   T " },
    });
    expect(response.status).toBe(200);
    expect((await h.request("/api/postback?token=wrong&cid=abc123&type=soldLead", {
      headers: { Authorization: "Bearer T" },
    })).status).toBe(401);
  });

  it("authenticates unknown cid then returns V1 ignored; buyer lead_id cannot select a lead", async () => {
    for (const cid of ["unknown", "lead1"]) {
      const response = await h.request(`/api/postback?token=T&cid=${cid}&lead_id=lead-1&type=soldLead&payout=25`);
      expect(await response.json()).toEqual({ status: "ignored", reason: "unknown_click" });
    }
    expect((await h.request("/api/postback?token=wrong&cid=unknown&type=soldLead")).status).toBe(401);
    expect(await h.queue()).toBeNull();
  });

  it("queues without a click ID and preserves first payout on concurrent/repeated callbacks", async () => {
    const path = "/api/postback?token=T&cid=abc123&type=soldLead&payout=25";
    const responses = await Promise.all([h.request(path), h.request(path)]);
    const statuses = await Promise.all(responses.map(async (res) => (await res.json() as { status: string }).status));
    expect(statuses.sort()).toEqual(["accepted", "duplicate"]);
    await h.request(path.replace("payout=25", "payout=100"));
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 1 });
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 1 });
    expect(await h.queue()).toMatchObject({ value: 25, gclid: null });
  });

  it("queues a paid replay of a zero sale but keeps the original dedup event", async () => {
    await h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=0");
    const response = await h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=25");
    expect(await response.json()).toEqual({ status: "duplicate", lead_id: "lead-1" });
    expect(await h.queue()).toMatchObject({ value: 25 });
    expect(await h.db.prepare("SELECT payout FROM postback_events").first()).toEqual({ payout: 0 });
  });

  it("keeps sold status after late newLead/rejectLead and copies Microsoft's ref_id fallback", async () => {
    await h.db.prepare("UPDATE leads SET tracking_json = ?1").bind(JSON.stringify({ ref_id: "ms-fallback" })).run();
    for (const type of ["soldLead", "newLead", "rejectLead"]) {
      await h.request(`/api/postback?token=T&cid=abc123&type=${type}&payout=25`);
    }
    expect(await h.db.prepare("SELECT status FROM leads").first()).toEqual({ status: "soldLead" });
    expect(await h.queue()).toMatchObject({ msclkid: "ms-fallback" });
  });

  it("rolls back enqueue, event and status together when the batch fails", async () => {
    await h.db.prepare(`CREATE TRIGGER fixture_fail BEFORE UPDATE ON leads
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
    try {
      await expect(h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=25"))
        .rejects.toThrow("fixture failure");
      expect(await h.queue()).toBeNull();
      expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
      expect(await h.db.prepare("SELECT status FROM leads").first()).toEqual({ status: "accepted" });
    } finally {
      await h.db.prepare("DROP TRIGGER fixture_fail").run();
    }
  });

  it.each(["", "curl/8", "AdsBot-Google", "Googlebot", "Mozilla/5.0"])("answers callbacks normally for UA %s", async (ua) => {
    const response = await h.request("/api/postback?token=T&cid=abc123&type=soldLead&payout=25", {
      headers: { "User-Agent": ua, "CF-Connecting-IP": "192.0.2.1", Referer: "https://example.com" },
    });
    expect(await response.json()).toEqual({ status: "accepted", lead_id: "lead-1" });
  });
});

describe("pending/ack leases and retries", () => {
  beforeEach(async () => { await h.seedLead(); await h.seedConversion(); });

  it("peek does not claim; overlapping polls claim once; live leases cannot be reclaimed", async () => {
    const peek = await h.pending("?limit=100&peek=1");
    expect((await peek.json() as { conversions: unknown[] }).conversions).toHaveLength(1);
    expect(await h.queue()).toMatchObject({ status: "pending", attempts: 0, updated_at: null });
    const responses = await Promise.all([h.pending(), h.pending()]);
    const rows = await Promise.all(responses.map(async (response) => (await response.json() as { conversions: unknown[] }).conversions));
    expect(rows.flat()).toHaveLength(1);
    expect(await h.queue()).toMatchObject({ status: "processing", attempts: 0 });
    expect(await (await h.pending()).text()).toBe(fixtureText("drain/pending.response.empty.json"));
  });

  it("reclaims stale or null leases, counts attempts, then parks exhausted crashes", async () => {
    await h.pending();
    await h.db.prepare("UPDATE conversion_uploads SET updated_at = NULL, attempts = 5").run();
    const claimed = await h.pending();
    expect((await claimed.json() as { conversions: Array<{ attempts: number }> }).conversions[0]!.attempts).toBe(6);
    await h.db.prepare("UPDATE conversion_uploads SET updated_at = ?1")
      .bind(new Date(Date.now() - CONV_LEASE_STALE_MS - 5_000).toISOString()).run();
    expect(await (await h.pending()).text()).toBe(fixtureText("drain/pending.response.empty.json"));
    expect(await h.queue()).toMatchObject({ status: "dead", attempts: 6, last_error: "reclaim: exhausted attempts after stale lease" });
  });

  it("backs off 5/10/20/40/80 minutes and dies on the sixth failed attempt", async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      await h.pending();
      expect(await (await h.ack([{ lead_id: "lead-1", status: "failed", error: "failed" }])).json())
        .toEqual({ status: "accepted", acked: 1 });
      const row = (await h.queue())!;
      expect(row.attempts).toBe(attempt);
      if (attempt < 6) {
        expect(row.status).toBe("pending");
        expect(Date.parse(row.next_attempt_at!) - Date.parse(row.updated_at!)).toBe(5 * 60_000 * 2 ** (attempt - 1));
        expect(await (await h.pending()).text()).toBe(fixtureText("drain/pending.response.empty.json"));
        await h.db.prepare("UPDATE conversion_uploads SET next_attempt_at = NULL").run();
      } else expect(row.status).toBe("dead");
    }
  });

  it("defers without spending attempts and makes duplicate/unclaimed acks no-ops", async () => {
    expect(await (await h.ack([{ lead_id: "lead-1", status: "uploaded" }])).json()).toEqual({ status: "accepted", acked: 0 });
    await h.pending();
    const result = { lead_id: "lead-1", status: "deferred", error: "not routed" };
    expect(await (await h.ack([result, result])).json()).toEqual({ status: "accepted", acked: 1 });
    const row = (await h.queue())!;
    expect(row).toMatchObject({ status: "pending", attempts: 0, last_error: "not routed" });
    expect(Date.parse(row.next_attempt_at!) - Date.parse(row.updated_at!)).toBe(CONV_LEASE_STALE_MS);
    expect(await (await h.pending()).text()).toBe(fixtureText("drain/pending.response.empty.json"));
  });

  it("uploaded ack increments once, clears error and ignores unrecognized rows", async () => {
    await h.db.prepare("UPDATE conversion_uploads SET last_error = 'old'").run();
    await h.pending();
    const response = await h.ack([
      { lead_id: "", status: "uploaded" }, { lead_id: "lead-1", status: "skipped" },
      { lead_id: "missing", status: "failed" }, { lead_id: "lead-1", status: "uploaded" },
      { lead_id: "lead-1", status: "failed" },
    ]);
    expect(await response.json()).toEqual({ status: "accepted", acked: 1 });
    expect(await h.queue()).toMatchObject({ status: "uploaded", attempts: 1, last_error: null });
  });

  it("preserves V1 invalid JSON tolerance and 300-character error cleaning", async () => {
    const invalid = await h.request("/api/conversions/ack", {
      method: "POST", headers: { Authorization: `Bearer ${DRAIN_TOKEN}` }, body: "{",
    });
    expect(await invalid.json()).toEqual({ status: "accepted", acked: 0 });
    await h.pending();
    await h.ack([{ lead_id: " lead-1 ", status: " failed ", error: "\u0000" + "x".repeat(350) }]);
    expect((await h.queue())!.last_error).toBe("x".repeat(300));
  });

  it("preserves V1 absent/invalid/clamped limits and returns pending oldest first on peek", async () => {
    await h.seedLead("lead-2", "cid2");
    await h.seedConversion("lead-2", { created_at: "2025-01-01T00:00:00.000Z" });
    for (const query of ["?peek=1", "?limit=0&peek=1", "?limit=-10&peek=1"]) {
      const rows = (await (await h.pending(query)).json() as { conversions: Array<{ lead_id: string }> }).conversions;
      expect(rows.map((row) => row.lead_id)).toEqual(["lead-2"]);
    }
    for (const query of ["?limit=NaN&peek=1", "?limit=9999&peek=1"]) {
      const rows = (await (await h.pending(query)).json() as { conversions: unknown[] }).conversions;
      expect(rows).toHaveLength(2);
    }
  });
});
