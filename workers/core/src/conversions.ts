// Ported from fusion_formv_v1@8404ec2 functions/api/[[path]].ts.
// Queue SQL, leases, ack guards and retry behavior intentionally retain V1 semantics.
import {
  CONV_LEASE_STALE_MS, CONV_MAX_ATTEMPTS, convBackoffMs, v1Clean,
  PendingQuery, encodePendingResponse, encodeAckResponse, V1_JSON_HEADERS,
  type PendingConversion,
} from "@anjuna/contracts";
import { drainAuthorized } from "./auth.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
export async function handleConversionsPending(request: Request, env: Env): Promise<Response> {

  if (!await drainAuthorized(request, env)) return json({ status: "invalid", message: "Unauthorized" }, 401);

  const q = new URL(request.url).searchParams;
  // V1 Number(null) = 0: an absent limit clamps to 1; preserve that at the HTTP boundary.
  const { limit } = PendingQuery.parse({ limit: q.get("limit") ?? "" });
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // peek=1 (dry runs) returns eligible rows WITHOUT claiming them, so a validate-only pass
  // doesn't mutate queue state.
  if (q.get("peek") === "1") {
    const { results } = await env.LEADS.prepare(`
      SELECT cu.lead_id, cu.gclid, cu.gbraid, cu.wbraid, cu.msclkid, cu.value, cu.currency,
             cu.occurred_at, cu.google_order_id, cu.attempts,
             l.brand, l.hostname
      FROM conversion_uploads cu
      LEFT JOIN leads l ON l.lead_id = cu.lead_id
      WHERE cu.status = 'pending' AND (cu.next_attempt_at IS NULL OR cu.next_attempt_at <= ?1)
      ORDER BY cu.created_at ASC
      LIMIT ?2
    `).bind(nowIso, limit).all<PendingConversion>();
    return new Response(encodePendingResponse({ conversions: results ?? [] }), { headers: V1_JSON_HEADERS });
  }

  // Atomic claim (audit H-04): flip eligible rows to 'processing' and RETURN them in one
  // statement, so overlapping drains can't grab the same row. Eligible = due 'pending' OR a
  // 'processing' row whose lease went stale (a crashed drain).
  //
  // Two statements in one atomic batch so a row whose drain keeps crashing BEFORE it can ack
  // (audit H-01/H-05 crash path) is still bounded: statement 1 parks stale rows that already
  // exhausted their attempts into the DLQ ('dead'); statement 2 claims the rest and counts each
  // stale reclaim as one attempt (a fresh 'pending' claim is NOT counted — that attempt is
  // counted at ack). Together this guarantees "bounded reclaims, then DLQ" even across crashes.
  const staleIso = new Date(nowMs - CONV_LEASE_STALE_MS).toISOString();
  const batchResults = await env.LEADS.batch([
    env.LEADS.prepare(`
      UPDATE conversion_uploads
      SET status = 'dead',
          last_error = COALESCE(last_error, 'reclaim: exhausted attempts after stale lease'),
          updated_at = ?1
      WHERE status = 'processing' AND (updated_at IS NULL OR updated_at <= ?2) AND attempts >= ?3
    `).bind(nowIso, staleIso, CONV_MAX_ATTEMPTS),
    env.LEADS.prepare(`
      UPDATE conversion_uploads
      SET status = 'processing',
          attempts = attempts + CASE WHEN status = 'processing' THEN 1 ELSE 0 END,
          updated_at = ?1
      WHERE lead_id IN (
        SELECT lead_id FROM conversion_uploads
        WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1))
           OR (status = 'processing' AND (updated_at IS NULL OR updated_at <= ?2) AND attempts < ?3)
        ORDER BY created_at ASC
        LIMIT ?4
      )
      RETURNING lead_id, gclid, gbraid, wbraid, msclkid, value, currency, occurred_at, google_order_id, attempts
    `).bind(nowIso, staleIso, CONV_MAX_ATTEMPTS, limit),
  ]);

  const results = ((batchResults[1] as unknown as { results?: PendingConversion[] }).results) ?? [];

  // Decorate the claimed rows with the brand that produced them. This is a SECOND read rather
  // than a join because SQLite's UPDATE ... RETURNING can only return columns of the table it
  // updated, and rewriting the claim as SELECT-then-UPDATE would reintroduce audit finding H-04
  // (two overlapping drains claiming the same row and uploading one conversion twice).
  //
  // The drain needs this to send each conversion to the Google Ads account that actually owns
  // the click. Without it every upload went to one hardcoded account and Google answered
  // "The click from the imported event is associated with a different Google Ads account",
  // which is how a queue of real revenue aged into the dead-letter state.
  //
  // brand stays null when the lead row is missing. The drain MUST treat null as "unroutable" and
  // fail loudly — silently falling back to a default account is the exact bug this replaces.
  if (results.length) {
    const ids = results.map((r) => String(r.lead_id));
    const holders = ids.map((_, i) => `?${i + 1}`).join(",");
    const { results: leadRows } = await env.LEADS.prepare(
      `SELECT lead_id, brand, hostname FROM leads WHERE lead_id IN (${holders})`,
    ).bind(...ids).all<{ lead_id: string; brand: string | null; hostname: string | null }>();
    const byLead = new Map((leadRows ?? []).map((l) => [l.lead_id, l]));
    for (const row of results) {
      const l = byLead.get(String(row.lead_id));
      row.brand = l?.brand ?? null;
      row.hostname = l?.hostname ?? null;
    }
  }

  return new Response(encodePendingResponse({ conversions: results }), { headers: V1_JSON_HEADERS });
}

