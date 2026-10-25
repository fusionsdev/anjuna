// spec traffic
import {
  CLIENT_ERRORS_PAGE_LIMIT, CLIENT_ERROR_TYPES_LIMIT, ClientErrorsResponse, trafficLogWindow,
  type AdminRole, type ClientErrorsQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";
import { BRAND_OF_HOST, sessionRef } from "./traffic-log.js";

// An error's host is the lowest host seen for its session. A row with an empty session id has no host and no brand.
// occurred_at is client text, so the window compares as text and a malformed value normally falls outside it.
const ERRORS = `
WITH errors AS (
  SELECT e.id, e.session_id, e.error_type, e.error_message, e.screen_id, e.occurred_at,
    CASE WHEN COALESCE(e.session_id, '') = '' THEN NULL
      ELSE (SELECT MIN(lower(t.hostname)) FROM traffic_events t WHERE t.session_id = e.session_id) END AS host
  FROM client_errors e WHERE e.occurred_at >= ?1 AND e.occurred_at < ?2
), attributed AS (
  SELECT *, CASE WHEN host IS NULL THEN NULL ELSE ${BRAND_OF_HOST} END AS brand_id FROM errors
)
`;

interface ErrorSqlRow {
  id: number; occurred_at: string; error_type: string; error_message: string | null; screen_id: string | null;
  session_id: string | null; host: string | null; brand_id: string | null;
}

export async function loadClientErrors(
  env: Pick<Env, "LEADS">, query: ClientErrorsQuery, role: AdminRole, now = new Date(),
): Promise<ClientErrorsResponse> {
  const { from, to } = trafficLogWindow(query.period, now);
  const brand = query.brand_id ?? null;
  const cursor = query.cursor === undefined ? null : Number(query.cursor);

  const [rowsResult, countsResult] = await env.LEADS.batch([
    env.LEADS.prepare(`${ERRORS}
      SELECT id, occurred_at, error_type, error_message, screen_id, session_id, host, brand_id FROM attributed
      WHERE (?3 IS NULL OR brand_id = ?3) AND (?4 IS NULL OR error_type = ?4) AND (?5 IS NULL OR id < ?5)
      ORDER BY id DESC LIMIT ${CLIENT_ERRORS_PAGE_LIMIT + 1}`)
      .bind(from, to, brand, query.error_type ?? null, cursor),
    env.LEADS.prepare(`${ERRORS}
      SELECT error_type, COUNT(*) AS count FROM attributed
      WHERE (?3 IS NULL OR brand_id = ?3)
      GROUP BY error_type ORDER BY count DESC, error_type ASC LIMIT ${CLIENT_ERROR_TYPES_LIMIT}`)
      .bind(from, to, brand),
  ]);

  const fetched = (rowsResult as { results: ErrorSqlRow[] }).results;
  const page = fetched.slice(0, CLIENT_ERRORS_PAGE_LIMIT);
  const rows = await Promise.all(page.map(async (row) => ({
    id: row.id,
    occurred_at: row.occurred_at,
    error_type: row.error_type,
    error_message: role === "owner" ? row.error_message : null,
    screen_id: row.screen_id || null,
    hostname: row.host,
    brand_id: row.brand_id,
    session_ref: row.session_id ? await sessionRef(row.host, row.session_id) : null,
  })));

  return ClientErrorsResponse.parse({
    period: query.period,
    from,
    to,
    counts: (countsResult as { results: Array<{ error_type: string; count: number }> }).results,
    rows,
    next_cursor: fetched.length > CLIENT_ERRORS_PAGE_LIMIT ? String(page[page.length - 1]!.id) : null,
  });
}
