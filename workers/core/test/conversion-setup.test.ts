import { timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AdminRequestContext } from "@anjuna/contracts";
import { handleSetupResult, type ResultHooks } from "../src/conversion-setup.js";
import type { Env } from "../src/env.js";
import { createHarness, DRAIN_TOKEN, fixtureText, type Harness } from "./helpers.js";

const owner: AdminRequestContext = { actor_id: "usr_owner_01", actor_role: "owner", request_id: "req_setup_owner" };
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_setup_emp" };

const NAME_A = "cv-0123456789abcdef";
const NAME_B = "cv-fedcba9876543210";
const ACCOUNT = "4811219623";
const OTHER_ACCOUNT = "1234567890";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  // Only Workers has subtle.timingSafeEqual; the in-process handler calls in this file run under Node.
  const subtle = crypto.subtle as unknown as { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);
});
// h.reset() would clear audit_log, which is append-only once written. Only the LEADS tables used here are
// cleared, and audit assertions read the rows added after this test started.
let auditBase = 0;
beforeEach(async () => {
  await h.db.batch(["conversion_setup", "brand_runtime"].map((table) => h.db.prepare(`DELETE FROM ${table}`)));
  auditBase = (await h.factory.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log").first<{ id: number }>())!.id;
  await h.seedBrand("brand-a", "token-a");
  await h.seedBrand("brand-b", "token-b");
});
afterAll(async () => { await h?.mf.dispose(); });

const auth = { Authorization: `Bearer ${DRAIN_TOKEN}` };
const pending = () => h.request("/api/conversions/setup/pending", { headers: auth });
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  h.request(`/api/conversions/setup/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const claim = (brand_id: string, name = NAME_A) => post("claim", { brand_id, name });
const result = (body: Record<string, unknown>) => post("result", body);
const setRoute = (brand: string, account: string | null, action: string | null = null, project: string | null = null) =>
  h.db.prepare(`UPDATE brand_runtime SET google_ads_account = ?1, google_conversion_action = ?2, adkit_project = ?3
    WHERE brand_id = ?4`).bind(account, action, project, brand).run();
const setupRow = (brand: string) =>
  h.db.prepare("SELECT * FROM conversion_setup WHERE brand_id = ?1").bind(brand).first<Record<string, unknown>>();
const brandRow = (brand: string) =>
  h.db.prepare("SELECT google_conversion_action, updated_at FROM brand_runtime WHERE brand_id = ?1")
    .bind(brand).first<{ google_conversion_action: string | null; updated_at: string }>();
const audit = async () =>
  (await h.factory.prepare("SELECT * FROM audit_log WHERE id > ?1 ORDER BY id").bind(auditBase).all<Record<string, unknown>>()).results;
const insertSetup = (brand: string, row: Record<string, unknown>) => {
  const full = {
    brand_id: brand, account: ACCOUNT, name: NAME_A, status: "claimed", claim_id: "11111111-1111-4111-8111-111111111111",
    claimed_at: new Date().toISOString(), attempts: 0, next_attempt_at: null, last_error: null,
    conversion_action_id: null, updated_at: new Date().toISOString(), ...row,
  };
  return h.db.prepare(`INSERT INTO conversion_setup (${Object.keys(full).join(",")})
    VALUES (${Object.keys(full).map(() => "?").join(",")})`).bind(...Object.values(full)).run();
};
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const adminState = async (brand: string, context = owner) =>
  h.admin(`/admin/brands/${brand}/conversion-setup`, context);

describe("auth and body rules", () => {
  it("setup endpoints answer 401 without the drain token and ignore ?token=", async () => {
    await setRoute("brand-a", ACCOUNT);
    for (const authorization of ["", "Bearer wrong"]) {
      const headers = { Authorization: authorization };
      const responses = [
        await h.request("/api/conversions/setup/pending", { headers }),
        await post("claim", { brand_id: "brand-a", name: NAME_A }, headers),
        await post("result", { brand_id: "brand-a", claim_id: "11111111-1111-4111-8111-111111111111", conversion_action_id: "1" }, headers),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(await response.text()).toBe(fixtureText("drain/unauthorized.response.json"));
      }
    }
    const viaQuery = [
      await h.request(`/api/conversions/setup/pending?token=${DRAIN_TOKEN}`),
      await h.request(`/api/conversions/setup/claim?token=${DRAIN_TOKEN}`, { method: "POST", body: JSON.stringify({ brand_id: "brand-a", name: NAME_A }) }),
      await h.request(`/api/conversions/setup/result?token=${DRAIN_TOKEN}`, { method: "POST", body: "{}" }),
    ];
    for (const response of viaQuery) expect(response.status).toBe(401);
    expect(await setupRow("brand-a")).toBeNull();
  });

  it("answers 413 above 4 KB and 400 for bad JSON or unknown fields", async () => {
    expect((await post("claim", JSON.stringify({ brand_id: "brand-a", name: NAME_A, pad: "x".repeat(5000) }))).status).toBe(413);
    expect((await post("result", "x".repeat(5000))).status).toBe(413);
    expect((await post("claim", "{brand")).status).toBe(400);
    const extra = await post("claim", { brand_id: "brand-a", name: NAME_A, extra: 1 });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ status: "invalid", message: "Invalid body" });
    const both = await result({ brand_id: "brand-a", claim_id: "11111111-1111-4111-8111-111111111111", conversion_action_id: "1", error: "x" });
    expect(both.status).toBe(400);
  });
});

describe("GET /api/conversions/setup/pending", () => {
  it("pending lists brands with an account and no conversion action, ordered, with stored name", async () => {
    await h.seedBrand("brand-c", "token-c");
    await setRoute("brand-c", OTHER_ACCOUNT, null, "proj_c");
    await setRoute("brand-a", ACCOUNT);
    await insertSetup("brand-a", { status: "claimed", claimed_at: minutesAgo(40), account: ACCOUNT, name: NAME_B });
    await insertSetup("brand-c", { status: "created", account: "9999999999", name: NAME_A });
    const response = await pending();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      brands: [
        { brand_id: "brand-a", account: ACCOUNT, project: null, name: NAME_B },
        // brand-c's stored row is for another account, so its name is not offered.
        { brand_id: "brand-c", account: OTHER_ACCOUNT, project: "proj_c", name: null },
      ],
    });
  });

  it("pending skips a live claim, a brand with an action and a failed row before next_attempt_at", async () => {
    for (const id of ["brand-c", "brand-d", "brand-e"]) await h.seedBrand(id, `token-${id}`);
    for (const id of ["brand-a", "brand-b", "brand-c", "brand-d"]) await setRoute(id, ACCOUNT);
    await setRoute("brand-b", ACCOUNT, "42");
    await insertSetup("brand-a", { status: "claimed", claimed_at: minutesAgo(5) });
    await insertSetup("brand-c", { status: "failed", attempts: 1, next_attempt_at: hoursFromNow(1), last_error: "x" });
    // brand-d has no row, brand-e has no account.
    expect(await (await pending()).json()).toEqual({
      brands: [{ brand_id: "brand-d", account: ACCOUNT, project: null, name: null }],
    });
  });

  it("pending offers a failed row after its backoff and drops it after 5 attempts", async () => {
    await h.seedBrand("brand-c", "token-c");
    for (const id of ["brand-a", "brand-b", "brand-c"]) await setRoute(id, ACCOUNT);
    await insertSetup("brand-a", { status: "failed", attempts: 2, next_attempt_at: minutesAgo(1), last_error: "x" });
    await insertSetup("brand-b", { status: "failed", attempts: 5, next_attempt_at: minutesAgo(1), last_error: "x" });
    await insertSetup("brand-c", { status: "created", conversion_action_id: "77" });
    const { brands } = await (await pending()).json() as { brands: Array<{ brand_id: string }> };
    expect(brands.map((b) => b.brand_id)).toEqual(["brand-a", "brand-c"]);
  });
});

describe("POST /api/conversions/setup/claim", () => {
  it("claim stores the name and a second claim answers 409 busy", async () => {
    await setRoute("brand-a", ACCOUNT, null, "proj_a");
    const first = await claim("brand-a");
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(body).toEqual({ status: "claimed", claim_id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: NAME_A, account: ACCOUNT, project: "proj_a" });
    expect(await setupRow("brand-a")).toMatchObject({
      status: "claimed", name: NAME_A, account: ACCOUNT, claim_id: body.claim_id, attempts: 0,
    });
    const second = await claim("brand-a", NAME_B);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ status: "busy" });
    expect((await setupRow("brand-a"))!.claim_id).toBe(body.claim_id);
  });

  it("claim of a stale claimed row (31 minutes) succeeds and keeps the stored name", async () => {
    await setRoute("brand-a", ACCOUNT);
    await insertSetup("brand-a", { status: "claimed", claimed_at: minutesAgo(31), name: NAME_A, attempts: 2 });
    const response = await claim("brand-a", NAME_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: NAME_A });
    expect(await setupRow("brand-a")).toMatchObject({ name: NAME_A, attempts: 2, status: "claimed" });
  });

  it("claim of a created row whose action was cleared keeps the stored name and attempts, and pending offers that name", async () => {
    await setRoute("brand-a", ACCOUNT);
    await insertSetup("brand-a", { status: "created", conversion_action_id: "77", name: NAME_A, attempts: 2 });
    expect(await (await pending()).json()).toEqual({
      brands: [{ brand_id: "brand-a", account: ACCOUNT, project: null, name: NAME_A }],
    });
    const response = await claim("brand-a", NAME_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: NAME_A, account: ACCOUNT });
    expect(await setupRow("brand-a")).toMatchObject({
      status: "claimed", name: NAME_A, attempts: 2, conversion_action_id: null, last_error: null,
    });
  });

  it("claim of a claimed row at 29 minutes answers 409 busy", async () => {
    await setRoute("brand-a", ACCOUNT);
    await insertSetup("brand-a", { status: "claimed", claimed_at: minutesAgo(29) });
    expect((await claim("brand-a")).status).toBe(409);
  });

  it("claim after the account changed resets attempts and takes the proposed name", async () => {
    await setRoute("brand-a", OTHER_ACCOUNT);
    await insertSetup("brand-a", {
      status: "failed", account: ACCOUNT, name: NAME_A, attempts: 5, next_attempt_at: hoursFromNow(5), last_error: "boom",
    });
    const response = await claim("brand-a", NAME_B);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: NAME_B, account: OTHER_ACCOUNT });
    expect(await setupRow("brand-a")).toMatchObject({
      account: OTHER_ACCOUNT, name: NAME_B, attempts: 0, next_attempt_at: null, last_error: null, status: "claimed",
    });
  });

  it("claim refuses a failed row before its backoff and one with 5 attempts", async () => {
    await setRoute("brand-a", ACCOUNT);
    await setRoute("brand-b", ACCOUNT);
    await insertSetup("brand-a", { status: "failed", attempts: 1, next_attempt_at: hoursFromNow(1), last_error: "x" });
    await insertSetup("brand-b", { status: "failed", attempts: 5, next_attempt_at: minutesAgo(1), last_error: "x" });
    expect((await claim("brand-a")).status).toBe(409);
    expect((await claim("brand-b")).status).toBe(409);
  });

  it("claim answers 409 busy for a brand without an account or with an action", async () => {
    await setRoute("brand-b", ACCOUNT, "42");
    expect((await claim("brand-a")).status).toBe(409);
    expect((await claim("brand-b")).status).toBe(409);
    expect(await setupRow("brand-a")).toBeNull();
    expect(await setupRow("brand-b")).toBeNull();
  });

  it("claim of an unknown brand answers 404 and a bad name 400", async () => {
    const unknown = await claim("brand-zz");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ status: "invalid", message: "Unknown brand_id" });
    await setRoute("brand-a", ACCOUNT);
    for (const name of ["brand-a", "cv-ABCDEF0123456789", "cv-0123", `${NAME_A}0`]) {
      expect((await claim("brand-a", name)).status).toBe(400);
    }
    expect(await setupRow("brand-a")).toBeNull();
  });
});

describe("POST /api/conversions/setup/result", () => {
  const claimed = async (brand = "brand-a") => {
    await setRoute(brand, ACCOUNT);
    return (await (await claim(brand)).json() as { claim_id: string }).claim_id;
  };

  it("result with an id sets google_conversion_action, bumps updated_at, writes one audit row", async () => {
    const claimId = await claimed();
    const before = (await brandRow("brand-a"))!.updated_at;
    const response = await result({ brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "created" });
    const brand = (await brandRow("brand-a"))!;
    expect(brand.google_conversion_action).toBe("7754587837");
    expect(Date.parse(brand.updated_at)).toBeGreaterThan(Date.parse(before));
    expect(await setupRow("brand-a")).toMatchObject({ status: "created", conversion_action_id: "7754587837", last_error: null });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: "drain", actor_role: "system", action: "brand.conversion_create", entity_type: "brand", entity_id: "brand-a",
    });
    expect(JSON.parse(rows[0]!.before_json as string)).toEqual({ google_conversion_action: null });
    expect(JSON.parse(rows[0]!.after_json as string)).toEqual({ google_conversion_action: "7754587837", name: NAME_A, account: ACCOUNT });
  });

  it("repeating the same id result answers already true and writes no second audit row", async () => {
    const claimId = await claimed();
    const body = { brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" };
    expect((await result(body)).status).toBe(200);
    const stamp = await brandRow("brand-a");
    const again = await result(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "created", already: true });
    expect(await audit()).toHaveLength(1);
    expect(await brandRow("brand-a")).toEqual(stamp);
    // A repeat after the owner cleared the action must not write it back, and is no longer a success.
    await h.db.prepare("UPDATE brand_runtime SET google_conversion_action = NULL WHERE brand_id = 'brand-a'").run();
    const cleared = await result(body);
    expect(cleared.status).toBe(409);
    expect(await cleared.json()).toEqual({ status: "stale" });
    expect((await brandRow("brand-a"))!.google_conversion_action).toBeNull();
    expect(await audit()).toHaveLength(1);
  });

  it("repeating a stale id result answers 409 stale again", async () => {
    const claimId = await claimed();
    await setRoute("brand-a", OTHER_ACCOUNT);
    const body = { brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" };
    expect((await result(body)).status).toBe(409);
    expect(await setupRow("brand-a")).toMatchObject({ status: "created", conversion_action_id: "7754587837" });
    const again = await result(body);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ status: "stale" });
    expect((await brandRow("brand-a"))!.google_conversion_action).toBeNull();
    expect(await audit()).toEqual([]);
  });

  // The handler runs in the test process against the Miniflare D1 bindings so a hook can act inside the race window.
  const callResult = (body: Record<string, unknown>, hooks: ResultHooks) =>
    handleSetupResult(
      new Request("https://core.test/api/conversions/setup/result", {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
      { LEADS: h.db, FACTORY: h.factory, DRAIN_TOKEN } as unknown as Env,
      hooks,
    );

  it("id result retries when the brand updated_at changed between read and write", async () => {
    const claimId = await claimed();
    let panelSaves = 0;
    const response = await callResult(
      { brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" },
      {
        beforeBatch: async () => {
          // A panel save lands after the handler read updated_at, once. The retry must see the new value.
          if (panelSaves++ > 0) return;
          await h.db.prepare("UPDATE brand_runtime SET adkit_project = 'proj_x', updated_at = ?1 WHERE brand_id = 'brand-a'")
            .bind(hoursFromNow(1)).run();
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "created" });
    expect(panelSaves).toBe(2);
    const brand = (await brandRow("brand-a"))!;
    expect(brand.google_conversion_action).toBe("7754587837");
    // The write moves forward from the panel's value, never back or equal.
    expect(Date.parse(brand.updated_at)).toBeGreaterThan(Date.parse(hoursFromNow(0)) + 3_000_000);
    expect(await setupRow("brand-a")).toMatchObject({ status: "created", conversion_action_id: "7754587837" });
    expect(await audit()).toHaveLength(1);
  });

  it("id result that loses the version race 3 times answers 409 stale and leaves the row claimed", async () => {
    const claimId = await claimed();
    let saves = 0;
    const response = await callResult(
      { brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" },
      {
        beforeBatch: async () => {
          await h.db.prepare("UPDATE brand_runtime SET updated_at = ?1 WHERE brand_id = 'brand-a'")
            .bind(hoursFromNow(++saves)).run();
        },
      },
    );
    expect(response.status).toBe(409);
    expect(saves).toBe(3);
    expect((await brandRow("brand-a"))!.google_conversion_action).toBeNull();
    expect(await setupRow("brand-a")).toMatchObject({ status: "claimed", conversion_action_id: null });
    expect(await audit()).toEqual([]);
  });

  it("created audit row keeps the recorded claim when a new claim lands before the audit", async () => {
    const claimId = await claimed();
    const response = await callResult(
      { brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" },
      {
        afterBatch: async () => {
          await setRoute("brand-a", OTHER_ACCOUNT);
          expect((await claim("brand-a", NAME_B)).status).toBe(200);
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await setupRow("brand-a")).toMatchObject({ status: "claimed", account: OTHER_ACCOUNT, name: NAME_B });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.after_json as string)).toEqual({ google_conversion_action: "7754587837", name: NAME_A, account: ACCOUNT });
  });

  it("result with a wrong claim_id answers 409 stale and writes nothing", async () => {
    await claimed();
    const response = await result({ brand_id: "brand-a", claim_id: "22222222-2222-4222-8222-222222222222", conversion_action_id: "99" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "stale" });
    expect((await brandRow("brand-a"))!.google_conversion_action).toBeNull();
    expect(await setupRow("brand-a")).toMatchObject({ status: "claimed", conversion_action_id: null });
    expect(await audit()).toEqual([]);
    const failed = await result({ brand_id: "brand-a", claim_id: "22222222-2222-4222-8222-222222222222", error: "x" });
    expect(failed.status).toBe(409);
    expect(await setupRow("brand-a")).toMatchObject({ status: "claimed", attempts: 0 });
  });

  it("result for an unknown brand answers 404", async () => {
    const response = await result({ brand_id: "brand-zz", claim_id: "22222222-2222-4222-8222-222222222222", conversion_action_id: "99" });
    expect(response.status).toBe(404);
  });

  it("result with an id after the action was set by hand answers 409 stale and keeps the hand-set value", async () => {
    const claimId = await claimed();
    await h.db.prepare("UPDATE brand_runtime SET google_conversion_action = '555' WHERE brand_id = 'brand-a'").run();
    const response = await result({ brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "stale" });
    expect((await brandRow("brand-a"))!.google_conversion_action).toBe("555");
    // The row is created with the drain's id so the name is not reused.
    expect(await setupRow("brand-a")).toMatchObject({ status: "created", conversion_action_id: "7754587837" });
    expect(await audit()).toEqual([]);
  });

  it("result with an id after the account changed answers 409 stale and leaves the brand alone", async () => {
    const claimId = await claimed();
    await setRoute("brand-a", OTHER_ACCOUNT);
    const response = await result({ brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" });
    expect(response.status).toBe(409);
    expect((await brandRow("brand-a"))!.google_conversion_action).toBeNull();
    expect(await audit()).toEqual([]);
  });

  it("failed result after the account changed answers 409 stale, keeps attempts and writes no audit row", async () => {
    const claimId = await claimed();
    await setRoute("brand-a", OTHER_ACCOUNT);
    const response = await result({ brand_id: "brand-a", claim_id: claimId, error: "boom" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "stale" });
    expect(await setupRow("brand-a")).toMatchObject({ status: "claimed", attempts: 0, last_error: null });
    expect(await audit()).toEqual([]);
  });

  it("created audit row carries the name and account of the recorded claim", async () => {
    await setRoute("brand-a", ACCOUNT);
    const claimId = (await (await claim("brand-a", NAME_B)).json() as { claim_id: string }).claim_id;
    expect((await result({ brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" })).status).toBe(200);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.after_json as string)).toEqual({ google_conversion_action: "7754587837", name: NAME_B, account: ACCOUNT });
  });

  it("failed result increments attempts, sets backoff and an audit row; the 5th failure stops further claims", async () => {
    await setRoute("brand-a", ACCOUNT);
    const expectedHours = [1, 2, 4, 8, 16];
    let lastClaimId = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await h.db.prepare("UPDATE conversion_setup SET next_attempt_at = ?1 WHERE brand_id = 'brand-a'").bind(minutesAgo(1)).run();
      const claimResponse = await claim("brand-a");
      expect(claimResponse.status).toBe(200);
      const { claim_id } = await claimResponse.json() as { claim_id: string };
      lastClaimId = claim_id;
      const start = Date.now();
      const response = await result({ brand_id: "brand-a", claim_id, error: `boom ${attempt}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "failed" });
      const row = (await setupRow("brand-a"))!;
      expect(row).toMatchObject({ status: "failed", attempts: attempt, last_error: `boom ${attempt}` });
      const waitedMs = Date.parse(row.next_attempt_at as string) - start;
      expect(waitedMs).toBeGreaterThan(expectedHours[attempt - 1]! * 3_600_000 - 60_000);
      expect(waitedMs).toBeLessThan(expectedHours[attempt - 1]! * 3_600_000 + 60_000);
    }
    const rows = await audit();
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({ actor_id: "drain", actor_role: "system", action: "brand.conversion_create_failed", entity_id: "brand-a" });
    expect(JSON.parse(rows[4]!.after_json as string)).toEqual({ error: "boom 5", attempts: 5, name: NAME_A, account: ACCOUNT });
    // After 5 failures the backoff has passed but no claim is offered.
    await h.db.prepare("UPDATE conversion_setup SET next_attempt_at = ?1 WHERE brand_id = 'brand-a'").bind(minutesAgo(1)).run();
    expect((await claim("brand-a")).status).toBe(409);
    expect(await (await pending()).json()).toEqual({ brands: [] });
    // A repeat of the last failure with the real claim id is stale: the row is no longer claimed.
    const repeat = await result({ brand_id: "brand-a", claim_id: lastClaimId, error: "boom 5" });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toEqual({ status: "stale" });
    expect(await setupRow("brand-a")).toMatchObject({ status: "failed", attempts: 5 });
    expect(await audit()).toHaveLength(5);
  });

  it("routing includes the brand after a created result", async () => {
    const claimId = await claimed();
    const routing = () => h.request("/api/conversions/routing", { headers: auth });
    expect(await (await routing()).json()).toEqual({});
    await result({ brand_id: "brand-a", claim_id: claimId, conversion_action_id: "7754587837" });
    expect(await (await routing()).json()).toEqual({ "brand-a": { account: ACCOUNT, conversionAction: "7754587837" } });
  });
});

