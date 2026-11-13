/**
 * Alerts (FA-5): four pure checks over the `leads` D1 plus one interface-backed count source.
 *
 * Each alert is a pure function that returns `{state, detail}` for a single clock instant
 * (`now`, passed in explicitly so the checks are deterministic). `runAlerts` fans them out.
 *
 * - conversion staleness   : a `conversion_uploads` row still pending after N hours (default 6).
 * - brands without postbacks: a brand with leads but no postback in the last 24 hours.
 * - submit error rate      : counts come from a `SubmitErrorCountsSource` (Analytics Engine later).
 * - reject rate per brand  : `postback_events` of type rejectLead, per brand.
 * - click risk per hostname: share of high-risk visits in `traffic_events` (FUS-372, observe-only).
 *
 * Everything here is read-only.
 */
import {
  CLICK_RISK_ALERT_AT,
  CLICK_RISK_MIN_VISITS,
  CLICK_RISK_WINDOW_HOURS,
  HIGH_RISK_SCORE,
} from "@anjuna/contracts";
import { z } from "zod";

const Timestamp = z.iso.datetime();
const Count = z.number().int().min(0);
const HOUR_MS = 3_600_000;

export const AlertState = z.enum(["ok", "warn", "alert"]);
export type AlertState = z.infer<typeof AlertState>;

function hoursBefore(now: string, hours: number): string {
  return new Date(Date.parse(now) - hours * HOUR_MS).toISOString();
}

// --- config -----------------------------------------------------------------------------------

export const DEFAULT_CONVERSION_MAX_HOURS = 6;
export const DEFAULT_NO_POSTBACK_WINDOW_HOURS = 24;
export const DEFAULT_SUBMIT_ERROR_WINDOW_HOURS = 24;
export const DEFAULT_SUBMIT_ERROR_WARN_AT = 0.05;
export const DEFAULT_SUBMIT_ERROR_ALERT_AT = 0.1;
export const DEFAULT_REJECT_WINDOW_HOURS = 24;
export const DEFAULT_REJECT_WARN_AT = 0.1;
export const DEFAULT_REJECT_ALERT_AT = 0.2;
/**
 * A percentage alert (reject rate, submit error rate) needs at least this many leads in its window.
 * Below it a brand produces no row, so 1 reject out of 1 never opens an alert.
 */
export const RATE_ALERT_MIN_SAMPLE = 10;

export const AlertsConfig = z.strictObject({
  /** The "as of" instant all alerts evaluate against (ISO-8601). */
  now: Timestamp,
  conversion_max_hours: z.number().positive().optional(),
  no_postback_window_hours: z.number().positive().optional(),
  submit_error_window_hours: z.number().positive().optional(),
  submit_error_warn_at: z.number().min(0).optional(),
  submit_error_alert_at: z.number().min(0).optional(),
  reject_window_hours: z.number().positive().optional(),
  reject_warn_at: z.number().min(0).optional(),
  reject_alert_at: z.number().min(0).optional(),
  click_risk_window_hours: z.number().positive().optional(),
  click_risk_alert_at: z.number().min(0).max(1).optional(),
  click_risk_min_visits: z.number().int().min(0).optional(),
});
export type AlertsConfig = z.infer<typeof AlertsConfig>;

// --- alert 1: conversion staleness ------------------------------------------------------------

export const ConversionStalledResult = z.strictObject({
  state: AlertState,
  detail: z.strictObject({
    max_hours: z.number().positive(),
    stuck_count: Count,
    oldest_created_at: Timestamp.nullable(),
  }),
});
export type ConversionStalledResult = z.infer<typeof ConversionStalledResult>;

/**
 * True alert when any `conversion_uploads` row is still `pending` after `max_hours`. A row in
 * any other status (processing, uploaded, dead) is intentionally ignored here — the drain's own
 * lease reclaim handles `processing`, and this check flags rows the drain has not picked up.
 */
export async function conversionStalled(
  db: D1Database,
  config: AlertsConfig,
): Promise<ConversionStalledResult> {
  const maxHours = config.conversion_max_hours ?? DEFAULT_CONVERSION_MAX_HOURS;
  const cutoff = hoursBefore(config.now, maxHours);
  const { results } = await db
    .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM conversion_uploads WHERE status = 'pending' AND created_at < ?")
    .bind(cutoff)
    .all<{ n: number; oldest: string | null }>();
  const stuck = results[0]?.n ?? 0;
  const oldest = results[0]?.oldest ?? null;
  return {
    state: stuck > 0 ? "alert" : "ok",
    detail: { max_hours: maxHours, stuck_count: stuck, oldest_created_at: oldest },
  };
}

