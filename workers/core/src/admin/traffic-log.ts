// spec traffic
import {
  TRAFFIC_BREAKDOWN_LIMIT, TRAFFIC_METRICS, TRAFFIC_RECENT_LIMIT, TrafficReportResponse,
  trafficLogBuckets, trafficLogWindow, type TrafficMetrics, type TrafficReportQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

/** Opaque 12-hex reference to a session. The same function serves every core route, so refs match across screens. */
export async function sessionRef(hostname: string | null, sessionId: string): Promise<string> {
  const lower = (hostname ?? "").toLowerCase();
  const host = (lower.startsWith("www.") ? lower.slice(4) : lower) || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session:${host}:${sessionId}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/**
 * Maps a host column of the enclosing query to a brand id through brand_runtime.hostnames (exact or `www.`
 * match), falling back to the host. Pass a qualified column (`s.host`) so the subquery cannot bind its own
 * columns. Same rule as traffic.ts, copied so that file stays unchanged.
 */
export const brandOfHost = (column: string): string => `COALESCE((
  SELECT MIN(b.brand_id) FROM brand_runtime b, json_each(b.hostnames) h
  WHERE lower(h.value) = ${column} OR lower(h.value) = 'www.' || ${column}
), ${column})`;

const HOST = "COALESCE(NULLIF(lower(hostname), ''), 'unknown')";

// One row per (host, session_id). Attributes come from the first event in the window; each metric is a 0/1 flag.
// Hostname is trusted at ingest; body.brand is a display name and is never read.
const SESSIONS = `
WITH events AS (
  SELECT id, created_at, event_type, session_id, source, device_class, browser_family, ${HOST} AS host,
    ROW_NUMBER() OVER (PARTITION BY ${HOST}, session_id ORDER BY created_at, id) AS entry_rank
  FROM traffic_events WHERE created_at >= ?1 AND created_at < ?2
), sessions AS (
  SELECT host, session_id,
    MAX(CASE WHEN entry_rank = 1 THEN created_at END) AS entered_at,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(trim(source), ''), 'unknown') END) AS source,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(device_class, ''), 'unknown') END) AS device,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(browser_family, ''), 'unknown') END) AS browser,
    MAX(CASE WHEN event_type = 'landing_viewed' THEN 1 ELSE 0 END) AS landing_views,
    MAX(CASE WHEN event_type = 'form_started' THEN 1 ELSE 0 END) AS form_starts,
    MAX(CASE WHEN event_type = 'lead_submitted' THEN 1 ELSE 0 END) AS leads,
    MAX(CASE WHEN event_type = 'form_validation_failed' THEN 1 ELSE 0 END) AS validation_errors,
    MAX(CASE WHEN event_type = 'redirect_failed' THEN 1 ELSE 0 END) AS redirect_errors
  FROM events GROUP BY host, session_id
), attributed AS (
  SELECT s.*, ${brandOfHost("s.host")} AS brand_id FROM sessions s
)
`;

const SUMS = TRAFFIC_METRICS.map((metric) => `COALESCE(SUM(${metric}), 0) AS ${metric}`).join(", ");

const BREAKDOWNS = {
  brand: "brand_id", hostname: "host", device: "device", browser: "browser", source: "source",
} as const;
const BUCKETS = {
  hour: "strftime('%Y-%m-%dT%H:00:00Z', entered_at)",
  day: "strftime('%Y-%m-%dT00:00:00Z', entered_at)",
} as const;

type MetricRow = TrafficMetrics;
type KeyedRow = MetricRow & { key: string };
interface RecentSqlRow {
  created_at: string; event_type: string; host: string; session_id: string; form_step: number | null;
  error_code: string | null; device: string | null; browser: string | null; source: string | null; brand_id: string;
}

const zero = (): MetricRow => ({ landing_views: 0, form_starts: 0, leads: 0, validation_errors: 0, redirect_errors: 0 });

export async function loadTrafficReport(
  env: Pick<Env, "LEADS">, query: TrafficReportQuery, now = new Date(),
): Promise<TrafficReportResponse> {
  const window = trafficLogWindow(query.period, now);
  const { from, to } = window;
  // The only interpolated SQL is an allowlisted expression, never request text.
  const bucket = BUCKETS[window.bucket];
  const sessionQuery = (select: string) => env.LEADS.prepare(SESSIONS + select).bind(from, to);

  const keys = Object.keys(BREAKDOWNS) as Array<keyof typeof BREAKDOWNS>;
  const results = await env.LEADS.batch([
    sessionQuery(`SELECT ${SUMS} FROM attributed`),
    ...keys.map((name) => {
      const dimension = BREAKDOWNS[name];
      return sessionQuery(`
        SELECT ${dimension} AS key, ${SUMS} FROM attributed
        GROUP BY ${dimension} ORDER BY landing_views DESC, key LIMIT ${TRAFFIC_BREAKDOWN_LIMIT}`);
    }),
    sessionQuery(`SELECT ${bucket} AS at, ${SUMS} FROM attributed GROUP BY ${bucket}`),
    env.LEADS.prepare(`
      SELECT r.created_at, r.event_type, r.host, r.session_id, r.form_step, r.error_code, r.device, r.browser, r.source,
        ${brandOfHost("r.host")} AS brand_id
      FROM (
        SELECT id, created_at, event_type, session_id, form_step, ${HOST} AS host,
          NULLIF(error_code, '') AS error_code, NULLIF(device_class, '') AS device,
          NULLIF(browser_family, '') AS browser, NULLIF(trim(source), '') AS source
        FROM traffic_events WHERE created_at >= ?1 AND created_at < ?2
        ORDER BY created_at DESC, id DESC LIMIT ${TRAFFIC_RECENT_LIMIT}
      ) r ORDER BY r.created_at DESC, r.id DESC`).bind(from, to),
  ]);

  const [totals, ...rest] = results;
  const breakdownRows = rest.slice(0, keys.length) as Array<{ results: KeyedRow[] }>;
  const trendRows = (rest[keys.length] as { results: Array<MetricRow & { at: string }> }).results;
  const recentRows = (rest[keys.length + 1] as { results: RecentSqlRow[] }).results;

  const byBucket = new Map<string, MetricRow>();
  for (const { at, ...metrics } of trendRows) byBucket.set(new Date(at).toISOString(), metrics);

  const recent = await Promise.all(recentRows.map(async (row) => ({
    at: row.created_at,
    event_type: row.event_type,
    hostname: row.host,
    brand_id: row.brand_id,
    form_step: row.form_step,
    error_code: row.error_code,
    device: row.device,
    browser: row.browser,
    source: row.source,
    session_ref: await sessionRef(row.host, row.session_id),
  })));

  return TrafficReportResponse.parse({
    period: query.period,
    from,
    to,
    bucket: window.bucket,
    totals: (totals as { results: MetricRow[] }).results[0] ?? zero(),
    breakdowns: Object.fromEntries(keys.map((name, index) => [name, breakdownRows[index]!.results])),
    trend: trafficLogBuckets(window).map((at) => ({ at, ...(byBucket.get(at) ?? zero()) })),
    recent,
  });
}
