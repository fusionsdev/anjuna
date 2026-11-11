import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  D1FunnelEvents,
  FunnelReport,
  InMemoryFunnelEvents,
  funnelReport,
} from "../src/index";
import {
  insertBrandRuntime,
  insertClick,
  insertLead,
  insertPostback,
} from "./seed";

const FROM = "2026-10-01T00:00:00.000Z";
const TO = "2026-10-02T00:00:00.000Z";

const EVENTS = new InMemoryFunnelEvents([
  { brand: "brand-a", keyword: "loans", variant: "A", form_views: 3, go_count: 2 },
  { brand: "brand-a", keyword: "loans", variant: "B", form_views: 1, go_count: 1 },
  { brand: "brand-a", keyword: "cash", variant: "B", form_views: 1, go_count: 1 },
  { brand: "brand-b", keyword: "loans", variant: "A", form_views: 1, go_count: 1 },
]);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);

  await env.DB.batch([
    insertBrandRuntime(env.DB, "brand-a", ["a.test"]),
    insertBrandRuntime(env.DB, "brand-b", ["b.test"]),
    // Clicks. brand-a has 5 (2 loans/A, 1 loans/B, 1 cash/B, 1 untagged); brand-b has 1.
    insertClick(env.DB, { id: "cs1", hostname: "a.test", variant: "A", keyword: "loans", seen_at: "2026-10-01T10:00:00.000Z" }),
    insertClick(env.DB, { id: "cs2", hostname: "a.test", variant: "A", keyword: "loans", seen_at: "2026-10-01T11:00:00.000Z" }),
    insertClick(env.DB, { id: "cs3", hostname: "a.test", variant: "B", keyword: "loans", seen_at: "2026-10-01T12:00:00.000Z" }),
    insertClick(env.DB, { id: "cs4", hostname: "a.test", variant: "B", keyword: "cash", seen_at: "2026-10-01T12:00:00.000Z" }),
    insertClick(env.DB, { id: "cs5", hostname: "a.test", variant: null, keyword: null, seen_at: "2026-10-01T13:00:00.000Z" }),
    insertClick(env.DB, { id: "cs6", hostname: "b.test", variant: "A", keyword: "loans", seen_at: "2026-10-01T10:00:00.000Z" }),
    // Leads (submits).
    insertLead(env.DB, { lead_id: "lead-1", brand: "brand-a", variant: "A", keyword: "loans", created_at: "2026-10-01T10:30:00.000Z" }),
    insertLead(env.DB, { lead_id: "lead-2", brand: "brand-a", variant: "A", keyword: "loans", created_at: "2026-10-01T11:30:00.000Z" }),
    insertLead(env.DB, { lead_id: "lead-3", brand: "brand-a", variant: "B", keyword: "loans", created_at: "2026-10-01T12:30:00.000Z" }),
    insertLead(env.DB, { lead_id: "lead-4", brand: "brand-b", variant: "A", keyword: "loans", created_at: "2026-10-01T12:00:00.000Z" }),
    // Sold postbacks. lead-2 payout 300 clamps to 230; lead-3 payout 0 is not a sale.
    insertPostback(env.DB, { lead_id: "lead-1", event_type: "soldLead", payout: 100, created_at: "2026-10-01T14:00:00.000Z" }),
    insertPostback(env.DB, { lead_id: "lead-2", event_type: "soldLead", payout: 300, created_at: "2026-10-01T14:00:00.000Z" }),
    insertPostback(env.DB, { lead_id: "lead-3", event_type: "soldLead", payout: 0, created_at: "2026-10-01T14:00:00.000Z" }),
    insertPostback(env.DB, { lead_id: "lead-4", event_type: "soldLead", payout: 50, created_at: "2026-10-01T14:00:00.000Z" }),
  ]);
});

