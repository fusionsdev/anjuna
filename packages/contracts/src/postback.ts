/**
 * LeadsGate postback (CO-3): `GET|POST <core>/api/postback?token&cid&payout&lead_id&type`.
 *
 * Mirrors V1 `functions/api/[[path]].ts` handlePostback (`8404ec2`). LeadsGate is configured
 * with a plain URL, e.g.
 *   /api/postback?token=<secret>&cid={click_id}&payout={price}&lead_id={lead_id}&type={type}
 * `cid` is our click id (lead_id without hyphens); `lead_id` is LeadsGate's own id (logging only).
 */
import { z } from "zod";
import { MAX_PAYOUT_USD, v1Clean } from "./v1.js";

export const POSTBACK_TYPES = ["newLead", "soldLead", "rejectLead"] as const;
export const PostbackType = z.enum(POSTBACK_TYPES);
export type PostbackType = z.infer<typeof PostbackType>;

/** Raw query as received: every param optional, strings only. */
export const PostbackRawQuery = z.object({
  token: z.string().optional(),
  cid: z.string().optional(),
  payout: z.string().optional(),
  lead_id: z.string().optional(),
  type: z.string().optional(),
});
export type PostbackRawQuery = z.infer<typeof PostbackRawQuery>;

/**
 * V1 payout rule: finite and > 0, else 0; then clamp to MAX_PAYOUT_USD.
 * (`Number(null)` is 0, so a missing payout is 0.)
 */
export function sanitizePayout(raw: string | null | undefined): { payout: number; clamped: boolean } {
  const n = Number(raw ?? null);
  let payout = Number.isFinite(n) && n > 0 ? n : 0;
  const clamped = payout > MAX_PAYOUT_USD;
  if (clamped) payout = MAX_PAYOUT_USD;
  return { payout, clamped };
}

/** The normalized postback V1 acts on once the token has been checked. */
export const Postback = z.strictObject({
  cid: z.string().min(1).max(128),
  type: PostbackType,
  payout: z.number().finite().min(0).max(MAX_PAYOUT_USD),
  payout_clamped: z.boolean(),
  /** LeadsGate's own lead id. Logging only, never a join key. */
  buyer_lead_id: z.string().max(64),
});
export type Postback = z.infer<typeof Postback>;

/**
 * Raw query -> normalized postback, with V1 cleaning (cid 128, type 32, lead_id 64).
 * Fails exactly where V1 answers 400 "Invalid postback": empty cid or unknown type.
 * The token is not part of this schema; compare it in constant time against the env secret.
 */
export const PostbackQuery = PostbackRawQuery.transform((q) => {
  const { payout, clamped } = sanitizePayout(q.payout);
  return {
    cid: v1Clean(q.cid, 128),
    type: v1Clean(q.type, 32),
    payout,
    payout_clamped: clamped,
    buyer_lead_id: v1Clean(q.lead_id, 64),
  };
}).pipe(Postback);

/** Read a URLSearchParams into the raw query shape (first value wins, like `.get`). */
export function postbackRawFromSearchParams(sp: { get(name: string): string | null }): PostbackRawQuery {
  const out: PostbackRawQuery = {};
  for (const k of ["token", "cid", "payout", "lead_id", "type"] as const) {
    const v = sp.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/**
 * V1 enqueues a `conversion_uploads` row when the type is soldLead and the payout is > 0.
 * A $0 conversion is never queued (it would poison Smart Bidding).
 */
export function queuesConversion(p: Pick<Postback, "type" | "payout">): boolean {
  return p.type === "soldLead" && p.payout > 0;
}

/** V1 response bodies. Unmatched cid still answers 200 so LeadsGate does not retry forever. */
export const PostbackResponse = z.union([
  z.strictObject({ status: z.enum(["accepted", "duplicate"]), lead_id: z.string().min(1) }),
  z.strictObject({ status: z.literal("ignored"), reason: z.literal("unknown_click") }),
  z.strictObject({ status: z.literal("invalid"), message: z.enum(["Unauthorized", "Invalid postback"]) }),
]);
export type PostbackResponse = z.infer<typeof PostbackResponse>;
