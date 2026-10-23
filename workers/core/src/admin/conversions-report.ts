import {
  CONVERSION_STALLED_HOURS, CONVERSIONS_ROW_LIMIT, ConversionsReportResponse, conversionReasonCode, employeeLastError, spendPeriodRange,
  type AdminRole, type ConversionStatus, type ConversionsQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;
// Older rows may carry an offset ("+00:00") or no milliseconds. The contract wants canonical UTC.
const iso = (value: string) => { const ms = Date.parse(value); return Number.isNaN(ms) ? value : new Date(ms).toISOString(); };

const CLICK_ID_KEY = /gclid|gbraid|wbraid|msclkid/i;
const HIDDEN = "[click id hidden]";
const TRAILING_PUNCTUATION = /[\s{}[\]"'\\,:=>()-]+$/;
// One layer of escaping: `\\`, `\uXXXX`, `\xXX`, `\/`, `\"`, `\'`, `\n` `\r` `\t` and `%XX`.
// One pass over the text, so `\\u0041` becomes `\u0041` and needs the next round to become `A`.
const ESCAPE = /\\(?:(\\)|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([/"'])|([nrt]))|%([0-9a-fA-F]{2})/g;
const MAX_DECODE_ROUNDS = 8;
const RUN = 8;

interface Row {
  lead_id: string; brand: string; status: ConversionStatus; last_error: string | null;
  gclid: string | null; gbraid: string | null; wbraid: string | null; msclkid: string | null;
  attempts: number; value: number; currency: string; occurred_at: string; created_at: string;
  updated_at: string | null; next_attempt_at: string | null;
}

const clickIds = (row: Row) => [row.gclid, row.gbraid, row.wbraid, row.msclkid].filter((id): id is string => !!id);

/** Undoes escaping one layer per round, byte by byte. Null when the text still changes in the last round. */
function decode(text: string): string | null {
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = current.replace(ESCAPE, (_, backslash?: string, unicode?: string, hex?: string, plain?: string, space?: string, percent?: string) =>
      backslash ?? plain ?? (space ? " " : String.fromCharCode(parseInt(unicode ?? hex ?? percent!, 16))));
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** True when `text` holds any 8-character run of `id`, or the whole id when it is shorter than 8. */
function sharesRun(text: string, id: string): boolean {
  if (id.length < RUN) return text.includes(id);
  for (let i = 0; i + RUN <= id.length; i++) if (text.includes(id.slice(i, i + RUN))) return true;
  return false;
}

/**
 * The drain stores raw AdKit failure text, which can echo the upload payload (click id and value).
 * A non-owner sees only the fixed templates. The owner sees the decoded text cut at the first click id key,
 * or null when it still holds a run of the row's own click ids: click id values never leave core.
 */
function sanitizeLastError(text: string | null, row: Row, owner: boolean): string | null {
  if (!owner) return employeeLastError(text);
  if (text === null) return null;
  const decoded = decode(text);
  if (decoded === null) return null;
  const key = CLICK_ID_KEY.exec(decoded);
  const kept = key ? decoded.slice(0, key.index).replace(TRAILING_PUNCTUATION, "") : decoded;
  // The drain cuts `e.message` at 300 characters, so an id can end mid-value or show up with no key in front of it.
  for (const id of clickIds(row)) {
    const own = decode(id);
    if (own === null || sharesRun(kept, own)) return null;
  }
  return (key ? (kept ? `${kept} ${HIDDEN}` : HIDDEN) : kept).slice(0, 300);
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
