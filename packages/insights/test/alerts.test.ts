import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AlertsReport,
  InMemorySubmitErrorCounts,
  RATE_ALERT_MIN_SAMPLE,
  RecordingNotifier,
  brandsWithoutPostbacks,
  clickRisk,
  conversionStalled,
  rejectRateByBrand,
  runAlerts,
  submitErrorRate,
} from "../src/index";
import { insertConversion, insertLead, insertPostback, truncateLeads } from "./seed";

const NOW = "2026-10-02T00:00:00.000Z";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
});

async function seedConversions() {
  const old = "2026-10-01T00:00:00.000Z";
  const fresh = "2026-10-01T20:00:00.000Z";
  await env.DB.batch([
    insertLead(env.DB, { lead_id: "conv-1", brand: "brand-c", variant: null, keyword: null, created_at: old }),
    insertLead(env.DB, { lead_id: "conv-2", brand: "brand-c", variant: null, keyword: null, created_at: fresh }),
    insertLead(env.DB, { lead_id: "conv-3", brand: "brand-c", variant: null, keyword: null, created_at: old }),
    insertConversion(env.DB, { lead_id: "conv-1", status: "pending", occurred_at: old, created_at: old }),
    insertConversion(env.DB, { lead_id: "conv-2", status: "pending", occurred_at: fresh, created_at: fresh }),
    insertConversion(env.DB, { lead_id: "conv-3", status: "uploaded", occurred_at: old, created_at: old }),
  ]);
}

/** Insert `sold` soldLead and `reject` rejectLead decays for a brand (each on its own lead). */
async function seedDecisions(brand: string, sold: number, reject: number) {
  const stmts = [];
  let i = 0;
  for (const [type, count] of [
    ["soldLead", sold],
    ["rejectLead", reject],
  ] as const) {
    for (let k = 0; k < count; k++) {
      const leadId = `${brand}-lead-${i++}`;
      stmts.push(
        insertLead(env.DB, { lead_id: leadId, brand, variant: null, keyword: null, created_at: "2026-10-01T10:00:00.000Z" }),
      );
      stmts.push(
        insertPostback(env.DB, {
          lead_id: leadId,
          event_type: type,
          payout: type === "soldLead" ? 50 : 0,
          created_at: "2026-10-01T11:00:00.000Z",
        }),
      );
    }
  }
  await env.DB.batch(stmts);
}

describe("conversionStalled", () => {
  it("alerts when a pending upload is older than the default 6 hours", async () => {
    await truncateLeads(env.DB);
    await seedConversions();

    const r = await conversionStalled(env.DB, { now: NOW });
    expect(r).toEqual({
      state: "alert",
      detail: { max_hours: 6, stuck_count: 1, oldest_created_at: "2026-10-01T00:00:00.000Z" },
    });
  });

  it("stays ok when nothing is older than the threshold", async () => {
    await truncateLeads(env.DB);
    await seedConversions();

    const r = await conversionStalled(env.DB, { now: "2026-10-01T01:00:00.000Z" });
    expect(r).toEqual({ state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } });
  });

  it("honours a custom max_hours", async () => {
    await truncateLeads(env.DB);
    await seedConversions();

    const r = await conversionStalled(env.DB, { now: "2026-10-01T05:00:00.000Z", conversion_max_hours: 2 });
    expect(r).toEqual({
      state: "alert",
      detail: { max_hours: 2, stuck_count: 1, oldest_created_at: "2026-10-01T00:00:00.000Z" },
    });
  });
});

describe("brandsWithoutPostbacks", () => {
  it("flags a brand with leads but no postbacks in the window", async () => {
    await truncateLeads(env.DB);
    await env.DB.batch([
      insertLead(env.DB, { lead_id: "np-1", brand: "brand-x", variant: null, keyword: null, created_at: "2026-10-01T10:00:00.000Z" }),
      insertLead(env.DB, { lead_id: "np-2", brand: "brand-y", variant: null, keyword: null, created_at: "2026-10-01T10:00:00.000Z" }),
      insertPostback(env.DB, { lead_id: "np-2", event_type: "newLead", payout: 0, created_at: "2026-10-01T11:00:00.000Z" }),
    ]);

    const r = await brandsWithoutPostbacks(env.DB, { now: NOW });
    expect(r).toEqual({
      state: "alert",
      detail: { window_hours: 24, brands: [{ brand: "brand-x", leads: 1 }] },
    });
  });

  it("stays ok when every brand with leads has a postback", async () => {
    await truncateLeads(env.DB);
    await env.DB.batch([
      insertLead(env.DB, { lead_id: "np-3", brand: "brand-z", variant: null, keyword: null, created_at: "2026-10-01T10:00:00.000Z" }),
      insertPostback(env.DB, { lead_id: "np-3", event_type: "newLead", payout: 0, created_at: "2026-10-01T11:00:00.000Z" }),
    ]);

    const r = await brandsWithoutPostbacks(env.DB, { now: NOW });
    expect(r).toEqual({ state: "ok", detail: { window_hours: 24, brands: [] } });
  });

  it("ignores leads outside the window", async () => {
    await truncateLeads(env.DB);
    await env.DB.batch([
      insertLead(env.DB, { lead_id: "np-4", brand: "brand-old", variant: null, keyword: null, created_at: "2026-09-20T10:00:00.000Z" }),
    ]);

    const r = await brandsWithoutPostbacks(env.DB, { now: NOW });
    expect(r).toEqual({ state: "ok", detail: { window_hours: 24, brands: [] } });
  });
});

