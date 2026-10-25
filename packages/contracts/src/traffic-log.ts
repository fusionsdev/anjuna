// spec traffic
import { z } from "zod";
import { BrandId } from "./common.js";
import { trafficWindow } from "./traffic.js";

export const TRAFFIC_LOG_PERIODS = ["24h", "7d", "30d"] as const;
export const TrafficLogPeriod = z.enum(TRAFFIC_LOG_PERIODS);
export type TrafficLogPeriod = z.infer<typeof TrafficLogPeriod>;

export type TrafficLogWindow = { from: string; to: string; bucket: "hour" | "day" };

/** 24h: the current UTC hour and the 23 before it. 7d and 30d: UTC calendar days including today. `to` is exclusive. */
export function trafficLogWindow(period: TrafficLogPeriod, now = new Date()): TrafficLogWindow {
  if (period === "24h") {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    start.setUTCHours(start.getUTCHours() - 23);
    return { from: start.toISOString(), to: now.toISOString(), bucket: "hour" };
  }
  return { ...trafficWindow(period, now), bucket: "day" };
}

/** ISO bucket starts from `from` up to `to`: 24 hours, or 7 or 30 days. */
export function trafficLogBuckets(window: TrafficLogWindow): string[] {
  const step = window.bucket === "hour" ? 3_600_000 : 86_400_000;
  const end = Date.parse(window.to);
  const out: string[] = [];
  for (let t = Date.parse(window.from); t <= end; t += step) out.push(new Date(t).toISOString());
  return out;
}

export const TRAFFIC_METRICS = ["landing_views", "form_starts", "leads", "validation_errors", "redirect_errors"] as const;
const Count = z.number().int().nonnegative();
export const TrafficMetrics = z.strictObject({
  landing_views: Count,
  form_starts: Count,
  leads: Count,
  validation_errors: Count,
  redirect_errors: Count,
});
export type TrafficMetrics = z.infer<typeof TrafficMetrics>;

export const TRAFFIC_BREAKDOWN_LIMIT = 100;
export const TRAFFIC_RECENT_LIMIT = 200;
export const CLIENT_ERRORS_PAGE_LIMIT = 50;
export const CLIENT_ERROR_TYPES_LIMIT = 50;

/** Opaque, one-way reference to a session. Never the session id itself. */
export const SessionRef = z.string().regex(/^[0-9a-f]{12}$/);
export type SessionRef = z.infer<typeof SessionRef>;

export const TrafficReportQuery = z.strictObject({ period: TrafficLogPeriod.default("24h") });
export type TrafficReportQuery = z.infer<typeof TrafficReportQuery>;

export const TrafficRecentEvent = z.strictObject({
  at: z.iso.datetime(),
  event_type: z.string().min(1).max(40),
  hostname: z.string(),
  brand_id: z.string(),
  form_step: z.number().int().min(1).max(40).nullable(),
  error_code: z.string().nullable(),
  device: z.string().nullable(),
  browser: z.string().nullable(),
  source: z.string().nullable(),
  session_ref: SessionRef,
});
export type TrafficRecentEvent = z.infer<typeof TrafficRecentEvent>;

/** CSV column order. */
export const TRAFFIC_RECENT_COLUMNS = [
  "at", "event_type", "hostname", "brand_id", "form_step", "error_code", "device", "browser", "source", "session_ref",
] as const;

const BreakdownRow = TrafficMetrics.extend({ key: z.string() });
const Breakdown = z.array(BreakdownRow).max(TRAFFIC_BREAKDOWN_LIMIT);

export const TrafficReportResponse = z.strictObject({
  period: TrafficLogPeriod,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bucket: z.enum(["hour", "day"]),
  totals: TrafficMetrics,
  breakdowns: z.strictObject({
    brand: Breakdown,
    hostname: Breakdown,
    device: Breakdown,
    browser: Breakdown,
    source: Breakdown,
  }),
  trend: z.array(TrafficMetrics.extend({ at: z.iso.datetime() })),
  recent: z.array(TrafficRecentEvent).max(TRAFFIC_RECENT_LIMIT),
});
export type TrafficReportResponse = z.infer<typeof TrafficReportResponse>;

export const ClientErrorCursor = z.string().regex(/^[1-9][0-9]{0,15}$/);
export type ClientErrorCursor = z.infer<typeof ClientErrorCursor>;

export const ClientErrorsQuery = z.strictObject({
  period: TrafficLogPeriod.default("24h"),
  brand_id: BrandId.optional(),
  error_type: z.string().min(1).max(64).optional(),
  cursor: ClientErrorCursor.optional(),
});
export type ClientErrorsQuery = z.infer<typeof ClientErrorsQuery>;

export const ClientErrorRow = z.strictObject({
  id: z.number().int().positive(),
  /** Client text, not validated as a datetime. */
  occurred_at: z.string().max(40),
  error_type: z.string().min(1).max(64),
  /** Null for an employee. */
  error_message: z.string().max(200).nullable(),
  screen_id: z.string().max(64).nullable(),
  hostname: z.string().nullable(),
  brand_id: z.string().nullable(),
  session_ref: SessionRef.nullable(),
});
export type ClientErrorRow = z.infer<typeof ClientErrorRow>;

export const ClientErrorsResponse = z.strictObject({
  period: TrafficLogPeriod,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  counts: z.array(z.strictObject({ error_type: z.string(), count: Count })).max(CLIENT_ERROR_TYPES_LIMIT),
  rows: z.array(ClientErrorRow).max(CLIENT_ERRORS_PAGE_LIMIT),
  next_cursor: ClientErrorCursor.nullable(),
});
export type ClientErrorsResponse = z.infer<typeof ClientErrorsResponse>;
