/**
 * Read-only click risk reports (FUS-372) over `traffic_events.risk_score` / `risk_signals`.
 * A visit is one (session_id, hostname); its score is the highest score of its events, so a
 * visit is high risk once any of its events reached HIGH_RISK_SCORE.
 */
import {
  HIGH_RISK_SCORE,
  RISK_EXPORT_LIMIT,
  RISK_HOURS_TIMEZONE,
  RISK_SIGNALS,
  RiskSignalId,
  TrafficRiskExportResponse,
  TrafficRiskResponse,
  type RiskPeriod,
  type TrafficRiskExportQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

const DAY_MS = 86_400_000;

const zoneHour = new Intl.DateTimeFormat("en-US", { timeZone: RISK_HOURS_TIMEZONE, hour: "numeric", hourCycle: "h23" });
const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: RISK_HOURS_TIMEZONE, year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
});

/** Milliseconds the zone's wall clock is ahead of UTC at `ms` (negative for US Eastern). */
function zoneOffset(ms: number): number {
  const parts = Object.fromEntries(zoneParts.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(ms / 1000) * 1000;
}

/** `today` starts at midnight in RISK_HOURS_TIMEZONE; 7d and 30d are rolling windows ending now. */
export function riskWindow(period: RiskPeriod, nowMs: number): { from: string; to: string } {
  const to = new Date(nowMs).toISOString();
  if (period === "7d") return { from: new Date(nowMs - 7 * DAY_MS).toISOString(), to };
  if (period === "30d") return { from: new Date(nowMs - 30 * DAY_MS).toISOString(), to };
  const wall = new Date(nowMs + zoneOffset(nowMs));
  const midnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  // Re-read the offset at midnight itself: a DST switch at 02:00 changes it during the day.
  const guess = midnightWall - zoneOffset(nowMs);
  return { from: new Date(midnightWall - zoneOffset(guess)).toISOString(), to };
}

const signalIds = RISK_SIGNALS.map((signal) => signal.id);

function parseSignals(text: string | null): RiskSignalId[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is RiskSignalId => RiskSignalId.safeParse(id).success) : [];
  } catch { return []; }
}

export async function loadTrafficRisk(env: Env, period: RiskPeriod, nowMs = Date.now()): Promise<TrafficRiskResponse> {
  const { from, to } = riskWindow(period, nowMs);
  // ?3..?5 are the signal ids, matched as JSON strings inside the stored array.
  const visits = `WITH v AS (
      SELECT hostname, MIN(created_at) AS first_at, MAX(COALESCE(risk_score, 0)) AS score,
        MAX(instr(COALESCE(risk_signals, ''), '"' || ?3 || '"') > 0) AS s1,
        MAX(instr(COALESCE(risk_signals, ''), '"' || ?4 || '"') > 0) AS s2,
        MAX(instr(COALESCE(risk_signals, ''), '"' || ?5 || '"') > 0) AS s3
      FROM traffic_events
      WHERE created_at >= ?1 AND created_at < ?2 AND hostname IS NOT NULL
      GROUP BY session_id, hostname
    )`;
  const binds = [from, to, ...signalIds] as const;
  const [domains, hours, signals] = await env.LEADS.batch([
    env.LEADS.prepare(`${visits}
      SELECT hostname, COUNT(*) AS visits, SUM(score >= ?6) AS high_risk FROM v
      GROUP BY hostname ORDER BY high_risk DESC, visits DESC, hostname`).bind(...binds, HIGH_RISK_SCORE),
    env.LEADS.prepare(`${visits}
      SELECT substr(first_at, 1, 13) AS utc_hour, COUNT(*) AS visits, SUM(score >= ?6) AS high_risk FROM v
      GROUP BY utc_hour`).bind(...binds, HIGH_RISK_SCORE),
    env.LEADS.prepare(`${visits}
      SELECT COALESCE(SUM(s1), 0) AS s1, COALESCE(SUM(s2), 0) AS s2, COALESCE(SUM(s3), 0) AS s3 FROM v`).bind(...binds),
  ]);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, visits: 0, high_risk: 0 }));
  for (const row of hours!.results as { utc_hour: string; visits: number; high_risk: number }[]) {
    const bucket = byHour[Number(zoneHour.format(Date.parse(`${row.utc_hour}:00:00.000Z`))) % 24]!;
    bucket.visits += Number(row.visits);
    bucket.high_risk += Number(row.high_risk);
  }
  const counts = (signals!.results[0] ?? {}) as Record<string, number>;
  return TrafficRiskResponse.parse({
    signals: RISK_SIGNALS.map((signal, index) => ({
      id: signal.id, label: signal.label, weight: signal.weight, count: Number(counts[`s${index + 1}`] ?? 0),
    })),
    domains: (domains!.results as { hostname: string; visits: number; high_risk: number }[]).map((row) => ({
      hostname: row.hostname, visits: Number(row.visits), high_risk: Number(row.high_risk),
    })),
    hours: byHour,
  });
}

/**
 * High-risk visits, newest first. The signals are those of the visit's highest-scoring event.
 * gclid comes from the visit's `_vc` click session, else from the click of the lead it submitted.
 */
export async function loadTrafficRiskExport(env: Env, query: TrafficRiskExportQuery, nowMs = Date.now()): Promise<TrafficRiskExportResponse> {
  const { from, to } = riskWindow(query.period, nowMs);
  const { results } = await env.LEADS.prepare(`WITH ranked AS (
      SELECT session_id, hostname, risk_score, risk_signals,
        ROW_NUMBER() OVER (PARTITION BY session_id, hostname ORDER BY COALESCE(risk_score, 0) DESC, created_at, id) AS rn,
        MAX(click_session_id) OVER (PARTITION BY session_id, hostname) AS click_session_id,
        MIN(created_at) OVER (PARTITION BY session_id, hostname) AS first_at
      FROM traffic_events
      WHERE created_at >= ?1 AND created_at < ?2 AND hostname IS NOT NULL AND (?3 IS NULL OR hostname = ?3)
    )
    SELECT r.hostname, r.risk_score AS score, r.risk_signals, r.first_at AS created_at,
      COALESCE(cs.gclid, (
        SELECT lc.gclid FROM leads l JOIN click_sessions lc ON lc.lead_id = l.lead_id
        WHERE l.session_id = r.session_id AND lc.gclid IS NOT NULL LIMIT 1
      )) AS gclid
    FROM ranked r LEFT JOIN click_sessions cs ON cs.click_session_id = r.click_session_id
    WHERE r.rn = 1 AND r.risk_score >= ?4
    ORDER BY r.first_at DESC, r.hostname
    LIMIT ?5`).bind(from, to, query.hostname ?? null, HIGH_RISK_SCORE, RISK_EXPORT_LIMIT + 1)
    .all<{ hostname: string; score: number; risk_signals: string | null; created_at: string; gclid: string | null }>();

  return TrafficRiskExportResponse.parse({
    rows: results.slice(0, RISK_EXPORT_LIMIT).map((row) => ({
      gclid: row.gclid || null,
      hostname: row.hostname,
      score: Number(row.score),
      signals: parseSignals(row.risk_signals),
      created_at: row.created_at,
    })),
    truncated: results.length > RISK_EXPORT_LIMIT,
  });
}
