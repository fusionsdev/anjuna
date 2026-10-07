import { BUYER_FIELDS, type BuyerField, type ResolveContinuationRequest } from "@anjuna/contracts";
import { sha256 } from "../auth.js";
import type { Env } from "../env.js";
import { json } from "../http.js";
import { randomToken, type RuntimeRow } from "./runtime.js";
import { US_STATES } from "./validation.js";

export const CONTINUATION_TTL_MS = 30 * 60 * 1000;
const BLOCKED_STATES = new Set(["NY", "AR", "VT", "WV"]);
export const isStateRoutable = (state: string) => US_STATES.has(state) && !BLOCKED_STATES.has(state);

export type Applicant = Record<BuyerField, string>;

export async function continuation(env: Env, leadId: string, brandId: string, applicant: Applicant | null = null) {
  const token = randomToken();
  const statement = env.LEADS.prepare(`INSERT INTO continuations
    (token_hash, lead_id, brand_id, expires_at, applicant_json) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(await sha256(token), leadId, brandId, new Date(Date.now() + CONTINUATION_TTL_MS).toISOString(),
      applicant ? JSON.stringify(applicant) : null);
  return { token, statement };
}

/** Duplicate continuations: the current applicant plus trusted stored identifiers, never stored PII. */
function handoffSource(row: Record<string, string | number | null>): Record<string, string | number | null> {
  if (row.applicant_json === null || row.applicant_json === undefined) return row;
  const applicant = JSON.parse(String(row.applicant_json)) as Partial<Applicant>;
  const source: Record<string, string | number | null> = {
    lead_id: row.lead_id ?? null, click_id: row.click_id ?? null, hostname: row.hostname ?? null,
  };
  for (const key of BUYER_FIELDS) source[key] = applicant[key] ?? null;
  return source;
}

/** V1 buildUserRedirect in prepop_redirect mode, using the selected applicant and trusted brand aid. */
export function buildUserRedirect(lead: Record<string, string | number | null>, brand: RuntimeRow): string {
  const leadId = String(lead.lead_id);
  if (!isStateRoutable(String(lead.state))) return `${brand.form_route}/complete?ref=${encodeURIComponent(leadId.slice(-8))}`;
  const url = new URL(brand.prepop_base, `https://${lead.hostname}`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid prepop URL");
  for (const key of BUYER_FIELDS) {
    const value = lead[key];
    // V1's unasked numeric sentinel is storage-only. Zero remains a real applicant answer.
    if (value !== null && value !== undefined && value !== "" && value !== -1) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("ref", leadId.slice(-8));
  url.searchParams.set("lead_id", leadId);
  url.searchParams.set("aid", brand.aid);
  url.searchParams.set("click_id", String(lead.click_id));
  url.searchParams.set("clickid", String(lead.click_id));
  return url.toString();
}

export async function resolveContinuation(input: ResolveContinuationRequest, env: Env, brand: RuntimeRow): Promise<Response> {
  const digest = await sha256(input.token);
  const now = new Date().toISOString();
  const lead = await env.LEADS.prepare(`SELECT l.*, c.applicant_json FROM continuations c JOIN leads l ON l.lead_id = c.lead_id
    WHERE c.token_hash = ?1 AND c.brand_id = ?2 AND l.brand = ?2 AND c.used_at IS NULL AND c.expires_at > ?3`)
    .bind(digest, input.brand_id, now).first<Record<string, string | number | null>>();
  if (!lead) return json({ error: "not_found" }, 404);
  const url = buildUserRedirect(handoffSource(lead), brand);
  // UPDATE is the single-use gate, including concurrent resolves. Build first so bad config doesn't burn it.
  const claimed = await env.LEADS.prepare(`UPDATE continuations SET used_at = ?1, applicant_json = NULL
    WHERE token_hash = ?2 AND brand_id = ?3 AND used_at IS NULL AND expires_at > ?1 RETURNING lead_id`)
    .bind(new Date().toISOString(), digest, input.brand_id).first();
  return claimed ? json({ url }) : json({ error: "not_found" }, 404);
}
