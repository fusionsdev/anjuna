import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AckRequest,
  AckResponse,
  DRAIN_READS_ROW_FIELDS,
  DrainUnauthorized,
  encodeAckResponse,
  encodePendingResponse,
  PENDING_ROW_KEYS,
  PendingQuery,
  PendingResponse,
} from "../src/index.js";
import { fixture, fixtureText, PKG_DIR, runV1Drain } from "./helpers.js";

/** sha256 of drain/drain.mjs as stored in git at fusion_formv_v1@8404ec2 (blob e725e25). */
const V1_DRAIN_SHA256 = "09ea4de9898c15cf049c221198eca41213405b9d242c26976cce67ef0e9750a6";

const DRAIN_TOKEN = "test-drain-token-not-a-secret";

describe("drain contract: V1 drain.mjs is vendored unmodified", () => {
  it("test/v1/drain.mjs is byte-identical to V1 @ 8404ec2", () => {
    const bytes = readFileSync(join(PKG_DIR, "test", "v1", "drain.mjs"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V1_DRAIN_SHA256);
  });

  it("every row field drain.mjs reads is in the pending row", () => {
    const src = readFileSync(join(PKG_DIR, "test", "v1", "drain.mjs"), "utf8");
    const read = new Set([...src.matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual([...DRAIN_READS_ROW_FIELDS].sort());
    for (const f of read) expect(PENDING_ROW_KEYS as readonly string[]).toContain(f);
  });
});

describe("drain contract: GET /api/conversions/pending", () => {
  it("golden pending response parses", () => {
    const body = PendingResponse.parse(fixture("drain/pending.response.json"));
    expect(body.conversions).toHaveLength(4);
    for (const row of body.conversions) expect(Object.keys(row)).toEqual([...PENDING_ROW_KEYS]);
  });

  it("encodePendingResponse reproduces the V1 bytes exactly", () => {
    for (const f of ["drain/pending.response.json", "drain/pending.response.empty.json"]) {
      const raw = fixtureText(f);
      expect(encodePendingResponse(PendingResponse.parse(JSON.parse(raw)))).toBe(raw);
    }
  });

  it("encodePendingResponse restores V1 key order from any input order", () => {
    const row = PendingResponse.parse(fixture("drain/pending.response.json")).conversions[0]!;
    const shuffled = Object.fromEntries(Object.entries(row).reverse());
    const out = encodePendingResponse({ conversions: [shuffled as typeof row] });
    expect(Object.keys(JSON.parse(out).conversions[0])).toEqual([...PENDING_ROW_KEYS]);
  });

  it("brand and hostname are required keys (null allowed, absent not)", () => {
    const row = { ...PendingResponse.parse(fixture("drain/pending.response.json")).conversions[0]! } as Record<string, unknown>;
    delete row.brand;
    expect(PendingResponse.safeParse({ conversions: [row] }).success).toBe(false);
    expect(PendingResponse.safeParse({ conversions: [{ ...row, brand: null }] }).success).toBe(true);
  });

  it("rejects extra columns so core cannot drift from V1", () => {
    const row = PendingResponse.parse(fixture("drain/pending.response.json")).conversions[0]!;
    expect(PendingResponse.safeParse({ conversions: [{ ...row, status: "processing" }] }).success).toBe(false);
  });

  it("query parsing follows V1: NaN -> 100, clamp 1..500, peek only when '1'", () => {
    expect(PendingQuery.parse({})).toEqual({ limit: 100, peek: false });
    expect(PendingQuery.parse({ limit: "NaN" })).toEqual({ limit: 100, peek: false });
    expect(PendingQuery.parse({ limit: "0" })).toEqual({ limit: 1, peek: false });
    expect(PendingQuery.parse({ limit: "9999", peek: "1" })).toEqual({ limit: 500, peek: true });
    expect(PendingQuery.parse({ limit: "50", peek: "true" })).toEqual({ limit: 50, peek: false });
  });

  it("401 body matches V1", () => {
    expect(DrainUnauthorized.parse(fixture("drain/unauthorized.response.json"))).toEqual({ status: "invalid", message: "Unauthorized" });
  });
});

describe("drain contract: POST /api/conversions/ack", () => {
  it("golden ack requests parse", () => {
    expect(AckRequest.parse(fixture("drain/ack.request.json")).results).toHaveLength(4);
    expect(AckRequest.parse(fixture("drain/ack.request.mixed.json")).results.map((r) => r.status)).toEqual(["uploaded", "failed", "deferred"]);
  });

  it("the drain never sends 'skipped' (it maps skipped to 'deferred')", () => {
    expect(AckRequest.safeParse({ results: [{ lead_id: "x", status: "skipped" }] }).success).toBe(false);
  });

  it("encodeAckResponse reproduces the V1 bytes", () => {
    expect(encodeAckResponse(4)).toBe(fixtureText("drain/ack.response.json"));
    expect(AckResponse.parse(fixture("drain/ack.response.json")).acked).toBe(4);
  });
});

describe("drain contract: the real V1 drain.mjs consumes the golden fixtures", () => {
  it("claiming run: reads brand + hostname, acks deferred/failed exactly as the golden ack", async () => {
    const run = await runV1Drain({
      pendingBody: fixtureText("drain/pending.response.json"),
      ackBody: fixtureText("drain/ack.response.json"),
      // Per-brand routing on with an empty map: every Google row is unroutable (skipped ->
      // deferred) and Microsoft rows fail on missing env, so adkit is never invoked.
      env: { DRAIN_TOKEN, BRAND_ROUTING_JSON: "{}", DRAIN_LIMIT: "25" },
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.requests).toHaveLength(2);

    const [pending, ack] = run.requests;
    expect(pending!.method).toBe("GET");
    expect(pending!.url).toBe("/api/conversions/pending?limit=25");
    expect(pending!.authorization).toBe(`Bearer ${DRAIN_TOKEN}`);

    expect(ack!.method).toBe("POST");
    expect(ack!.url).toBe("/api/conversions/ack");
    expect(ack!.authorization).toBe(`Bearer ${DRAIN_TOKEN}`);
    expect(ack!.contentType).toBe("application/json");
    expect(ack!.body).toBe(fixtureText("drain/ack.request.json"));
    expect(AckRequest.safeParse(JSON.parse(ack!.body)).success).toBe(true);

    expect(run.stdout).toContain("uploaded=0 failed=1 skipped=3 acked=4");
  });

  it("validate-only run: sends peek=1 and does not ack", async () => {
    const run = await runV1Drain({
      pendingBody: fixtureText("drain/pending.response.json"),
      ackBody: fixtureText("drain/ack.response.json"),
      env: { DRAIN_TOKEN, BRAND_ROUTING_JSON: "{}", DRAIN_VALIDATE_ONLY: "true" },
    });
    expect(run.code).toBe(0);
    expect(run.requests.map((r) => r.url)).toEqual(["/api/conversions/pending?limit=50&peek=1"]);
    expect(run.stdout).toContain("validate-only: uploaded=0 failed=1 skipped=3");
  });

  it("empty queue: no ack call", async () => {
    const run = await runV1Drain({
      pendingBody: fixtureText("drain/pending.response.empty.json"),
      ackBody: fixtureText("drain/ack.response.json"),
      env: { DRAIN_TOKEN },
    });
    expect(run.code).toBe(0);
    expect(run.requests).toHaveLength(1);
    expect(run.stdout).toContain("no pending conversions");
  });
});