// --- alert 2: leads with no postback -----------------------------------------------------------

export const BrandsWithoutPostbacksResult = z.strictObject({
  state: AlertState,
  detail: z.strictObject({
    window_hours: z.number().positive(),
    brands: z.array(
      z.strictObject({
        brand: z.string().min(1),
        leads: Count,
      }),
    ),
  }),
});
export type BrandsWithoutPostbacksResult = z.infer<typeof BrandsWithoutPostbacksResult>;

/**
 * Flags every brand that produced leads in the last `window_hours` but received no postback
 * event in the same window. "Leads" and "postbacks" are both evaluated over the window so a
 * brand that has simply paused traffic does not fire forever.
 */
export async function brandsWithoutPostbacks(
  db: D1Database,
  config: AlertsConfig,
): Promise<BrandsWithoutPostbacksResult> {
  const windowHours = config.no_postback_window_hours ?? DEFAULT_NO_POSTBACK_WINDOW_HOURS;
  const from = hoursBefore(config.now, windowHours);

  const leads = await db
    .prepare("SELECT brand, COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ? GROUP BY brand")
    .bind(from, config.now)
    .all<{ brand: string; n: number }>();

  const postbacks = await db
    .prepare(
      "SELECT l.brand AS brand, COUNT(*) AS n FROM postback_events pe JOIN leads l ON l.lead_id = pe.lead_id WHERE pe.created_at >= ? AND pe.created_at < ? GROUP BY l.brand",
    )
    .bind(from, config.now)
    .all<{ brand: string; n: number }>();

  const hasPostback = new Set(postbacks.results.map((r) => r.brand));
  const brands = leads.results
    .filter((r) => r.n > 0 && !hasPostback.has(r.brand))
    .map((r) => ({ brand: r.brand, leads: r.n }))
    .sort((a, b) => (a.brand < b.brand ? -1 : a.brand > b.brand ? 1 : 0));

  return {
    state: brands.length > 0 ? "alert" : "ok",
    detail: { window_hours: windowHours, brands },
  };
}

// --- alert 3: submit error rate ---------------------------------------------------------------

export const ErrorRateSample = z.strictObject({
  brand: z.string().min(1),
  submits: Count,
  errors: Count,
  rate: z.number().finite().min(0).max(1),
});
export type ErrorRateSample = z.infer<typeof ErrorRateSample>;

export const SubmitErrorRateResult = z.strictObject({
  state: AlertState,
  detail: z.strictObject({
    window_hours: z.number().positive(),
    warn_at: z.number().min(0),
    alert_at: z.number().min(0),
    /** Brands at or above `warn_at`, worst first. Empty when everything is ok. */
    samples: z.array(ErrorRateSample),
  }),
});
export type SubmitErrorRateResult = z.infer<typeof SubmitErrorRateResult>;

/** Per-brand submit success / error counts, provided by an Analytics Engine source later. */
export interface SubmitErrorSample {
  brand: string;
  submits: number;
  errors: number;
}

/** Source of submit error counts. The real one filters by time; the fake is static. */
export interface SubmitErrorCountsSource {
  counts(args: { from: string; to: string; brand?: string }): Promise<readonly SubmitErrorSample[]>;
}

/** In-memory source for tests and local development (ignores the time window). */
export class InMemorySubmitErrorCounts implements SubmitErrorCountsSource {
  constructor(private readonly samples: readonly SubmitErrorSample[]) {}

  async counts(args: { from: string; to: string; brand?: string }): Promise<SubmitErrorSample[]> {
    return this.samples.filter((s) => args.brand === undefined || s.brand === args.brand);
  }
}

/**
 * rate = errors / (submits + errors). Brands at or above `warn_at` with at least RATE_ALERT_MIN_SAMPLE
 * attempts are reported, worst first.
 */
