import { timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TrafficTailEvent } from "@anjuna/contracts";
import type { Env } from "../src/env.js";
import { handlePostback } from "../src/postback.js";
import { createHarness, hash, type Harness } from "./helpers.js";

const path = (token = "T", cid = "abc123", type = "soldLead", payout = 25) =>
  `/api/postback?token=${token}&cid=${cid}&type=${type}&payout=${payout}`;
const telemetry = (h: Harness, session: string) => h.request("/analytics/telemetry", { method: "POST",
  headers: { authorization: "Bearer account-a-token", "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome" },
  body: JSON.stringify({ brand_id: "brand-a", hostname: "brand-a.example", kind: "telemetry", path: "/",
    content_type: "application/json", body: JSON.stringify({ event_type: "landing_viewed", session_id: session }) }) });
const postbackRowId = async (h: Harness, lead: string) =>
  (await h.db.prepare("SELECT id FROM postback_events WHERE lead_id = ?1 ORDER BY id DESC").bind(lead).first<{ id: number }>())!.id;

/**
 * Every event the recording tail received since the last call, in arrival order. Polls until `count` have arrived or
 * 3 seconds pass, then waits 100 ms more so a late extra push is counted too.
 */
async function pushes(h: Harness, count: number): Promise<TrafficTailEvent[]> {
  const namespace = await h.mf.getDurableObjectNamespace("TRAFFIC_TAIL", "production");
  const stub = namespace.get(namespace.idFromName("tail"));
  const drain = async () => (await (await stub.fetch("https://tail.internal/pushes")).json()) as unknown[];
  const received: unknown[] = [];
  for (const deadline = Date.now() + 3000; received.length < count && Date.now() < deadline;) {
    received.push(...await drain());
    if (received.length < count) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  received.push(...await drain());
  return received.map((event) => TrafficTailEvent.parse(event));
}

/**
 * Calls handlePostback in this process on the harness D1. The tail records each pushed body, and the ExecutionContext
 * keeps each waitUntil promise; `call` settles them before it returns. `failSql` may throw for a statement.
 */
function direct(h: Harness, failSql?: (sql: string) => void) {
  const pushed: TrafficTailEvent[] = [];
  const scheduled: Promise<unknown>[] = [];
  const stub = { fetch: async (_url: string, init: RequestInit) => {
    pushed.push(TrafficTailEvent.parse(JSON.parse(String(init.body))));
    return Response.json({ status: "ok" });
  } };
  const leads = { prepare: (sql: string) => { failSql?.(sql); return h.db.prepare(sql); },
    batch: (statements: Parameters<typeof h.db.batch>[0]) => h.db.batch(statements) };
  const env = { LEADS: leads, TRAFFIC_TAIL: { idFromName: () => "tail", get: () => stub } } as unknown as Env;
  const ctx = { waitUntil: (promise: Promise<unknown>) => { scheduled.push(promise); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (url: string, withCtx = true) => {
    const response = await handlePostback(new Request(`https://core.aduplift.ai${url}`), env, withCtx ? ctx : undefined);
    return { status: response.status, body: await response.json(), scheduled: await Promise.allSettled(scheduled.splice(0)) };
  };
  return { call, pushed };
}

describe("postback stage on the live tail", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness({ trafficTail: "recording" }); });
  beforeEach(async () => {
    await h.reset(); await h.seedAccount(); await h.seedBrand();
    await h.seedLead("lead-1", "abc123");
    await h.seedLead("lead-2", "def456");
    await h.db.prepare("UPDATE leads SET session_id = 'visitor-' || lead_id").run();
    await pushes(h, 0);
  });
  afterAll(async () => { await h?.mf.dispose(); });
  // `direct` runs the handler in Node, which lacks workerd's crypto.subtle.timingSafeEqual; node:crypto has the same check.
  beforeAll(() => { Object.assign(crypto.subtle, { timingSafeEqual }); });
  afterAll(() => { delete (crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual; });

  it("pushes one postback_received event into the session of the lead's telemetry", async () => {
    // The stored hostname is cased and carries www.; the tail domain is the bare lowercase host.
    await h.db.prepare("UPDATE leads SET hostname = 'WWW.Brand-A.example' WHERE lead_id = 'lead-1'").run();
    expect((await telemetry(h, "visitor-lead-1")).status).toBe(204);
    expect(await (await h.request(path())).json()).toEqual({ status: "accepted", lead_id: "lead-1" });
    const events = await pushes(h, 2);
    const visit = events.find((event) => event.event_type === "landing_viewed")!;
    const postbacks = events.filter((event) => event.event_type === "postback_received");
    expect(events).toHaveLength(2);
    expect(postbacks).toHaveLength(1);
    const [postback] = postbacks;
    expect(postback!.event_id).toBe(`pb-${await postbackRowId(h, "lead-1")}`);
    expect(postback!.session_ref).toBe(hash("visitor-lead-1").slice(0, 16));
    expect(postback!.session_ref).toBe(visit.session_ref);
    expect(postback).toEqual({ event_id: postback!.event_id, ts: postback!.ts, event_type: "postback_received",
      session_ref: visit.session_ref, brand: "brand-a", domain: "brand-a.example", device_type: null, browser: null,
      user_agent_family: "unknown", url: "https://brand-a.example/", http_status: null, response_ms: null, gate_passed: null });
  });

  it("pushes no second event for a duplicate postback", async () => {
    const { call, pushed } = direct(h);
    const first = await call(path());
    expect(first).toMatchObject({ status: 200, body: { status: "accepted", lead_id: "lead-1" }, scheduled: [{ status: "fulfilled" }] });
    expect(pushed.map((event) => event.event_id)).toEqual([`pb-${await postbackRowId(h, "lead-1")}`]);
    const replay = await call(path());
    expect(replay).toEqual({ status: 200, body: { status: "duplicate", lead_id: "lead-1" }, scheduled: [] });
    expect(pushed).toHaveLength(1);
  });

  it("pushes nothing for an unknown cid or a rejected token", async () => {
    const { call, pushed } = direct(h);
    expect(await call(path("T", "unknown"))).toEqual({ status: 200, body: { status: "ignored", reason: "unknown_click" }, scheduled: [] });
    expect(await call(path("wrong"))).toMatchObject({ status: 401, scheduled: [] });
    expect(pushed).toEqual([]);
  });

  it("pushes nothing without an ExecutionContext and still answers accepted", async () => {
    const { call, pushed } = direct(h);
    expect(await call(path(), false)).toEqual({ status: 200, body: { status: "accepted", lead_id: "lead-1" }, scheduled: [] });
    expect(pushed).toEqual([]);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 1 });
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 1 });
  });

  it.each([
    ["the lead SELECT throws", async (h: Harness) => direct(h, (sql) => {
      if (sql.includes("SELECT session_id, brand, hostname")) throw new Error("d1 down");
    })],
    ["the event fails TrafficTailEvent.parse", async (h: Harness) => {
      await h.db.prepare("UPDATE leads SET hostname = 'not a host' WHERE lead_id = 'lead-1'").run();
      return direct(h);
    }],
  ])("keeps the response and logs one warning when %s", async (_label, setup) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { call, pushed } = await setup(h);
      expect(await call(path())).toEqual({ status: 200, body: { status: "accepted", lead_id: "lead-1" },
        scheduled: [{ status: "fulfilled", value: undefined }] });
      expect(pushed).toEqual([]);
      expect(warn.mock.calls).toEqual([["postback_tail_publish_failed"]]);
    } finally { warn.mockRestore(); }
  });
});

