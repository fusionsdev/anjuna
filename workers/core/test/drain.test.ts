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
