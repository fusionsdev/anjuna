import { BrandId, Hostname, HIGH_RISK_SCORE, TrafficRealtimeResponse, trafficLogWindow, type TrafficRealtimeQuery } from "@anjuna/contracts";
import type { Env } from "../env.js";
import { brandOfHost } from "./traffic-log.js";
async function tailSessionRef(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const dimensions = { source: "source", hostname: "hostname", device: "device_class", browser: "browser_family", brand: "brand_id" } as const;
type Totals = { landing_views: number; form_starts: number; leads: number; validation_errors: number; redirect_errors: number;
  suspicious_sessions: number; no_gclid: number; gate_drops: number; known_country: number; non_us: number; total: number };
type Recent = { created_at: string; event_type: string; hostname: string | null; brand_id: string; source: string | null;
  campaign: string | null; device_class: string | null; browser_family: string | null; form_step: number | null;
  error_code: string | null; session_id: string; user_agent_family: TrafficRealtimeResponse["recent"][number]["user_agent_family"] };
const pct = (n: number, d: number) => d ? n * 100 / d : 0;
const kpis = (r: Totals): TrafficRealtimeResponse["kpis"] => ({
  landing_views: r.landing_views, form_starts: r.form_starts, leads: r.leads, validation_errors: r.validation_errors,
  redirect_errors: r.redirect_errors, suspicious_sessions: r.suspicious_sessions,
  no_gclid_landings: { count: r.no_gclid, pct: pct(r.no_gclid, r.landing_views) }, gate_drops: r.gate_drops,
  non_us_pct: r.known_country ? pct(r.non_us, r.known_country) : null,
});

/** Eleven bounded SELECTs. The old traffic_events.brand is display text; attribution uses its trusted hostname. */
export async function loadTrafficRealtime(env: Pick<Env, "LEADS">, query: TrafficRealtimeQuery, now = new Date()): Promise<TrafficRealtimeResponse> {
  const { from, to, bucket } = trafficLogWindow(query.period, now);
  const brands = JSON.stringify(query.brand?.split(",") ?? []);
  const source = `WITH attributed AS (SELECT e.*, ${brandOfHost("lower(e.hostname)")} AS brand_id FROM traffic_events e
    WHERE e.created_at >= ?1 AND e.created_at < ?2), events AS (SELECT * FROM attributed
    WHERE json_array_length(?3) = 0 OR brand_id IN (SELECT value FROM json_each(?3))) `;
  const statement = (sql: string, start = from, end = to) => env.LEADS.prepare(source + sql).bind(start, end, brands);
  // Anjuna emits landing_viewed at /request, after /go; it has no separate go telemetry event.
  const sums = `SELECT COUNT(*) AS total,
    COALESCE(SUM(event_type='landing_viewed'),0) AS landing_views,
    COALESCE(SUM(event_type='form_started'),0) AS form_starts,
    COALESCE(SUM(event_type='lead_submitted'),0) AS leads,
    COALESCE(SUM(event_type='form_validation_failed'),0) AS validation_errors,
    COALESCE(SUM(event_type='redirect_failed'),0) AS redirect_errors,
    COUNT(DISTINCT CASE WHEN risk_score >= ${HIGH_RISK_SCORE} THEN hostname || ':' || session_id END) AS suspicious_sessions,
    COALESCE(SUM(event_type='landing_viewed' AND NOT EXISTS (SELECT 1 FROM click_sessions c
      WHERE c.click_session_id=events.click_session_id AND c.hostname=events.hostname AND NULLIF(trim(c.gclid),'') IS NOT NULL)),0) AS no_gclid,
    COUNT(DISTINCT CASE WHEN event_type='gate_viewed' AND NOT EXISTS (SELECT 1 FROM traffic_events following
      WHERE following.session_id=events.session_id AND following.hostname=events.hostname
      AND following.created_at >= events.created_at AND following.created_at < ?2
      AND following.event_type IN ('landing_viewed','form_started')) THEN hostname || ':' || session_id END) AS gate_drops,
    COALESCE(SUM(NULLIF(country,'') IS NOT NULL),0) AS known_country,
    COALESCE(SUM(NULLIF(country,'') IS NOT NULL AND country <> 'US'),0) AS non_us FROM events`;
  const previous = (at: string) => new Date(Date.parse(at) - 86_400_000).toISOString();
  const hour = (ms: number) => new Date(ms).toISOString().slice(0, 13) + ":00:00Z";
  const keys = Object.keys(dimensions) as Array<keyof typeof dimensions>;
  const results = await env.LEADS.batch<Record<string, unknown>>([
    statement(sums), statement(sums, previous(from), previous(to)),
    ...keys.map(key => statement(`SELECT COALESCE(NULLIF(${dimensions[key]},''),'unknown') AS key, COUNT(*) AS count
      FROM events GROUP BY key ORDER BY count DESC, key LIMIT 10`)),
    statement(`SELECT substr(created_at,1,${bucket === "hour" ? 13 : 10}) AS at,
      SUM(event_type='landing_viewed') AS landing_views, SUM(event_type='form_started') AS form_starts,
      SUM(event_type='lead_submitted') AS leads FROM events GROUP BY at ORDER BY at`),
    statement("SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT 200"),
    statement("SELECT brand_id, hostname, created_at FROM events WHERE user_agent_family='adsbot' ORDER BY created_at DESC, id DESC LIMIT 20"),
    // Exactly 24 UTC hour buckets, including the current partial bucket; no inferred 15-minute count.
    env.LEADS.prepare(`SELECT kind, SUM(CASE WHEN hour = ?1 THEN hits ELSE 0 END) AS current_hour,
      SUM(hits) AS h24 FROM bot_hits
      WHERE hour >= ?2 AND hour <= ?1 AND (json_array_length(?3)=0 OR brand_id IN (SELECT value FROM json_each(?3))) GROUP BY kind`)
      .bind(hour(now.getTime()), hour(now.getTime() - 23 * 3_600_000), brands),
  ]);
  const current = results[0]!.results[0] as unknown as Totals;
  const totals = kpis(current);
  const prior = kpis(results[1]!.results[0] as unknown as Totals);
  const delta = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : (a - b) * 100 / b;
  const deltas = Object.fromEntries(Object.keys(totals).map(key => {
    const k = key as keyof typeof totals;
    return [k, delta(k === "no_gclid_landings" ? totals[k].count : totals[k], k === "no_gclid_landings" ? prior[k].count : prior[k])];
  }));
  const breakdowns = Object.fromEntries(keys.map((key, i) => [key, results[i + 2]!.results.map(row => ({ key: row.key, count: row.count, pct: pct(Number(row.count), current.total) }))]));
  const bots = { googlebot: { current_hour: 0, "24h": 0 }, adsbot: { current_hour: 0, "24h": 0 }, "other-bot": { current_hour: 0, "24h": 0 } };
  for (const row of results[10]!.results) {
    const kind = row.kind as keyof typeof bots;
    if (Object.hasOwn(bots, kind)) bots[kind] = { current_hour: Number(row.current_hour), "24h": Number(row.h24) };
  }
  return TrafficRealtimeResponse.parse({ period: query.period, from, to, kpis: totals, deltas, breakdowns, bots_now: bots,
    trend: results[7]!.results.map(row => ({ ...row, at: String(row.at) + (bucket === "hour" ? ":00:00.000Z" : "T00:00:00.000Z") })),
    recent: await Promise.all((results[8]!.results as unknown as Recent[]).map(async row => ({ at: row.created_at, event_type: row.event_type,
      hostname: row.hostname, brand: row.brand_id, source: row.source, campaign: row.campaign, device: row.device_class, browser: row.browser_family,
      form_step: row.form_step, error_code: row.error_code, session_ref: await tailSessionRef(row.session_id), user_agent_family: row.user_agent_family }))),
    // No path, status, response duration or gate-result column exists in traffic_events. Never invent success.
    adsbot_last: results[9]!.results.filter(row => Hostname.safeParse(row.hostname).success).map(row => ({ brand: BrandId.safeParse(row.brand_id).success ? row.brand_id : "unknown", url: `https://${row.hostname}/`, at: row.created_at,
      http_status: null, response_ms: null, gate_passed: null })),
  });
}