describe("a tail push that hangs", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness({ trafficTail: "hanging" }); await h.seedBrand(); await h.seedLead(); });
  afterAll(async () => { await h?.mf.dispose(); });

  it("does not hold the response or the D1 writes", async () => {
    const namespace = await h.mf.getDurableObjectNamespace("TRAFFIC_TAIL", "production");
    const stub = namespace.get(namespace.idFromName("tail"));
    const state = async () => (await (await stub.fetch("https://tail.internal/state")).json()) as { received: number; released: boolean };
    const started = Date.now();
    const response = await h.request(path());
    const elapsed = Date.now() - started;
    expect(await response.json()).toEqual({ status: "accepted", lead_id: "lead-1" });
    // pushTail gives up on a push after 1500 ms, so a handler that awaited the held push would answer after that.
    expect(elapsed).toBeLessThan(1000);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 1 });
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 1 });
    for (const deadline = Date.now() + 3000; (await state()).received === 0 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await state()).toEqual({ received: 1, released: false });
    expect(await (await stub.fetch("https://tail.internal/release")).json()).toEqual({ received: 1, released: true });
  });
});

describe("postback responses and writes do not depend on the tail", () => {
  const harnesses: Record<"tail" | "none" | "throwing", Harness> = {} as never;
  beforeAll(async () => {
    [harnesses.tail, harnesses.none, harnesses.throwing] = await Promise.all([
      createHarness({ trafficTail: true }), createHarness(), createHarness({ trafficTail: "throwing" }),
    ]);
  });
  afterAll(async () => { await Promise.all(Object.values(harnesses).map((h) => h?.mf.dispose())); });

  // Timestamps follow the clock and row ids follow earlier runs on the same database; every other column must match.
  const stableColumns = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id" && !key.endsWith("_at"))));
  /** A sold postback, its replay, and a $0 newLead, on a fresh database. */
  async function run(h: Harness) {
    await h.reset(); await h.seedBrand();
    await h.seedLead("lead-1", "abc123", "brand-a", { gclid: "click-1" });
    await h.seedLead("lead-2", "def456");
    const responses = [];
    for (const url of [path(), path(), path("T", "def456", "newLead", 0)]) {
      const response = await h.request(url);
      responses.push({ status: response.status, body: await response.json() });
    }
    const rows = async (sql: string) => stableColumns((await h.db.prepare(sql).all<Record<string, unknown>>()).results);
    return { responses, postback_events: await rows("SELECT * FROM postback_events ORDER BY lead_id"),
      conversion_uploads: await rows("SELECT * FROM conversion_uploads ORDER BY lead_id"),
      leads: await rows("SELECT lead_id, status FROM leads ORDER BY lead_id") };
  }

  it("answers and writes the same with no tail binding and with a tail whose fetch throws", async () => {
    const baseline = await run(harnesses.tail);
    expect(baseline.responses).toEqual([
      { status: 200, body: { status: "accepted", lead_id: "lead-1" } },
      { status: 200, body: { status: "duplicate", lead_id: "lead-1" } },
      { status: 200, body: { status: "accepted", lead_id: "lead-2" } },
    ]);
    expect(baseline.postback_events).toHaveLength(2);
    expect(await run(harnesses.none)).toEqual(baseline);
    expect(await run(harnesses.throwing)).toEqual(baseline);
  });

  it("writes the same conversion_uploads row with and without the tail binding", async () => {
    const withTail = (await run(harnesses.tail)).conversion_uploads;
    expect(withTail).toMatchObject([{ lead_id: "lead-1", gclid: "click-1", value: 25, currency: "USD", status: "pending" }]);
    expect((await run(harnesses.none)).conversion_uploads).toEqual(withTail);
  });
});
