import {
  TrafficBreakdownResponse, trafficWindow, type TrafficBreakdownQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

// Attribute a session to its first entry in the selected window. Later submission events
// omit source/brand; grouping those events directly would move every lead to "unknown".
// Hostname is trusted at ingest; body.brand is a display name and is not an identity.
const SESSIONS = `
WITH events AS (
  SELECT *, COALESCE(NULLIF(lower(hostname), ''), 'unknown') AS host,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(lower(hostname), ''), 'unknown'), session_id
      ORDER BY CASE WHEN event_type IN ('gate_viewed', 'landing_viewed') THEN 0 ELSE 1 END,
        created_at, id
    ) AS entry_rank
  FROM traffic_events WHERE created_at >= ?1 AND created_at < ?2
), sessions AS (
  SELECT host, session_id,
    MAX(CASE WHEN entry_rank = 1 THEN created_at END) AS entered_at,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(trim(source), ''), 'unknown') END) AS source,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(device_class, ''), 'unknown') END) AS device,
    MAX(CASE WHEN entry_rank = 1 THEN COALESCE(NULLIF(browser_family, ''), 'unknown') END) AS browser,
    MAX(CASE WHEN event_type IN ('gate_viewed', 'landing_viewed') THEN 1 ELSE 0 END) AS visits,
    MAX(CASE WHEN event_type IN ('landing_viewed', 'form_started') THEN 1 ELSE 0 END) AS form_views,
    MAX(CASE WHEN event_type = 'lead_submitted' THEN 1 ELSE 0 END) AS leads
  FROM events GROUP BY host, session_id
), attributed AS (
  SELECT *, COALESCE((
    SELECT MIN(b.brand_id) FROM brand_runtime b, json_each(b.hostnames) h
    WHERE lower(h.value) = sessions.host OR lower(h.value) = 'www.' || sessions.host
  ), host) AS brand_id
  FROM sessions WHERE visits = 1
)
`;

const DIMENSIONS = {
  source: "source", domain: "host", device: "device", browser: "browser",
  hour: "strftime('%Y-%m-%dT%H:00:00Z', entered_at)",
} as const;
const easternHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
});

export async function loadTrafficBreakdown(
  env: Pick<Env, "LEADS">, query: TrafficBreakdownQuery, now = new Date(),
): Promise<TrafficBreakdownResponse> {
  const { from, to } = trafficWindow(query.period, now);
  // The only interpolated SQL is an allowlisted expression, never request text.
  const dimension = DIMENSIONS[query.by];
  const [groups, brands] = await Promise.all([
    env.LEADS.prepare(SESSIONS + `
      SELECT ${dimension} AS key, SUM(visits) AS visits, SUM(leads) AS leads
      FROM attributed GROUP BY ${dimension} ORDER BY visits DESC, key
    `).bind(from, to).all<{ key: string; visits: number; leads: number }>(),
    env.LEADS.prepare(SESSIONS + `
      SELECT brand_id, MIN(host) AS hostname, SUM(visits) AS visits,
        NULL AS go_count, SUM(form_views) AS form_views, SUM(leads) AS leads
      FROM attributed GROUP BY brand_id ORDER BY brand_id
    `).bind(from, to).all<TrafficBreakdownResponse["brands"][number]>(),
  ]);
  let rows = groups.results;
  if (query.by === "hour") {
    // Convert each UTC date/hour separately: a fixed UTC offset breaks across DST.
    rows = Array.from({ length: 24 }, (_, hour) => ({ key: String(hour).padStart(2, "0"), visits: 0, leads: 0 }));
    for (const group of groups.results) {
      const hour = Number(easternHour.format(new Date(group.key)));
      const row = rows[hour]!;
      row.visits += group.visits;
      row.leads += group.leads;
    }
  }
  return TrafficBreakdownResponse.parse({ ...query, from, to, timezone: "America/New_York", rows, brands: brands.results });
}
