import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

const GLOBAL = "g".repeat(40);
const path = (token: string, cid = "abc123") => `/api/postback?token=${token}&cid=${cid}&type=soldLead&payout=25`;

describe("tenant-wide postback token", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness({ bindings: { POSTBACK_TOKEN: GLOBAL } }); });
  beforeEach(async () => { await h.reset(); await h.seedBrand("brand-a", "T"); await h.seedLead(); });
  afterAll(async () => { await h?.mf.dispose(); });

  it("accepts the global token for a brand that has no per-brand token", async () => {
    await h.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL").run();
    const response = await h.request(path(GLOBAL));
    expect(await response.json()).toEqual({ status: "accepted", lead_id: "lead-1" });
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 1 });
  });

  it("keeps the per-brand token working beside the global one", async () => {
    expect((await h.request(path("T"))).status).toBe(200);
  });

  it("still rejects another brand's token for this brand's lead", async () => {
    await h.seedBrand("brand-b", "U", "account-b");
    expect((await h.request(path("U"))).status).toBe(401);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
  });

  it("authenticates an unknown cid with the global token and writes nothing", async () => {
    const response = await h.request(path(GLOBAL, "unknown"));
    expect(await response.json()).toEqual({ status: "ignored", reason: "unknown_click" });
    expect((await h.request(path("wrong", "unknown"))).status).toBe(401);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 0 });
  });

  it("accepts the global token from the Authorization header like V1", async () => {
    const response = await h.request("/api/postback?cid=abc123&type=soldLead&payout=25", {
      headers: { Authorization: `Bearer ${GLOBAL}` },
    });
    expect(response.status).toBe(200);
  });
});

describe.each([["empty", ""], ["whitespace", "   "], ["31 characters", "s".repeat(31)]])(
  "a %s global secret counts as unset", (_label, secret) => {
    let h: Harness;
    beforeAll(async () => { h = await createHarness({ bindings: { POSTBACK_TOKEN: secret } }); });
    beforeEach(async () => { await h.reset(); await h.seedBrand("brand-a", "T"); await h.seedLead(); });
    afterEach(async () => { expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 }); });
    afterAll(async () => { await h?.mf.dispose(); });

    it("rejects the secret value itself", async () => {
      await h.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL").run();
      expect((await h.request(path(encodeURIComponent(secret)))).status).toBe(401);
    });
  });