export async function submitErrorRate(
  source: SubmitErrorCountsSource,
  config: AlertsConfig,
): Promise<SubmitErrorRateResult> {
  const windowHours = config.submit_error_window_hours ?? DEFAULT_SUBMIT_ERROR_WINDOW_HOURS;
  const warnAt = config.submit_error_warn_at ?? DEFAULT_SUBMIT_ERROR_WARN_AT;
  const alertAt = config.submit_error_alert_at ?? DEFAULT_SUBMIT_ERROR_ALERT_AT;
  const from = hoursBefore(config.now, windowHours);

  const counts = await source.counts({ from, to: config.now });
  const samples = counts
    .map((c) => {
      const attempts = c.submits + c.errors;
      const rate = attempts > 0 ? c.errors / attempts : 0;
      return { brand: c.brand, submits: c.submits, errors: c.errors, rate };
    })
    .filter((s) => s.submits + s.errors >= RATE_ALERT_MIN_SAMPLE && s.rate >= warnAt)
    .sort((a, b) => b.rate - a.rate);

  const state = samples.some((s) => s.rate >= alertAt) ? "alert" : samples.length > 0 ? "warn" : "ok";
  return { state, detail: { window_hours: windowHours, warn_at: warnAt, alert_at: alertAt, samples } };
}

// --- alert 4: reject rate per brand -----------------------------------------------------------

export const RejectRateBrand = z.strictObject({
  brand: z.string().min(1),
  rejected: Count,
  decided: Count,
  rate: z.number().finite().min(0).max(1),
});
export type RejectRateBrand = z.infer<typeof RejectRateBrand>;

export const RejectRateResult = z.strictObject({
  state: AlertState,
  detail: z.strictObject({
    window_hours: z.number().positive(),
    warn_at: z.number().min(0),
    alert_at: z.number().min(0),
    /** Brands at or above `warn_at`, worst first. Empty when everything is ok. */
    brands: z.array(RejectRateBrand),
  }),
});
export type RejectRateResult = z.infer<typeof RejectRateResult>;

/**
 * Reject rate per brand over the last `window_hours`: rejected leads as a fraction of all
 * decided leads (those with a soldLead or rejectLead postback). A brand with fewer than
 * RATE_ALERT_MIN_SAMPLE decided leads in the window produces no row and cannot alert.
 */
export async function rejectRateByBrand(db: D1Database, config: AlertsConfig): Promise<RejectRateResult> {
  const windowHours = config.reject_window_hours ?? DEFAULT_REJECT_WINDOW_HOURS;
  const warnAt = config.reject_warn_at ?? DEFAULT_REJECT_WARN_AT;
  const alertAt = config.reject_alert_at ?? DEFAULT_REJECT_ALERT_AT;
  const from = hoursBefore(config.now, windowHours);

  const { results } = await db
    .prepare(
      `SELECT l.brand AS brand,
              SUM(CASE WHEN pe.event_type = 'rejectLead' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN pe.event_type IN ('soldLead', 'rejectLead') THEN 1 ELSE 0 END) AS decided
       FROM postback_events pe
       JOIN leads l ON l.lead_id = pe.lead_id
       WHERE pe.event_type IN ('soldLead', 'rejectLead') AND pe.created_at >= ? AND pe.created_at < ?
       GROUP BY l.brand`,
    )
    .bind(from, config.now)
    .all<{ brand: string; rejected: number; decided: number }>();

  const brands = results
    .map((r) => ({ brand: r.brand, rejected: r.rejected, decided: r.decided, rate: r.decided > 0 ? r.rejected / r.decided : 0 }))
    .filter((b) => b.decided >= RATE_ALERT_MIN_SAMPLE && b.rate >= warnAt)
    .sort((a, b) => b.rate - a.rate);

  const state = brands.some((b) => b.rate >= alertAt) ? "alert" : brands.length > 0 ? "warn" : "ok";
  return { state, detail: { window_hours: windowHours, warn_at: warnAt, alert_at: alertAt, brands } };
}

// --- alert 5: click risk per hostname (FUS-372) -----------------------------------------------

export const ClickRiskHostname = z.strictObject({
  hostname: z.string().min(1),
  visits: Count,
  high_risk: Count,
  rate: z.number().finite().min(0).max(1),
});
export type ClickRiskHostname = z.infer<typeof ClickRiskHostname>;