describe("submitErrorRate", () => {
  it("alerts when a brand is at or above the alert threshold", async () => {
    const source = new InMemorySubmitErrorCounts([
      { brand: "brand-a", submits: 90, errors: 10 }, // 0.10
      { brand: "brand-b", submits: 95, errors: 5 }, // 0.05
      { brand: "brand-c", submits: 100, errors: 0 }, // 0
    ]);

    const r = await submitErrorRate(source, { now: NOW });
    expect(r.state).toBe("alert");
    expect(r.detail).toEqual({
      window_hours: 24,
      warn_at: 0.05,
      alert_at: 0.1,
      samples: [
        { brand: "brand-a", submits: 90, errors: 10, rate: 0.1 },
        { brand: "brand-b", submits: 95, errors: 5, rate: 0.05 },
      ],
    });
  });

  it("warns when between warn and alert thresholds", async () => {
    const source = new InMemorySubmitErrorCounts([{ brand: "brand-a", submits: 95, errors: 5 }]);
    const r = await submitErrorRate(source, { now: NOW });
    expect(r.state).toBe("warn");
    expect(r.detail.samples).toEqual([{ brand: "brand-a", submits: 95, errors: 5, rate: 0.05 }]);
  });

  it("stays ok when under the threshold", async () => {
    const source = new InMemorySubmitErrorCounts([{ brand: "brand-a", submits: 99, errors: 1 }]);
    const r = await submitErrorRate(source, { now: NOW });
    expect(r.state).toBe("ok");
    expect(r.detail.samples).toEqual([]);
  });

  it("needs RATE_ALERT_MIN_SAMPLE attempts before a brand can warn or alert", async () => {
    expect(RATE_ALERT_MIN_SAMPLE).toBe(10);
    const source = new InMemorySubmitErrorCounts([
      { brand: "brand-small", submits: 0, errors: 9 }, // 100% of 9: below the floor
      { brand: "brand-edge", submits: 8, errors: 2 }, // 20% of 10: at the floor
    ]);
    const r = await submitErrorRate(source, { now: NOW });
    expect(r.state).toBe("alert");
    expect(r.detail.samples).toEqual([{ brand: "brand-edge", submits: 8, errors: 2, rate: 0.2 }]);
  });
});

describe("rejectRateByBrand", () => {
  it("alerts a brand whose reject rate exceeds the alert threshold", async () => {
    await truncateLeads(env.DB);
    await seedDecisions("brand-a", 7, 3); // rate 0.30
    await seedDecisions("brand-b", 9, 1); // rate 0.10

    const r = await rejectRateByBrand(env.DB, { now: NOW });
    expect(r.state).toBe("alert");
    expect(r.detail).toEqual({
      window_hours: 24,
      warn_at: 0.1,
      alert_at: 0.2,
      brands: [
        { brand: "brand-a", rejected: 3, decided: 10, rate: 0.3 },
        { brand: "brand-b", rejected: 1, decided: 10, rate: 0.1 },
      ],
    });
  });

  it("warns when between warn and alert thresholds", async () => {
    await truncateLeads(env.DB);
    await seedDecisions("brand-a", 9, 1); // rate 0.10

    const r = await rejectRateByBrand(env.DB, { now: NOW });
    expect(r.state).toBe("warn");
    expect(r.detail.brands).toEqual([{ brand: "brand-a", rejected: 1, decided: 10, rate: 0.1 }]);
  });

  it("stays ok when all reject rates are under the threshold", async () => {
    await truncateLeads(env.DB);
    await seedDecisions("brand-a", 19, 1); // rate 0.05

    const r = await rejectRateByBrand(env.DB, { now: NOW });
    expect(r.state).toBe("ok");
    expect(r.detail.brands).toEqual([]);
  });

  it("opens no alert below RATE_ALERT_MIN_SAMPLE decided leads", async () => {
    await truncateLeads(env.DB);
    await seedDecisions("brand-one", 0, 1); // 1 of 1: the production case
    await seedDecisions("brand-nine", 4, 5); // 5 of 9: still below the floor

    const r = await rejectRateByBrand(env.DB, { now: NOW });
    expect(r.state).toBe("ok");
    expect(r.detail.brands).toEqual([]);
  });

  it("alerts at exactly RATE_ALERT_MIN_SAMPLE decided leads", async () => {
    await truncateLeads(env.DB);
    await seedDecisions("brand-ten", 5, 5); // 5 of 10

    const r = await rejectRateByBrand(env.DB, { now: NOW });
    expect(r.state).toBe("alert");
    expect(r.detail.brands).toEqual([{ brand: "brand-ten", rejected: 5, decided: 10, rate: 0.5 }]);
  });
});

