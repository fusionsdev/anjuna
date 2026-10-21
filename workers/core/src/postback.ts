import {
  PostbackQuery, postbackRawFromSearchParams, queuesConversion, v1Clean,
} from "@anjuna/contracts";
import { hashesEqual, sha256 } from "./auth.js";
import type { Env } from "./env.js";
import { json, unauthorized } from "./http.js";
import { globalPostbackDigest } from "./postback-token.js";

interface PostbackLead {
  lead_id: string;
  tracking_json: string;
  postback_token_hash: string | null;
}

export async function handlePostback(request: Request, env: Env): Promise<Response> {
  const query = postbackRawFromSearchParams(new URL(request.url).searchParams);
  // V1: query token wins; an empty query token falls back to the Authorization header.
  const token = (query.token || (request.headers.get("Authorization") || "")
    .replace(/^Bearer\s+/i, "")).trim();
  if (!token) return unauthorized();
  const digest = await sha256(token);
  const globalDigest = await globalPostbackDigest(env);
  const isGlobal = globalDigest !== null && hashesEqual(digest, globalDigest);
  // leads.brand is the trusted brand_id stored by core (T6c); buyer lead_id is never a join key.
  const lead = await env.LEADS.prepare(`
    SELECT l.lead_id, l.tracking_json, b.postback_token_hash
    FROM leads l LEFT JOIN brand_runtime b ON b.brand_id = l.brand
    WHERE l.click_id = ?1 LIMIT 1
  `).bind(v1Clean(query.cid, 128)).first<PostbackLead>();

  if (lead) {
    if (!isGlobal && !hashesEqual(digest, lead.postback_token_hash)) return unauthorized();
  } else if (!isGlobal) {
    // V1 authenticates even malformed/unmatched callbacks before returning 400/ignored.
    // With no lead to identify a brand, require a configured brand token, but never write.
    const { results } = await env.LEADS.prepare(
      "SELECT postback_token_hash FROM brand_runtime WHERE postback_token_hash IS NOT NULL",
    ).all<{ postback_token_hash: string }>();
    let authorized = false;
    for (const row of results) {
      if (hashesEqual(digest, row.postback_token_hash)) authorized = true;
    }
    if (!authorized) return unauthorized();
  }

  const parsed = PostbackQuery.safeParse(query);
  if (!parsed.success) return json({ status: "invalid", message: "Invalid postback" }, 400);
  if (!lead) return json({ status: "ignored", reason: "unknown_click" });
  const postback = parsed.data;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const enqueue = queuesConversion(postback);
  if (enqueue) {
    // V1 safeJson fallback; IDs are copied from the stored tracking ledger, never the callback.
    let tracking: Record<string, string>;
    try { tracking = JSON.parse(lead.tracking_json) as Record<string, string>; }
    catch { tracking = {}; }
    statements.push(env.LEADS.prepare(`
      INSERT OR IGNORE INTO conversion_uploads (
        lead_id, gclid, gbraid, wbraid, msclkid, value, currency, occurred_at,
        google_order_id, status, attempts, next_attempt_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'USD', ?7, ?8, 'pending', 0, ?7, ?7)
    `).bind(lead.lead_id, tracking.gclid || null, tracking.gbraid || null,
      tracking.wbraid || null, tracking.msclkid || tracking.ref_id || null,
      postback.payout, now, lead.lead_id));
  }
  statements.push(env.LEADS.prepare(`
    INSERT OR IGNORE INTO postback_events (lead_id, event_type, payout, created_at)
    VALUES (?1, ?2, ?3, ?4)
  `).bind(lead.lead_id, postback.type, postback.payout, now));
  statements.push(env.LEADS.prepare(
    "UPDATE leads SET status = ?1, updated_at = ?2 WHERE lead_id = ?3 AND status != 'soldLead'",
  ).bind(postback.type, now, lead.lead_id));
  // Keep V1's atomic enqueue + dedup + status update, including a paid replay after a $0 sale.
  const results = await env.LEADS.batch(statements);
  const dedup = results[enqueue ? 1 : 0]!;
  return json({ status: dedup.meta.changes ? "accepted" : "duplicate", lead_id: lead.lead_id });
}