describe("GET /admin/brands/:id/conversion-setup", () => {
  it("admin conversion-setup returns none, pending, created and failed states; employee gets 403", async () => {
    const state = async (brand: string) => (await (await adminState(brand)).json() as { conversion_setup: Record<string, unknown> }).conversion_setup;

    expect(await state("brand-a")).toEqual({
      status: "none", error: null, name: null, conversion_action_id: null, attempts: 0, updated_at: null,
    });

    await setRoute("brand-a", ACCOUNT);
    expect(await state("brand-a")).toMatchObject({ status: "pending", name: null, attempts: 0 });

    const claimId = (await (await claim("brand-a")).json() as { claim_id: string }).claim_id;
    expect(await state("brand-a")).toMatchObject({ status: "pending", name: NAME_A });

    await result({ brand_id: "brand-a", claim_id: claimId, error: "quota exceeded" });
    expect(await state("brand-a")).toMatchObject({
      status: "failed", error: "quota exceeded", name: NAME_A, attempts: 1, conversion_action_id: null,
    });

    await h.db.prepare("UPDATE conversion_setup SET next_attempt_at = ?1 WHERE brand_id = 'brand-a'").bind(minutesAgo(1)).run();
    const second = (await (await claim("brand-a")).json() as { claim_id: string }).claim_id;
    await result({ brand_id: "brand-a", claim_id: second, conversion_action_id: "7754587837" });
    expect(await state("brand-a")).toMatchObject({ status: "created", name: NAME_A, conversion_action_id: "7754587837", error: null });

    // A hand-set action has no name.
    await setRoute("brand-b", ACCOUNT, "42");
    expect(await state("brand-b")).toMatchObject({ status: "created", name: null, conversion_action_id: "42" });

    expect((await adminState("brand-a", employee)).status).toBe(403);
    expect((await adminState("brand-zz")).status).toBe(404);
  });
});