export const ClickRiskResult = z.strictObject({
  state: AlertState,
  detail: z.strictObject({
    window_hours: z.number().positive(),
    alert_at: z.number().min(0),
    min_visits: Count,
    /** Hostnames at or above `alert_at` with at least `min_visits` visits, worst first. */
    hostnames: z.array(ClickRiskHostname),
  }),
});
export type ClickRiskResult = z.infer<typeof ClickRiskResult>;

/**
 * A hostname alerts when at least `alert_at` (20%) of its visits in the last `window_hours` (24)
 * were high risk and it had at least `min_visits` (50) visits. A visit is one (session_id,
 * hostname); it is high risk when any of its events scored HIGH_RISK_SCORE or more. The score
 * is observe-only: this alert tells a person to look, nothing is blocked.
 */
export async function clickRisk(db: D1Database, config: AlertsConfig): Promise<ClickRiskResult> {
  const windowHours = config.click_risk_window_hours ?? CLICK_RISK_WINDOW_HOURS;
  const alertAt = config.click_risk_alert_at ?? CLICK_RISK_ALERT_AT;
  const minVisits = config.click_risk_min_visits ?? CLICK_RISK_MIN_VISITS;
  const from = hoursBefore(config.now, windowHours);

  const { results } = await db
    .prepare(
      `SELECT hostname, COUNT(*) AS visits, SUM(score >= ?3) AS high_risk FROM (
         SELECT hostname, MAX(COALESCE(risk_score, 0)) AS score
         FROM traffic_events
         WHERE created_at >= ?1 AND created_at < ?2 AND hostname IS NOT NULL
         GROUP BY session_id, hostname
       ) GROUP BY hostname`,
    )
    .bind(from, config.now, HIGH_RISK_SCORE)
    .all<{ hostname: string; visits: number; high_risk: number }>();

  const hostnames = results
    .map((r) => ({ hostname: r.hostname, visits: r.visits, high_risk: r.high_risk, rate: r.visits > 0 ? r.high_risk / r.visits : 0 }))
    .filter((h) => h.visits >= minVisits && h.rate >= alertAt)
    .sort((a, b) => b.rate - a.rate || (a.hostname < b.hostname ? -1 : 1));

  return {
    state: hostnames.length > 0 ? "alert" : "ok",
    detail: { window_hours: windowHours, alert_at: alertAt, min_visits: minVisits, hostnames },
  };
}

// --- combined ---------------------------------------------------------------------------------

export const AlertsReport = z.strictObject({
  generated_at: Timestamp,
  conversion_stalled: ConversionStalledResult,
  brands_without_postbacks: BrandsWithoutPostbacksResult,
  submit_error_rate: SubmitErrorRateResult,
  reject_rate: RejectRateResult,
  click_risk: ClickRiskResult,
});
export type AlertsReport = z.infer<typeof AlertsReport>;

/** The non-D1 inputs `runAlerts` needs: submit error counts for now. */
export interface AlertSources {
  submitErrorCounts: SubmitErrorCountsSource;
}

/** The alert delivery channel is not decided yet; every notifier just receives the report. */
export interface Notifier {
  notify(report: AlertsReport): Promise<void> | void;
}

/** Console notifier; the default until the real channel (Telegram, email, ...) is chosen. */
export class ConsoleNotifier implements Notifier {
  notify(report: AlertsReport): void {
    console.log(JSON.stringify(report));
  }
}

/** Fake notifier that records calls, for tests and local development. */
export class RecordingNotifier implements Notifier {
  readonly calls: AlertsReport[] = [];
  notify(report: AlertsReport): void {
    this.calls.push(report);
  }
}

/** Run all five alerts for one clock instant and return the combined, schema-validated report. */
export async function runAlerts(db: D1Database, sources: AlertSources, config: AlertsConfig): Promise<AlertsReport> {
  const cfg = AlertsConfig.parse(config);
  const [conversion_stalled, brands_without_postbacks, submit_error_rate, reject_rate, click_risk] = await Promise.all([
    conversionStalled(db, cfg),
    brandsWithoutPostbacks(db, cfg),
    submitErrorRate(sources.submitErrorCounts, cfg),
    rejectRateByBrand(db, cfg),
    clickRisk(db, cfg),
  ]);
  return AlertsReport.parse({
    generated_at: cfg.now,
    conversion_stalled,
    brands_without_postbacks,
    submit_error_rate,
    reject_rate,
    click_risk,
  });
}