export async function handleConversionsAck(request: Request, env: Env): Promise<Response> {

  if (!await drainAuthorized(request, env)) return json({ status: "invalid", message: "Unauthorized" }, 401);

  const body = await request
    .json<{ results?: Array<{ lead_id?: unknown; status?: unknown; error?: unknown }> }>()
    .catch(() => ({}) as { results?: unknown });
  const rows = Array.isArray(body.results) ? body.results : [];
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  let acked = 0;

  for (const r of rows) {
    const leadId = v1Clean(r.lead_id, 64);
    const status = v1Clean(r.status, 16); // "uploaded" | "failed" | "deferred"
    if (!leadId || (status !== "uploaded" && status !== "failed" && status !== "deferred")) continue;

    // DEFERRED: the row could not be attempted at all, so it must not spend one of its six
    // attempts. Two causes today: a brand with no entry in the drain's routing map, and Google
    // refusing uploads to a conversion action for the first few hours after it is created.
    //
    // Leaving such a row claimed ('processing') and simply not acking it does NOT protect it —
    // that was the first attempt at this and it is why two conversions died overnight. The
    // stale-lease reclaim in handleConversionsPending picks a 'processing' row back up after
    // CONV_LEASE_STALE_MS and increments attempts as it goes, so an untouched row still marches
    // to the dead-letter state, just more slowly. Returning it to 'pending' takes it out of the
    // reclaim's reach entirely.
    if (status === "deferred") {
      const nextAt = new Date(nowMs + CONV_LEASE_STALE_MS).toISOString();
      // The /* deferred */ marker keeps this statement distinguishable from the retry-backoff
      // UPDATE below, which also sets status='pending' but binds a different argument list.
      const res = await env.LEADS.prepare(`
        UPDATE conversion_uploads /* deferred */
        SET status = 'pending', next_attempt_at = ?1, last_error = ?2, updated_at = ?3
        WHERE lead_id = ?4 AND status = 'processing'
      `).bind(nextAt, v1Clean(r.error, 300), now, leadId).run();
      if (res.meta.changes) acked++;
      continue;
    }

    // Every UPDATE is guarded `WHERE status='processing'`; count the ack only if it actually
    // changed a row (audit #2). If a stale reclaim already moved the row to another drain's
    // lease, this drain's ack is a no-op and must NOT report success.
    if (status === "uploaded") {
      const res = await env.LEADS.prepare(`
        UPDATE conversion_uploads
        SET status = 'uploaded', attempts = attempts + 1, last_error = NULL, updated_at = ?1
        WHERE lead_id = ?2 AND status = 'processing'
      `).bind(now, leadId).run();
      if (res.meta.changes) acked++;
      continue;
    }

    // Transient failure (audit H-05): schedule a backoff retry until CONV_MAX_ATTEMPTS, then park
    // in the DLQ ('dead') instead of losing the conversion. attempts is read to size the backoff.
    const cur = await env.LEADS.prepare(
      "SELECT attempts FROM conversion_uploads WHERE lead_id = ?1"
    ).bind(leadId).first<{ attempts: number }>();
    const nextAttempts = (cur?.attempts ?? 0) + 1;
    const lastError = v1Clean(r.error, 300);
    let res: D1Result;
    if (nextAttempts >= CONV_MAX_ATTEMPTS) {
      res = await env.LEADS.prepare(`
        UPDATE conversion_uploads
        SET status = 'dead', attempts = ?1, last_error = ?2, updated_at = ?3
        WHERE lead_id = ?4 AND status = 'processing'
      `).bind(nextAttempts, lastError, now, leadId).run();
    } else {
      const nextAt = new Date(nowMs + convBackoffMs(nextAttempts)).toISOString();
      res = await env.LEADS.prepare(`
        UPDATE conversion_uploads
        SET status = 'pending', attempts = ?1, last_error = ?2, next_attempt_at = ?3, updated_at = ?4
        WHERE lead_id = ?5 AND status = 'processing'
      `).bind(nextAttempts, lastError, nextAt, now, leadId).run();
    }
    if (res.meta.changes) acked++;
  }

  return new Response(encodeAckResponse(acked), { headers: V1_JSON_HEADERS });
}
