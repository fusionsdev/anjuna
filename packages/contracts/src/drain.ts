/**
 * Drain contract (CO-4): `GET /api/conversions/pending` and `POST /api/conversions/ack`.
 *
 * Frozen. It must stay byte-compatible with V1 `functions/api/[[path]].ts`
 * (handleConversionsPending / handleConversionsAck) because the unchanged V1 `drain/drain.mjs`
 * on the VPS is the client. Auth for both routes is `Authorization: Bearer <DRAIN_TOKEN>`
 * (header only, never the query string).
 */
import { z } from "zod";
import { PENDING_LIMIT } from "./v1.js";

/**
 * Column order of a claimed row exactly as V1 emits it: the `RETURNING` list of the claim
 * UPDATE, then `brand` and `hostname` appended from `leads`. The peek SELECT uses the same order.
 * `encodePendingResponse` uses this order so core produces the same bytes as V1.
 */
export const PENDING_ROW_KEYS = [
  "lead_id",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "value",
  "currency",
  "occurred_at",
  "google_order_id",
  "attempts",
  "brand",
  "hostname",
] as const;

/**
 * Fields `drain.mjs` reads from each row. All of them are in PENDING_ROW_KEYS.
 * `attempts` is returned by V1 but not read by the drain.
 */
export const DRAIN_READS_ROW_FIELDS = [
  "lead_id",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "value",
  "currency",
  "occurred_at",
  "google_order_id",
  "brand",
  "hostname",
] as const;

const nullableText = z.string().nullable();

/** One row of `conversion_uploads` as returned by pending (V1 column types). */
export const PendingConversion = z.strictObject({
  lead_id: z.string().min(1),
  gclid: nullableText,
  gbraid: nullableText,
  wbraid: nullableText,
  msclkid: nullableText,
  /** REAL NOT NULL: the clamped payout in USD. */
  value: z.number().finite().nonnegative(),
  /** TEXT NOT NULL DEFAULT 'USD'. */
  currency: z.string().min(1),
  /** ISO 8601 with offset; the drain converts it with `new Date(...)`. */
  occurred_at: z.string().min(1),
  /** V1 sets this to lead_id; Google-side dedup key. Nullable column. */
  google_order_id: nullableText,
  attempts: z.number().int().nonnegative(),
  /** From `leads.brand`; null when the lead row is missing. The drain treats null as unroutable. */
  brand: nullableText,
  /** From `leads.hostname`; null when the lead row is missing. */
  hostname: nullableText,
});
export type PendingConversion = z.infer<typeof PendingConversion>;

/** 200 body of `GET /api/conversions/pending`. The drain reads `body.conversions || []`. */
export const PendingResponse = z.strictObject({
  conversions: z.array(PendingConversion),
});
export type PendingResponse = z.infer<typeof PendingResponse>;

/**
 * Query of `GET /api/conversions/pending` as the drain sends it:
 * `?limit=<n>` plus `&peek=1` in validate-only mode. V1 parses `limit` leniently
 * (NaN -> 100, clamped to 1..500); `peek` other than "1" means a claiming read.
 */
export const PendingQuery = z
  .object({
    limit: z.string().optional(),
    peek: z.string().optional(),
  })
  .transform((q) => {
    const raw = Number(q.limit);
    const limit = Math.min(PENDING_LIMIT.max, Math.max(PENDING_LIMIT.min, Number.isFinite(raw) ? raw : PENDING_LIMIT.default));
    return { limit, peek: q.peek === "1" };
  });
export type PendingQuery = z.output<typeof PendingQuery>;

/** Ack statuses V1 applies. Anything else is skipped by the server (not counted). */
export const AckStatus = z.enum(["uploaded", "failed", "deferred"]);
export type AckStatus = z.infer<typeof AckStatus>;

/**
 * One ack result exactly as `drain.mjs` builds it: `{lead_id, status}` plus `error` on
 * failed/deferred rows. The drain never sends "skipped"; it maps skipped rows to "deferred".
 */
export const AckResult = z.strictObject({
  lead_id: z.string().min(1),
  status: AckStatus,
  error: z.string().optional(),
});
export type AckResult = z.infer<typeof AckResult>;

/** Body of `POST /api/conversions/ack`. */
export const AckRequest = z.strictObject({
  results: z.array(AckResult),
});
export type AckRequest = z.infer<typeof AckRequest>;

/** 200 body of ack. `acked` counts rows whose guarded UPDATE changed something. */
export const AckResponse = z.strictObject({
  status: z.literal("accepted"),
  acked: z.number().int().nonnegative(),
});
export type AckResponse = z.infer<typeof AckResponse>;

/** 401 body of both drain routes (V1 json({status:"invalid", message:"Unauthorized"}, 401)). */
export const DrainUnauthorized = z.strictObject({
  status: z.literal("invalid"),
  message: z.literal("Unauthorized"),
});
export type DrainUnauthorized = z.infer<typeof DrainUnauthorized>;

/** Response headers V1 sends on every JSON response (`JSON_HEADERS`). */
export const V1_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

/**
 * Serialize a pending response with V1's key order and no whitespace, so the bytes match V1.
 * Validates first; throws on a row that breaks the contract.
 */
export function encodePendingResponse(body: PendingResponse): string {
  const parsed = PendingResponse.parse(body);
  const conversions = parsed.conversions.map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const k of PENDING_ROW_KEYS) ordered[k] = row[k];
    return ordered;
  });
  return JSON.stringify({ conversions });
}

/** Serialize an ack response with V1's key order (`{"status":"accepted","acked":n}`). */
export function encodeAckResponse(acked: number): string {
  const body = AckResponse.parse({ status: "accepted", acked });
  return JSON.stringify({ status: body.status, acked: body.acked });
}
