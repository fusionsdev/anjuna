import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
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