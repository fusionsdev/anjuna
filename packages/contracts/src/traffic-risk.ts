/**
 * Observe-only click risk scoring (FUS-372), ported from V1 handleTelemetry.
 *
 * Core scores each telemetry event at ingest and stores `risk_score` and `risk_signals` on its
 * `traffic_events` row. The score never changes a response, a redirect or the lead flow (AGENTS.md
 * rule 3): every visitor sees the same page. The panel reads the totals and the owner exports the
 * high-risk gclids for a Google Ads refund request.
 */
import { z } from "zod";
import { Hostname } from "./common.js";

/**
 * V1 weights, provisional until 2 to 4 weeks of data exist. A signal id never changes once stored.
 * `label` is the panel text (Thai, as in the approved console mockup).
 */
export const RISK_SIGNALS = [
  { id: "known_bot_ua", label: "เครื่องดูเป็นบอท (user agent)", weight: 50 },
  { id: "timezone_geo_mismatch", label: "เขตเวลาไม่ตรงกับประเทศ", weight: 20 },
  { id: "rapid_repeat_session", label: "คลิกซ้ำถี่เกิน 25 ครั้ง/ชม.", weight: 30 },
] as const;
export type RiskSignalId = (typeof RISK_SIGNALS)[number]["id"];
export const RiskSignalId = z.enum(RISK_SIGNALS.map((s) => s.id) as [RiskSignalId, ...RiskSignalId[]]);

/** A visit is high risk when its highest event score reaches this. */
export const HIGH_RISK_SCORE = 50;
/** rapid_repeat_session fires on the 26th telemetry event from one IP hash within one clock hour (V1). */
export const RAPID_REPEAT_THRESHOLD = 25;
/** Hours in `TrafficRiskResponse.hours` are clock hours in this zone (the mockup's US Eastern chart). */
export const RISK_HOURS_TIMEZONE = "America/New_York";

export const RISK_PERIODS = ["today", "7d", "30d"] as const;
export const RiskPeriod = z.enum(RISK_PERIODS);
export type RiskPeriod = z.infer<typeof RiskPeriod>;

const Count = z.number().int().min(0);

/** GET /admin/traffic/risk. `today` starts at midnight US Eastern; 7d and 30d end now. */
export const TrafficRiskQuery = z.strictObject({
  period: RiskPeriod.default("7d"),
});
export type TrafficRiskQuery = z.infer<typeof TrafficRiskQuery>;

/** A visit is one telemetry `session_id`. `count` is visits that carried the signal at least once. */
export const TrafficRiskResponse = z.strictObject({
  signals: z.array(z.strictObject({ id: RiskSignalId, label: z.string().min(1), weight: Count, count: Count })),
  /** Every hostname with a visit in the period, most high-risk visits first. */
  domains: z.array(z.strictObject({ hostname: Hostname, visits: Count, high_risk: Count })),
  /** Always 24 entries, hour 0 to 23 in RISK_HOURS_TIMEZONE. */
  hours: z.array(z.strictObject({ hour: z.number().int().min(0).max(23), visits: Count, high_risk: Count })).length(24),
});
export type TrafficRiskResponse = z.infer<typeof TrafficRiskResponse>;

/** GET /admin/traffic/risk/export (owner only). */
export const TrafficRiskExportQuery = z.strictObject({
  period: RiskPeriod.default("7d"),
  hostname: Hostname.optional(),
});
export type TrafficRiskExportQuery = z.infer<typeof TrafficRiskExportQuery>;

/** Most rows one export returns; `truncated` says more existed. */
export const RISK_EXPORT_LIMIT = 10_000;

/**
 * One row per high-risk visit, newest first. `gclid` is null when the visit has no known click
 * (no `_vc` cookie and no lead). The panel turns this into the CSV the owner downloads.
 */
export const TrafficRiskExportResponse = z.strictObject({
  rows: z.array(z.strictObject({
    gclid: z.string().min(1).max(512).nullable(),
    hostname: Hostname,
    score: Count,
    signals: z.array(RiskSignalId),
    created_at: z.iso.datetime(),
  })),
  truncated: z.boolean(),
});
export type TrafficRiskExportResponse = z.infer<typeof TrafficRiskExportResponse>;

/** CSV columns of the panel export, in order. */
export const RISK_EXPORT_COLUMNS = ["gclid", "hostname", "score", "signals", "created_at"] as const;

// Alert rule (insights `clickRisk`): a hostname with at least this share of high-risk visits ...
export const CLICK_RISK_ALERT_AT = 0.2;
// ... over this many hours ...
export const CLICK_RISK_WINDOW_HOURS = 24;
// ... and at least this many visits, so a handful of bot hits on a quiet domain does not alert.
export const CLICK_RISK_MIN_VISITS = 50;
