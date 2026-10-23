import {
  CONVERSION_STALLED_HOURS, CONVERSIONS_ROW_LIMIT, ConversionsReportResponse, conversionReasonCode, employeeLastError, spendPeriodRange,
  type AdminRole, type ConversionStatus, type ConversionsQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;
// Older rows may carry an offset ("+00:00") or no milliseconds. The contract wants canonical UTC.
const iso = (value: string) => { const ms = Date.parse(value); return Number.isNaN(ms) ? value : new Date(ms).toISOString(); };

const PLACEHOLDER = "[click id]";
// A click id key and its separator: JSON pair (quotes of either kind), `key=value` or `--key value`.
const CLICK_ID_KEY = /(?:gclid|gbraid|wbraid|msclkid)(?:\\*["']?\s*[:=]\s*\\*["']?|\s+["']?)/gi;
// The value after the key is any run of non-delimiters or `\uXXXX` escapes. It may end inside the value
// because the drain cuts `e.message` at 300 characters.
const VALUE_TOKEN = /(?:[^"'\\,}\s]|\\u[0-9a-f]{4})+/y;
// Inside an array every run that is not a delimiter is a value.
const ARRAY_VALUE = /[^\s"',[\]{}]+/g;
// One layer of JSON escaping: `\\`, `\uXXXX`, `\/`, `\"` and `\'`.
const ESCAPE = /\\(\\|u[0-9a-fA-F]{4}|["'/])/g;
const MAX_DECODE_ROUNDS = 4;

interface Row {
  lead_id: string; brand: string; status: ConversionStatus; last_error: string | null;
  gclid: string | null; gbraid: string | null; wbraid: string | null; msclkid: string | null;
  attempts: number; value: number; currency: string; occurred_at: string; created_at: string;
  updated_at: string | null; next_attempt_at: string | null;
}

const clickIds = (row: Row) => [row.gclid, row.gbraid, row.wbraid, row.msclkid].filter((id): id is string => !!id);

/** Undoes JSON escaping one layer per round. An echo that went through several JSON.stringify calls needs several rounds. */
function decode(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = current.replace(ESCAPE, (_, escape: string) => (escape.length > 1 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape));
    if (next === current) break;
    current = next;
  }
  return current;
}

/** The index after the `]` that closes the array opening at `start`, or the end of the text when the drain cut it off. */
function arrayEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Replaces the value after every click id key, and every value of an array after one, with the placeholder. */
function maskClickIdValues(text: string): string {
  let out = "";
  let from = 0;
  CLICK_ID_KEY.lastIndex = 0;
  for (let key = CLICK_ID_KEY.exec(text); key; key = CLICK_ID_KEY.exec(text)) {
    const start = key.index + key[0].length;
    let end: number;
    let masked = PLACEHOLDER;
    if (text[start] === "[") {
      end = arrayEnd(text, start);
      masked = text.slice(start, end).replace(ARRAY_VALUE, PLACEHOLDER);
    } else {
      VALUE_TOKEN.lastIndex = start;
      const token = VALUE_TOKEN.exec(text);
      if (!token) continue;
      end = start + token[0].length;
    }
    out += text.slice(from, start) + masked;
    from = end;
    CLICK_ID_KEY.lastIndex = end;
  }
  return out + text.slice(from);
}

/** True when a click id value may still show: one of the row's own values, or a key followed by anything but the placeholder or a delimiter. */
function leaksClickId(text: string, row: Row): boolean {
  // The placeholder holds ordinary words, so a short click id must not match inside it.
  const bare = text.split(PLACEHOLDER).join("");
  if (clickIds(row).some((id) => bare.includes(id))) return true;
  CLICK_ID_KEY.lastIndex = 0;
  for (let key = CLICK_ID_KEY.exec(text); key; key = CLICK_ID_KEY.exec(text)) {
    const start = key.index + key[0].length;
    if (start >= text.length || text.startsWith(PLACEHOLDER, start)) continue;
    if (text[start] === "[") {
      if (text.slice(start, arrayEnd(text, start)).split(PLACEHOLDER).join("").search(ARRAY_VALUE) >= 0) return true;
    } else if (!/[\s"',}\]]/.test(text[start]!)) return true;
  }
  return false;
}

/**
 * The drain stores raw AdKit failure text, which can echo the upload payload (click id and value).
 * A non-owner sees only the fixed templates. The owner sees the decoded text with click id values masked,
 * or null when masking cannot be shown to work: click id values never leave core.
 */
function sanitizeLastError(text: string | null, row: Row, owner: boolean): string | null {
  if (!owner) return employeeLastError(text);
  if (text === null) return null;
  // Decode first so an escaped click id reads as itself. Key values next: masking the row's own values first
  // would leave the placeholder for the key pattern to eat.
  let masked = maskClickIdValues(decode(text));
  for (const id of clickIds(row)) masked = masked.split(id).join(PLACEHOLDER);
  return leaksClickId(masked, row) ? null : masked.slice(0, 300);
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
