import { z } from "zod";
import { BrandId, Hostname } from "./common.js";
import { TrafficLogPeriod, TrafficMetrics } from "./traffic-log.js";

export const UserAgentFamily = z.enum(["googlebot", "adsbot", "other-bot", "browser", "unknown"]);
export const TrafficTailEvent = z.strictObject({
  event_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  ts: z.number().int().min(1_600_000_000_000).max(4_102_444_800_000),
  event_type: z.enum(["gate_viewed", "landing_viewed", "form_started", "form_step_viewed", "form_step_completed",
    "form_validation_failed", "lead_submission_started", "lead_submitted", "redirect_started", "redirect_failed",
    "postback_received"]),
  session_ref: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  brand: BrandId, domain: Hostname,
  device_type: z.enum(["mobile", "tablet", "desktop", "unknown"]).nullable(),
  browser: z.enum(["chrome", "safari", "firefox", "edge", "other", "unknown"]).nullable(),
  user_agent_family: UserAgentFamily,
  // Only the canonical hostname is exposed as a URL: never a visitor query string.
  url: z.string().regex(/^https:\/\/[a-z0-9.-]+\/$/),
  http_status: z.number().int().min(100).max(599).nullable(),
  response_ms: z.number().nonnegative().nullable(),
  gate_passed: z.boolean().nullable(),
});
export type TrafficTailEvent = z.infer<typeof TrafficTailEvent>;

export const TrafficRealtimeQuery = z.strictObject({
  period: TrafficLogPeriod.default("24h"),
  brand: z.string().max(32500).refine(value => {
    const ids = value.split(",");
    return ids.length <= 500 && ids.every(id => BrandId.safeParse(id).success);
  }, "Invalid brand list").optional(),
});
export type TrafficRealtimeQuery = z.infer<typeof TrafficRealtimeQuery>;

const Count = z.number().int().nonnegative();
const Pct = z.number().min(0).max(100);
const NullableDelta = z.number().finite().nullable();
const Breakdown = z.array(z.strictObject({ key: z.string(), count: Count, pct: Pct })).max(10);
/** Hourly counters: current_hour is the current UTC bucket; 24h is that bucket plus the previous 23. */
const BotCounts = z.strictObject({ current_hour: Count, "24h": Count });
export const TrafficRealtimeResponse = z.strictObject({
  period: TrafficLogPeriod, from: z.iso.datetime(), to: z.iso.datetime(),
  kpis: TrafficMetrics.extend({
    suspicious_sessions: Count.nullable(), no_gclid_landings: z.strictObject({ count: Count, pct: Pct }),
    gate_drops: Count, non_us_pct: Pct.nullable(),
  }),
  // Percentage change; null when the previous value is zero or unavailable.
  deltas: z.strictObject({ landing_views: NullableDelta, form_starts: NullableDelta, leads: NullableDelta,
    validation_errors: NullableDelta, redirect_errors: NullableDelta, suspicious_sessions: NullableDelta,
    no_gclid_landings: NullableDelta, gate_drops: NullableDelta, non_us_pct: NullableDelta }),
  bots_now: z.strictObject({ googlebot: BotCounts, adsbot: BotCounts, "other-bot": BotCounts }),
  adsbot_last: z.array(TrafficTailEvent.pick({ brand: true, url: true, http_status: true, response_ms: true, gate_passed: true })
    .extend({ at: z.iso.datetime() })).max(20),
  breakdowns: z.strictObject({ source: Breakdown, hostname: Breakdown, device: Breakdown, browser: Breakdown, brand: Breakdown }),
  trend: z.array(z.strictObject({ at: z.iso.datetime(), landing_views: Count, form_starts: Count, leads: Count })),
  recent: z.array(z.strictObject({
    at: z.iso.datetime(), event_type: z.string(), hostname: z.string().nullable(), brand: z.string().nullable(),
    source: z.string().nullable(), campaign: z.string().nullable(), device: z.string().nullable(), browser: z.string().nullable(),
    form_step: z.number().int().nullable(), error_code: z.string().nullable(),
    session_ref: z.string().regex(/^[a-f0-9]{16}$/).nullable(), user_agent_family: UserAgentFamily.nullable(),
  })).max(200),
});
export type TrafficRealtimeResponse = z.infer<typeof TrafficRealtimeResponse>;
