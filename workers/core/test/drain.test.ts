import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, DRAIN_TOKEN, fixtureText, goldenRows, runRealDrain, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await h.reset(); });
afterAll(async () => { await h?.mf.dispose(); });

describe("unmodified V1 drain.mjs against Miniflare core", () => {
  it("matches golden pending response, real drain ack request, and ack response byte-for-byte", async () => {
    await h.seedGoldens();
    const run = await runRealDrain(h);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.exchanges).toHaveLength(2);
    expect(run.exchanges[0]).toMatchObject({ method: "GET", url: "/api/conversions/pending?limit=25",
      authorization: `Bearer ${DRAIN_TOKEN}`, body: "", status: 200,
      response: fixtureText("drain/pending.response.json"), responseContentType: "application/json; charset=utf-8" });
    expect(run.exchanges[1]).toMatchObject({ method: "POST", url: "/api/conversions/ack",
      authorization: `Bearer ${DRAIN_TOKEN}`, contentType: "application/json",
      body: fixtureText("drain/ack.request.json"), status: 200,
      response: fixtureText("drain/ack.response.json"), responseContentType: "application/json; charset=utf-8" });
    expect(run.stdout).toContain("uploaded=0 failed=1 skipped=3 acked=4");
    const rows = goldenRows();
    for (const index of [0, 1, 3]) {
      expect(await h.queue(rows[index]!.lead_id)).toMatchObject({ status: "pending", attempts: rows[index]!.attempts });
    }
    expect(await h.queue(rows[2]!.lead_id)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("validate-only uses peek, matches pending bytes and never acks or mutates the queue", async () => {
    await h.seedGoldens();
    const before = await h.db.prepare("SELECT * FROM conversion_uploads ORDER BY id").all();
    const run = await runRealDrain(h, { DRAIN_VALIDATE_ONLY: "true" });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]).toMatchObject({ url: "/api/conversions/pending?limit=25&peek=1",
      response: fixtureText("drain/pending.response.json") });
    expect((await h.db.prepare("SELECT * FROM conversion_uploads ORDER BY id").all()).results).toEqual(before.results);
    expect(run.stdout).toContain("validate-only: uploaded=0 failed=1 skipped=3");
  });

  it("empty queue matches golden bytes and skips ack", async () => {
    const run = await runRealDrain(h);
    expect(run.code).toBe(0);
    expect(run.exchanges).toHaveLength(1);
    expect(run.exchanges[0]!.response).toBe(fixtureText("drain/pending.response.empty.json"));
    expect(run.stdout).toContain("no pending conversions");
  });

  it("applies all three statuses from the mixed ack golden", async () => {
    await h.seedGoldens();
    await h.pending();
    const body = JSON.parse(fixtureText("drain/ack.request.mixed.json"));
    expect(await (await h.ack(body.results)).text()).toBe('{"status":"accepted","acked":3}');
    const rows = goldenRows();
    expect(await h.queue(rows[0]!.lead_id)).toMatchObject({ status: "uploaded", attempts: 1 });
    expect(await h.queue(rows[1]!.lead_id)).toMatchObject({ status: "pending", attempts: 3, last_error: "upload failed" });
    expect(await h.queue(rows[2]!.lead_id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await (await h.ack(body.results)).text()).toBe('{"status":"accepted","acked":0}');
  });

  describe("rows with no click id (FUS-341)", () => {
    const seed = async (id: string, ids: Record<string, string | null>, created: string) => {
      await h.seedLead(id, id.replace(/-/g, ""));
      await h.seedConversion(id, { gclid: null, gbraid: null, wbraid: null, msclkid: null, ...ids, created_at: created });
    };
    const leadIds = (body: { conversions: Array<{ lead_id: string }> }) => body.conversions.map((c) => c.lead_id).sort();

    it("never claims a no-click pending row and parks it as dead with last_error 'no click id'", async () => {
      await seed("noclick-null", {}, "2026-01-01T00:00:00.000Z");
      await seed("noclick-empty", { gclid: "", gbraid: "", wbraid: "", msclkid: "" }, "2026-01-01T00:00:01.000Z");
      const body = await (await h.pending()).json() as { conversions: Array<{ lead_id: string }> };
      expect(body.conversions).toEqual([]);
      for (const id of ["noclick-null", "noclick-empty"]) {
        expect(await h.queue(id)).toMatchObject({ status: "dead", last_error: "no click id", attempts: 0 });
      }
    });

    it.each(["gclid", "gbraid", "wbraid", "msclkid"])("still claims a row whose only click id is %s", async (field) => {
      await seed("has-click", { [field]: "click-1" }, "2026-01-01T00:00:00.000Z");
      await seed("noclick", {}, "2026-01-01T00:00:01.000Z");
      const body = await (await h.pending()).json() as { conversions: Array<{ lead_id: string }> };
      expect(leadIds(body)).toEqual(["has-click"]);
      expect(await h.queue("has-click")).toMatchObject({ status: "processing" });
      expect(await h.queue("noclick")).toMatchObject({ status: "dead", last_error: "no click id" });
    });

    it("parks a stale processing no-click row instead of reclaiming it", async () => {
      await seed("stale-noclick", {}, "2026-01-01T00:00:00.000Z");
      await h.db.prepare("UPDATE conversion_uploads SET status = 'processing', updated_at = '2026-01-01T00:00:00.000Z'").run();
      const body = await (await h.pending()).json() as { conversions: unknown[] };
      expect(body.conversions).toEqual([]);
      expect(await h.queue("stale-noclick")).toMatchObject({ status: "dead", last_error: "no click id" });
    });

    it("peek=1 excludes no-click rows and does not mutate them", async () => {
      await seed("has-click", { gclid: "click-1" }, "2026-01-01T00:00:00.000Z");
      await seed("noclick", {}, "2026-01-01T00:00:01.000Z");
      const body = await (await h.pending("?limit=100&peek=1")).json() as { conversions: Array<{ lead_id: string }> };
      expect(leadIds(body)).toEqual(["has-click"]);
      expect(await h.queue("noclick")).toMatchObject({ status: "pending", last_error: null });
      expect(await h.queue("has-click")).toMatchObject({ status: "pending" });
    });
  });
});

describe("GET /api/conversions/routing (BRAND_ROUTING_JSON served by core)", () => {
  const routing = () => h.request("/api/conversions/routing", { headers: { Authorization: `Bearer ${DRAIN_TOKEN}` } });
  const setRoute = (brand: string, account: string | null, action: string | null, project: string | null = null) =>
    h.db.prepare(`UPDATE brand_runtime SET google_ads_account = ?1, google_conversion_action = ?2, adkit_project = ?3
      WHERE brand_id = ?4`).bind(account, action, project, brand).run();

  it("returns 401 with the pending route's body when the token is missing or wrong", async () => {
    for (const authorization of ["", "Bearer wrong"]) {
      const response = await h.request("/api/conversions/routing", { headers: { Authorization: authorization } });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
    }
  });

  it("maps brand_id to account and action, omits a null project, and drops half-filled rows", async () => {
    for (const id of ["brand-a", "brand-b", "brand-c", "brand-d", "brand-e"]) await h.seedBrand(id, `token-${id}`);
    await setRoute("brand-a", "4811219623", "7754587837", "proj_a");
    await setRoute("brand-b", "1234567890", "42");
    await setRoute("brand-c", "1234567890", null);
    await setRoute("brand-d", null, "42");
    const response = await routing();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({
      "brand-a": { account: "4811219623", conversionAction: "7754587837", project: "proj_a" },
      "brand-b": { account: "1234567890", conversionAction: "42" },
    });
  });

  it("returns an empty object when no brand has a route", async () => {
    await h.seedBrand("brand-a");
    expect(await (await routing()).text()).toBe("{}");
  });

  it("feeds the unmodified V1 drain, which resolves the row through the per-brand map", async () => {
    await h.seedBrand("brand-a");
    await setRoute("brand-a", "4811219623", "7754587837");
    await h.seedLead("lead-routed", "routed1", "brand-a");
    await h.db.prepare("UPDATE leads SET status = 'soldLead' WHERE lead_id = 'lead-routed'").run();
    await h.seedConversion("lead-routed", { gclid: "routed-gclid" });
    const map = await (await routing()).text();
    const run = await runRealDrain(h, { BRAND_ROUTING_JSON: map, DRAIN_VALIDATE_ONLY: "true" });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("[routing] per-brand routing active for 1 brand key(s)");
    // The route resolved, so the drain went on to call adkit. The harness PATH has no adkit, so
    // the spawn fails; an unrouted row would be SKIPPED with "no route for brand=" instead.
    expect(run.stdout).toContain("validate-only: uploaded=0 failed=1 skipped=0");
    expect(run.stdout).toMatch(/fail: lead-routed .*adkit.*ENOENT/);
    expect(run.stdout).not.toContain("no route");

    // Control: the same row under an empty map is skipped as unrouted.
    const unrouted = await runRealDrain(h, { BRAND_ROUTING_JSON: "{}", DRAIN_VALIDATE_ONLY: "true" });
    expect(unrouted.stdout).toContain("SKIP: lead-routed no route for brand=brand-a hostname=brand-a.example");
  });
});
