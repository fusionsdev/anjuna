import { z } from "zod";

export const TrafficPeriod = z.enum(["today", "7d", "30d"]);
export type TrafficPeriod = z.infer<typeof TrafficPeriod>;
export const TrafficDimension = z.enum(["source", "domain", "device", "browser", "hour"]);
export type TrafficDimension = z.infer<typeof TrafficDimension>;
export const TrafficBreakdownQuery = z.strictObject({
  period: TrafficPeriod.default("today"),
  by: TrafficDimension.default("source"),
});
export type TrafficBreakdownQuery = z.infer<typeof TrafficBreakdownQuery>;
const Count = z.number().int().nonnegative();
export const TrafficBreakdownResponse = z.strictObject({
  period: TrafficPeriod,
  by: TrafficDimension,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  timezone: z.literal("America/New_York"),
  rows: z.array(z.strictObject({ key: z.string(), visits: Count, leads: Count })),
  brands: z.array(z.strictObject({
    brand_id: z.string(), hostname: z.string(), visits: Count,
    // Counted from click_sessions WHERE landing_path = '/go'; 0 means measured zero. Nullable kept for back-compat.
    go_count: Count.nullable(), form_views: Count, leads: Count,
  })),
});
export type TrafficBreakdownResponse = z.infer<typeof TrafficBreakdownResponse>;

/** UTC calendar periods, including today; upper bound is exclusive. */
export function trafficWindow(period: TrafficPeriod, now = new Date()): { from: string; to: string } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (period === "30d" ? 29 : period === "7d" ? 6 : 0));
  return { from: start.toISOString(), to: now.toISOString() };
}
