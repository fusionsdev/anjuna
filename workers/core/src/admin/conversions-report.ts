import {
  CONVERSION_STALLED_HOURS, CONVERSIONS_ROW_LIMIT, ConversionsReportResponse, conversionReasonCode, spendPeriodRange,
  type AdminRole, type ConversionStatus, type ConversionsQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;
// Older rows may carry an offset ("+00:00") or no milliseconds. The contract wants canonical UTC.
const iso = (value: string) => { const ms = Date.parse(value); return Number.isNaN(ms) ? value : new Date(ms).toISOString(); };

// The value token after a click id key: JSON pair (escaped quotes too), `key=value` or `--key value`.
// The token is any run of non-delimiters or `\uXXXX` escapes. It may end inside the value because the
// drain cuts `e.message` at 300 characters.
const CLICK_ID_TOKEN = /(gclid|gbraid|wbraid|msclkid)(\\*"?\s*[:=]\s*\\*"?|\s+)((?:[^"\\,}\s]|\\u[0-9a-f]{4})+)/gi;
// The only `last_error` texts a non-owner sees: the fixed strings core and the drain write.
const EMPLOYEE_ERRORS = new Set([
  "no click id", "no gclid/gbraid/wbraid", "no msclkid", "reclaim: exhausted attempts after stale lease",
  "missing microsoft env (account/conversion_name)", "upload failed",
]);
const NO_ROUTE_ERROR = /^no route for brand=\S{1,64} hostname=\S{1,253}$/i;

interface Row {
  lead_id: string; brand: string; status: ConversionStatus; last_error: string | null;
  gclid: string | null; gbraid: string | null; wbraid: string | null; msclkid: string | null;
  attempts: number; value: number; currency: string; occurred_at: string; created_at: string;
  updated_at: string | null; next_attempt_at: string | null;
}

/**
 * The drain stores raw AdKit failure text, which can echo the upload payload (click id and value).
 * A non-owner sees only the fixed templates. The owner sees the text with click id values masked.
 */
function sanitizeLastError(text: string | null, row: Row, owner: boolean): string | null {
  if (text === null) return null;
  if (!owner) {
    const trimmed = text.trim();
    return EMPLOYEE_ERRORS.has(trimmed.toLowerCase()) || NO_ROUTE_ERROR.test(trimmed) ? trimmed : null;
  }
  // Tokens first: masking the row's own values first would leave "[click id]" for the token pattern to eat.
  let masked = text.replace(CLICK_ID_TOKEN, "$1$2[click id]");
  for (const id of [row.gclid, row.gbraid, row.wbraid, row.msclkid]) if (id) masked = masked.split(id).join("[click id]");
  return masked.slice(0, 300);
}

/** Read-only conversion queue report. Money is null unless the caller is the owner. */
export async function loadConversions(env: Env, query: ConversionsQuery, role: AdminRole): Promise<ConversionsReportResponse> {
  const now = query.now ? new Date(query.now) : new Date();
  const days = spendPeriodRange(query.period, now);
  const from = `${days.from}T00:00:00.000Z`;
  const to = nextDay(days.to);
  const owner = role === "owner";

  const totals = await env.LEADS.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM conversion_uploads
     WHERE created_at >= ?1 AND created_at < ?2 GROUP BY status`,
  ).bind(from, to).all<{ status: ConversionStatus; n: number; v: number }>();
  const stalledBefore = new Date(now.getTime() - CONVERSION_STALLED_HOURS * 3_600_000).toISOString();
  const stalled = await env.LEADS.prepare(
    "SELECT COUNT(*) AS n FROM conversion_uploads WHERE status = 'pending' AND created_at < ?1",
  ).bind(stalledBefore).first<{ n: number }>();

  // updated_at is NULL on a pending row until the drain first claims it (postback.ts does not set it).
  const rows = await env.LEADS.prepare(
    `SELECT c.lead_id, l.brand, c.status, c.last_error, c.gclid, c.gbraid, c.wbraid, c.msclkid, c.attempts,
            c.value, c.currency, c.occurred_at, c.created_at, c.updated_at, c.next_attempt_at
     FROM conversion_uploads c JOIN leads l ON l.lead_id = c.lead_id
     WHERE c.created_at >= ?1 AND c.created_at < ?2
       AND (?3 = 'all' OR c.status = ?3) AND (?4 IS NULL OR l.brand = ?4)
     ORDER BY CASE c.status WHEN 'dead' THEN 0 WHEN 'pending' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
              COALESCE(c.updated_at, c.created_at) DESC, c.lead_id
     LIMIT ?5`,
  ).bind(from, to, query.status, query.brand ?? null, CONVERSIONS_ROW_LIMIT + 1).all<Row>();

  const count = (s: ConversionStatus) => Number(totals.results.find((r) => r.status === s)?.n ?? 0);
  const sum = (s: ConversionStatus) => cents(Number(totals.results.find((r) => r.status === s)?.v ?? 0));
  return ConversionsReportResponse.parse({
    period: query.period, from, to,
    totals: { pending: count("pending"), processing: count("processing"), uploaded: count("uploaded"), dead: count("dead") },
    value_totals: owner ? { uploaded: sum("uploaded"), dead: sum("dead") } : null,
    stalled: Number(stalled?.n ?? 0),
    rows: rows.results.slice(0, CONVERSIONS_ROW_LIMIT).map((r) => {
      return {
        lead_id: r.lead_id, brand: r.brand, status: r.status,
        reason_code: conversionReasonCode(r.status, r.last_error),
        last_error: sanitizeLastError(r.last_error, r, owner),
        click_type: r.gclid ? "gclid" : r.gbraid ? "gbraid" : r.wbraid ? "wbraid" : r.msclkid ? "msclkid" : null,
        attempts: Number(r.attempts), value: owner ? cents(Number(r.value)) : null, currency: r.currency,
        occurred_at: iso(r.occurred_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at ?? r.created_at),
        next_attempt_at: r.next_attempt_at === null ? null : iso(r.next_attempt_at),
      };
    }),
    truncated: rows.results.length > CONVERSIONS_ROW_LIMIT,
  });
}