describe("funnelReport", () => {
  it("groups by brand x keyword x variant with exact counts, rates and 230-clamped revenue", async () => {
    const report = await funnelReport(env.DB, EVENTS, { from: FROM, to: TO });

    expect(report).toEqual({
      from: FROM,
      to: TO,
      rows: [
        { brand: "brand-a", keyword: null, variant: null, clicks: 1, go_count: 0, form_views: 0, submits: 0, sold: 0, revenue: 0, submit_rate: 0, sold_rate: null },
        { brand: "brand-a", keyword: "cash", variant: "B", clicks: 1, go_count: 1, form_views: 1, submits: 0, sold: 0, revenue: 0, submit_rate: 0, sold_rate: null },
        { brand: "brand-a", keyword: "loans", variant: "A", clicks: 2, go_count: 2, form_views: 3, submits: 2, sold: 2, revenue: 330, submit_rate: 1, sold_rate: 1 },
        { brand: "brand-a", keyword: "loans", variant: "B", clicks: 1, go_count: 1, form_views: 1, submits: 1, sold: 0, revenue: 0, submit_rate: 1, sold_rate: 0 },
        { brand: "brand-b", keyword: "loans", variant: "A", clicks: 1, go_count: 1, form_views: 1, submits: 1, sold: 1, revenue: 50, submit_rate: 1, sold_rate: 1 },
      ],
    });

    // The output is itself a Zod schema, so this re-validate is a no-op assertion.
    expect(FunnelReport.safeParse(report).success).toBe(true);
  });

  it("filters on brand", async () => {
    const report = await funnelReport(env.DB, EVENTS, { from: FROM, to: TO, brand: "brand-a" });
    expect(report.rows.map((r) => r.brand)).toEqual(["brand-a", "brand-a", "brand-a", "brand-a"]);
  });

  it("filters on keyword", async () => {
    const report = await funnelReport(env.DB, EVENTS, { from: FROM, to: TO, keyword: "loans" });
    expect(report.rows.map((r) => `${r.brand}/${r.keyword}/${r.variant}`)).toEqual([
      "brand-a/loans/A",
      "brand-a/loans/B",
      "brand-b/loans/A",
    ]);
  });

  it("filters on variant", async () => {
    const report = await funnelReport(env.DB, EVENTS, { from: FROM, to: TO, variant: "B" });
    expect(report.rows.map((r) => `${r.brand}/${r.keyword}/${r.variant}`)).toEqual([
      "brand-a/cash/B",
      "brand-a/loans/B",
    ]);
  });

  it("rejects a from/to window where from is not before to", async () => {
    await expect(funnelReport(env.DB, EVENTS, { from: TO, to: FROM })).rejects.toThrow(/from must be before to/);
  });
});

describe("D1FunnelEvents.counts", () => {
  const key = (r: { brand: string; keyword: string | null; variant: string | null; go_count: number }) =>
    `${r.brand}/${r.keyword}/${r.variant}=${r.go_count}`;

  beforeAll(async () => {
    // Reseed click_sessions with /go hits only; brand_runtime (a.test, b.test) survives the delete.
    await env.DB.prepare("DELETE FROM click_sessions").run();
    const go = (id: string, hostname: string, variant: string | null, keyword: string | null, seen_at: string, path = "/go") =>
      env.DB
        .prepare(
          `INSERT INTO click_sessions
            (click_session_id, landing_path, hostname, variant, keyword, click_seen_at, first_seen_at, last_seen_at, created_at)
           VALUES (?1, ?6, ?2, ?3, ?4, ?5, ?5, ?5, ?5)`,
        )
        .bind(id, hostname, variant, keyword, seen_at, path);
    await env.DB.batch([
      go("go1", "a.test", "A", "loans", "2026-10-01T10:00:00.000Z"),
      go("go2", "a.test", "A", "loans", "2026-10-01T11:00:00.000Z"),
      go("go3", "a.test", "B", "cash", "2026-10-01T12:00:00.000Z"),
      go("go4", "b.test", "A", "loans", "2026-10-01T10:00:00.000Z"),
      // Must NOT count: landing_path is not /go, and a /go hit outside the window.
      go("nc1", "a.test", "A", "loans", "2026-10-01T13:00:00.000Z", "/apply"),
      go("nc2", "a.test", "A", "loans", "2026-09-30T10:00:00.000Z"),
    ]);
  });

  it("counts /go hits grouped by brand x keyword x variant, excluding non-/go and out-of-window rows", async () => {
    const rows = await new D1FunnelEvents(env.DB).counts({ from: FROM, to: TO });
    expect(rows.map(key).sort()).toEqual([
      "brand-a/cash/B=1",
      "brand-a/loans/A=2",
      "brand-b/loans/A=1",
    ]);
    expect(rows.every((r) => r.form_views === 0)).toBe(true);
  });

  it("filters on brand, keyword and variant", async () => {
    const d1 = new D1FunnelEvents(env.DB);
    expect((await d1.counts({ from: FROM, to: TO, brand: "brand-b" })).map(key)).toEqual(["brand-b/loans/A=1"]);
    expect((await d1.counts({ from: FROM, to: TO, keyword: "cash" })).map(key)).toEqual(["brand-a/cash/B=1"]);
    expect((await d1.counts({ from: FROM, to: TO, variant: "A" })).map(key).sort()).toEqual([
      "brand-a/loans/A=2",
      "brand-b/loans/A=1",
    ]);
  });

  it("returns [] for a brand with no mapped hosts", async () => {
    expect(await new D1FunnelEvents(env.DB).counts({ from: FROM, to: TO, brand: "ghost" })).toEqual([]);
  });
});