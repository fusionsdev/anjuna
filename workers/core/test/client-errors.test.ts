// spec traffic
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClientErrorsResponse, type AdminRequestContext, type AdminRole, type ClientErrorsQuery, type TrafficLogPeriod,
} from "@anjuna/contracts";
import { loadClientErrors } from "../src/admin/client-errors.js";
import { sessionRef } from "../src/admin/traffic-log.js";
import { createHarness, ROOT, type Harness } from "./helpers.js";

let h: Harness;
const employee: AdminRequestContext = { actor_id: "usr_emp_01", actor_role: "employee", request_id: "req_01HZX9K2M4N6P8Q1" };
const now = new Date("2026-11-02T12:00:00.000Z");
const load = (query: Partial<ClientErrorsQuery> = {}, role: AdminRole = "owner") =>
  loadClientErrors({ LEADS: h.db as unknown as D1Database }, { period: "7d" as TrafficLogPeriod, ...query }, role, now);

interface Seed { session: string | null; type: string; at: string; message?: string | null; screen?: string | null }
const errorRow = (e: Seed) => h.db.prepare(`INSERT INTO client_errors (session_id, error_type, error_message, screen_id, occurred_at)
  VALUES (?1, ?2, ?3, ?4, ?5)`).bind(e.session, e.type, e.message ?? null, e.screen ?? null, e.at);
const seedErrors = (errors: Seed[]) => h.db.batch(errors.map(errorRow));
const traffic = (session: string, host: string) => h.db.prepare(`INSERT INTO traffic_events
  (event_type, session_id, hostname, occurred_at, created_at) VALUES ('landing_viewed', ?1, ?2, '2026-11-02T08:00:00.000Z', '2026-11-02T08:00:00.000Z')`)
  .bind(session, host);

async function seedFixture() {
  await h.reset();
  await h.seedBrand("brand-a");
  await h.seedBrand("brand-b");
  await h.db.batch([
    traffic("s-a", "brand-a.example"),
    traffic("s-b", "brand-b.example"),
    // A session seen on two hosts resolves to the lowest host.
    traffic("s-two", "brand-b.example"),
    traffic("s-two", "brand-a.example"),
  ]);
  await seedErrors([
    { session: "s-a", type: "submission_error", at: "2026-11-02T09:00:00.000Z", message: "Failed to fetch", screen: "step-3" },
    { session: "s-a", type: "timeout", at: "2026-11-02T09:01:00.000Z", message: "slow", screen: "" },
    { session: "s-b", type: "timeout", at: "2026-11-02T09:02:00.000Z", message: "slow b" },
    { session: "s-none", type: "timeout", at: "2026-11-02T09:03:00.000Z", message: "no traffic" },
    { session: "", type: "submission_error", at: "2026-11-02T09:04:00.000Z", message: "" },
    { session: "s-a", type: "old_error", at: "2026-10-10T09:00:00.000Z" },
    { session: "s-a", type: "garbled_time", at: "not-a-date" },
    { session: "s-two", type: "timeout", at: "2026-11-02T09:05:00.000Z" },
  ]);
}

beforeAll(async () => {
  h = await createHarness();
  await seedFixture();
});
afterAll(async () => { await h?.mf.dispose(); });