/** `visits` visits on `hostname`, the first `high` of them high risk (score 50, two events each). */
async function seedVisits(hostname: string, visits: number, high: number, created_at = "2026-10-01T10:00:00.000Z") {
  const stmt = env.DB.prepare(
    `INSERT INTO traffic_events (event_type, session_id, hostname, occurred_at, created_at, risk_score, risk_signals)
     VALUES ('landing_viewed', ?1, ?2, ?3, ?3, ?4, ?5)`,
  );
  const stmts = [];
  for (let i = 0; i < visits; i++) {
    const session = `${hostname}-${created_at}-${i}`;
    stmts.push(stmt.bind(session, hostname, created_at, 0, "[]"));
    stmts.push(i < high ? stmt.bind(session, hostname, created_at, 50, '["known_bot_ua"]') : stmt.bind(session, hostname, created_at, 20, '["timezone_geo_mismatch"]'));
  }
  await env.DB.batch(stmts);
}

describe("clickRisk", () => {
  it("alerts a hostname at 20% high-risk visits with at least 50 visits, and counts a visit once", async () => {
    await env.DB.prepare("DELETE FROM traffic_events").run();
    await seedVisits("a.example", 50, 10); // 20%: alert
    await seedVisits("b.example", 50, 9); // 18%: below the rate
    await seedVisits("c.example", 49, 49); // 100% of 49: below the visit floor
    await seedVisits("d.example", 100, 100, "2026-09-30T23:59:59.000Z"); // outside the 24-hour window

    const r = await clickRisk(env.DB, { now: NOW });
    expect(r).toEqual({
      state: "alert",
      detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [{ hostname: "a.example", visits: 50, high_risk: 10, rate: 0.2 }] },
    });
  });

  it("stays ok below the threshold and with no telemetry", async () => {
    await env.DB.prepare("DELETE FROM traffic_events").run();
    expect((await clickRisk(env.DB, { now: NOW })).state).toBe("ok");
    await seedVisits("b.example", 50, 9);
    await env.DB.prepare("INSERT INTO traffic_events (event_type, session_id, hostname, occurred_at, created_at) VALUES ('landing_viewed', 'legacy', 'b.example', ?1, ?1)").bind("2026-10-01T10:00:00.000Z").run();
    const r = await clickRisk(env.DB, { now: NOW });
    expect(r.state).toBe("ok");
    expect(r.detail.hostnames).toEqual([]);
  });
});

describe("runAlerts", () => {
  it("returns all five checks and validates against the report schema", async () => {
    await env.DB.prepare("DELETE FROM traffic_events").run();
    await seedVisits("risky.example", 60, 30);
    await truncateLeads(env.DB);
    await env.DB.batch([
      insertLead(env.DB, { lead_id: "ra-1", brand: "brand-nopb", variant: null, keyword: null, created_at: "2026-10-01T10:00:00.000Z" }),
      insertLead(env.DB, { lead_id: "ra-2", brand: "brand-conv", variant: null, keyword: null, created_at: "2026-10-01T00:00:00.000Z" }),
      insertConversion(env.DB, { lead_id: "ra-2", status: "pending", occurred_at: "2026-10-01T00:00:00.000Z", created_at: "2026-10-01T00:00:00.000Z" }),
    ]);
    await seedDecisions("brand-rej", 5, 5); // rate 0.50

    const report = await runAlerts(
      env.DB,
      { submitErrorCounts: new InMemorySubmitErrorCounts([{ brand: "brand-err", submits: 50, errors: 50 }]) },
      { now: NOW },
    );

    expect(report.generated_at).toBe(NOW);
    expect(report).toMatchObject({
      conversion_stalled: { state: "alert" },
      brands_without_postbacks: { state: "alert" },
      submit_error_rate: { state: "alert" },
      reject_rate: { state: "alert" },
      click_risk: { state: "alert" },
    });
    expect(AlertsReport.safeParse(report).success).toBe(true);

    const notifier = new RecordingNotifier();
    notifier.notify(report);
    expect(notifier.calls).toEqual([report]);
  });
});