describe("client errors D1 reads", () => {
  it("resolves the brand through the session", async () => {
    const { rows } = await load();
    const forA = rows.filter((row) => row.error_type === "submission_error" && row.hostname === "brand-a.example");
    expect(forA).toHaveLength(1);
    expect(forA[0]).toMatchObject({ brand_id: "brand-a", hostname: "brand-a.example", error_message: "Failed to fetch", screen_id: "step-3" });
    const none = rows.find((row) => row.error_message === "no traffic")!;
    expect(none).toMatchObject({ hostname: null, brand_id: null });
    const two = rows.find((row) => row.hostname === "brand-a.example" && row.error_type === "timeout" && row.error_message === null)!;
    expect(two.brand_id).toBe("brand-a");
  });

  it("filters by brand, type and period", async () => {
    const brandA = await load({ brand_id: "brand-a" });
    expect(brandA.rows.map((row) => row.brand_id)).toEqual(["brand-a", "brand-a", "brand-a"]);
    expect(brandA.rows.every((row) => row.session_ref !== null)).toBe(true);

    const timeouts = await load({ error_type: "timeout" });
    expect(timeouts.rows).toHaveLength(4);
    expect(timeouts.rows.every((row) => row.error_type === "timeout")).toBe(true);

    const all = await load();
    const types = all.rows.map((row) => row.error_type);
    expect(types).not.toContain("old_error");
    expect(types).not.toContain("garbled_time");
    expect(all.rows).toHaveLength(6);
    const month = await loadClientErrors({ LEADS: h.db as unknown as D1Database }, { period: "30d" }, "owner", now);
    expect(month.rows.map((row) => row.error_type)).toContain("old_error");
    expect(month.rows.map((row) => row.error_type)).not.toContain("garbled_time");
    expect(await load({ brand_id: "brand-c" })).toMatchObject({ rows: [], counts: [] });
  });

  it("counts per type ignore the type filter and follow the brand filter", async () => {
    const typed = await load({ error_type: "timeout" });
    expect(typed.counts).toEqual([{ error_type: "timeout", count: 4 }, { error_type: "submission_error", count: 2 }]);
    const brandB = await load({ brand_id: "brand-b" });
    expect(brandB.counts).toEqual([{ error_type: "timeout", count: 1 }]);
    const brandA = await load({ brand_id: "brand-a" });
    expect(brandA.counts).toEqual([{ error_type: "timeout", count: 2 }, { error_type: "submission_error", count: 1 }]);
  });

  it("hides error_message from an employee", async () => {
    const owner = await load({ brand_id: "brand-a", error_type: "submission_error" }, "owner");
    expect(owner.rows[0]!.error_message).toBe("Failed to fetch");
    const staff = await load({ brand_id: "brand-a", error_type: "submission_error" }, "employee");
    expect(staff.rows[0]).toMatchObject({ id: owner.rows[0]!.id, error_message: null });
    expect(JSON.stringify(await load({}, "employee"))).not.toContain("Failed to fetch");
    // An owner sees an empty message as it was stored.
    expect((await load({}, "owner")).rows.find((row) => row.session_ref === null)!.error_message).toBe("");
  });

  it("session_ref matches the traffic report ref", async () => {
    const { rows } = await load();
    const row = rows.find((r) => r.error_message === "Failed to fetch")!;
    expect(row.session_ref).toBe(await sessionRef("brand-a.example", "s-a"));
    expect(row.session_ref).toMatch(/^[0-9a-f]{12}$/);
    const orphan = rows.find((r) => r.error_message === "no traffic")!;
    expect(orphan.session_ref).toBe(await sessionRef(null, "s-none"));
    expect(rows.find((r) => r.error_type === "submission_error" && r.error_message === "")!.session_ref).toBeNull();
    expect(row.screen_id).toBe("step-3");
    expect(rows.find((r) => r.error_message === "slow")!.screen_id).toBeNull();
  });

  it("the admin route answers an employee and rejects a bad cursor", async () => {
    const response = await h.admin("/admin/client-errors?period=7d", employee);
    expect(response.status).toBe(200);
    const body = ClientErrorsResponse.parse(await response.json());
    expect(body.period).toBe("7d");
    expect(body.rows.every((row) => row.error_message === null)).toBe(true);
    expect((await h.admin("/admin/client-errors?period=7d&cursor=0", employee)).status).toBe(422);
    expect((await h.admin("/admin/client-errors?period=today", employee)).status).toBe(422);
    expect((await h.admin("/admin/client-errors?period=7d&sql=1", employee)).status).toBe(422);
  });

  it("new core read modules hold only SELECT statements", () => {
    // The scan covers the whole file text, comments included, so no comment may name a write keyword.
    for (const file of ["src/admin/traffic-log.ts", "src/admin/client-errors.ts"]) {
      const text = readFileSync(join(ROOT, "workers/core", file), "utf8");
      expect(text, file).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i);
    }
  });
});

describe("client errors paging", () => {
  it("pages 50 rows newest first with an id cursor", async () => {
    await h.reset();
    await h.seedBrand("brand-a");
    await seedErrors(Array.from({ length: 51 }, (_, i) => ({
      session: "", type: "timeout", at: new Date(Date.parse("2026-11-02T00:00:00.000Z") + i * 1000).toISOString(),
    })));
    const first = await load({}, "owner");
    expect(first.rows).toHaveLength(50);
    const ids = first.rows.map((row) => row.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(first.next_cursor).toBe(String(ids[49]));
    expect(first.counts).toEqual([{ error_type: "timeout", count: 51 }]);

    const second = await load({ cursor: first.next_cursor! }, "owner");
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).toBeLessThan(ids[49]!);
    expect(second.next_cursor).toBeNull();
    expect(second.counts).toEqual([{ error_type: "timeout", count: 51 }]);
  });

  it("returns no cursor for exactly 50 rows", async () => {
    await h.reset();
    await seedErrors(Array.from({ length: 50 }, () => ({ session: "", type: "timeout", at: "2026-11-02T01:00:00.000Z" })));
    const page = await load();
    expect(page.rows).toHaveLength(50);
    expect(page.next_cursor).toBeNull();
  });

  it("lists at most 50 types in counts", async () => {
    await h.reset();
    await seedErrors(Array.from({ length: 55 }, (_, i) => ({
      session: "", type: `type-${String(i).padStart(2, "0")}`, at: "2026-11-02T01:00:00.000Z",
    })));
    const page = await load();
    expect(page.counts).toHaveLength(50);
    expect(page.counts[0]).toEqual({ error_type: "type-00", count: 1 });
  });
});
