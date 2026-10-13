/**
 * LeadsRpc: brand Worker -> core (CO-2, BR-6..BR-8, BR-3).
 *
 * Every call is `POST <core>/rpc/<method>` with a JSON body and
 * `Authorization: Bearer <per-account credential>`. Core rejects a `brand_id` that does not
 * belong to the calling account. The brand Worker sets `brand_id` and `hostname` from its own
 * environment; the browser never supplies them.
 *
 * Shapes follow the spike (`spike/core-worker`, `spike/brand-worker`) and V1 behaviour:
 * click capture = V1 `functions/_middleware.ts`, lead = V1 form payload, zip = V1 handleZipLookup.
 */
import { z } from "zod";
import { BrandId, Hostname, Zip5, OpaqueToken, ExperimentId, VariantId } from "./common.js";
import { FormLeadPayload, LeadError, ZipResponse } from "./form-payload.js";
import { AbConfig, AmountBuckets, FlowGateMode } from "./admin-api.js";
import { FormRoute, Keyword } from "./runtime-config.js";

/** Opaque server-minted token (click session, continuation, handoff). URL- and cookie-safe. */
export { OpaqueToken } from "./common.js";

/** A/B identifiers written on clicks and leads (T2 columns). Never secrets. */
export { ExperimentId, VariantId } from "./common.js";

// --- recordClick -----------------------------------------------------------------------------

/**
 * Query keys V1 `_middleware.ts` persists on `click_sessions` (allowlist; the raw query is never
 * stored). `keyword` is the Anjuna addition (T2 column). Values are trimmed and capped at 512.
 */
export const CLICK_PARAM_KEYS = [
  "gclid", "gbraid", "wbraid", "msclkid", "fbclid", "external_click_id", "clickid", "click_id",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "source", "aid", "keyword",
] as const;

/** V1 only mints a click session when one of these is present (untagged traffic never hits D1). */
export const CLICK_TRIGGER_KEYS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "external_click_id"] as const;

const clickParam = z.string().min(1).max(512);
export const ClickParams = z.partialRecord(z.enum(CLICK_PARAM_KEYS), clickParam);
export type ClickParams = z.infer<typeof ClickParams>;

export const RecordClickRequest = z.strictObject({
  brand_id: BrandId,
  hostname: Hostname,
  /** V1 `landing_path`: the path the visitor landed on (`/` or `/go`). */
  landing_path: z.string().startsWith("/").max(512),
  /** V1 `referrer_origin`: origin only, never the full referrer URL. */
  referrer_origin: z.string().max(512).nullable(),
  params: ClickParams,
  experiment_id: ExperimentId.nullable().optional(),
  variant: VariantId.nullable().optional(),
});
export type RecordClickRequest = z.infer<typeof RecordClickRequest>;

export const RecordClickResponse = z.strictObject({
  /** Value of the neutral first-party click cookie (V1 `fo_click`, 30 days, HttpOnly). */
  click_session_id: OpaqueToken,
});
export type RecordClickResponse = z.infer<typeof RecordClickResponse>;

// --- submitLead ------------------------------------------------------------------------------

/**
 * Visitor facts core can no longer see itself (it is behind the brand Worker) but V1 stores:
 * `consent_evidence.ip_hash` (sha256 of `ip:site_id`), `user_agent` (cap 512), and the V1
 * per-IP rate limit.
 */
export const ClientContext = z.strictObject({
  ip: z.string().min(1).max(64),
  user_agent: z.string().max(512),
});
export type ClientContext = z.infer<typeof ClientContext>;

export const SubmitLeadRequest = z.strictObject({
  brand_id: BrandId,
  hostname: Hostname,
  /** Click cookie value, if any. Core claims it single-use; it wins over client-body tracking. */
  click_session_id: OpaqueToken.nullable(),
  client: ClientContext,
  experiment_id: ExperimentId.nullable().optional(),
  variant: VariantId.nullable().optional(),
  /** The V1 form payload, forwarded unchanged. */
  lead: FormLeadPayload,
});
export type SubmitLeadRequest = z.infer<typeof SubmitLeadRequest>;

/**
 * Accepted or duplicate (same client `lead_id`). Core never returns the prepop URL here;
 * the brand turns `continuation` into `redirect_url = <formRoute>/provider?c=<continuation>`.
 */
export const SubmitLeadAccepted = z.strictObject({
  status: z.enum(["accepted", "duplicate"]),
  lead_id: z.string().min(1),
  /** V1 `reference`: last 8 chars of lead_id. */
  reference: z.string().min(1),
  continuation: OpaqueToken,
});
export type SubmitLeadAccepted = z.infer<typeof SubmitLeadAccepted>;

export const SubmitLeadResponse = z.union([SubmitLeadAccepted, LeadError]);
export type SubmitLeadResponse = z.infer<typeof SubmitLeadResponse>;

// --- resolveContinuation --------------------------------------------------------------------

export const ResolveContinuationRequest = z.strictObject({
  brand_id: BrandId,
  token: z.string().max(512),
});
export type ResolveContinuationRequest = z.infer<typeof ResolveContinuationRequest>;

/**
 * Where the provider hop sends the browser (302, `Referrer-Policy: no-referrer`). For a routed
 * lead it is the LeadsGate prepop URL built by V1 buildUserRedirect; for a lead V1 would not
 * route (state gate) it is the neutral path `<formRoute>/complete?ref=<last 8>`.
 */
export const ResolveContinuationResponse = z.strictObject({
  url: z.string().min(1),
});
export type ResolveContinuationResponse = z.infer<typeof ResolveContinuationResponse>;

// --- zip -------------------------------------------------------------------------------------

export const ZipRequest = z.strictObject({
  brand_id: BrandId,
  /** Digits only, 1-5 long; core left-pads to 5 like V1. */
  zip: z.string().regex(/^\d{1,5}$/),
});
export type ZipRequest = z.infer<typeof ZipRequest>;
export const ZipRpcResponse = ZipResponse;
export type ZipRpcResponse = ZipResponse;

// --- issueHandoff / verifyHandoff (BR-3, signed_cookie mode) ----------------------------------

/** BR-3: the handoff cookie lasts 30 minutes. */
export const HANDOFF_TTL_SECONDS = 30 * 60;

export const IssueHandoffRequest = z.strictObject({
  brand_id: BrandId,
  requested_amount: z.number().int().positive(),
  zip: Zip5,
});
export type IssueHandoffRequest = z.infer<typeof IssueHandoffRequest>;

export const IssueHandoffResponse = z.strictObject({
  /** HMAC-signed value for the handoff cookie. */
  token: OpaqueToken,
  expires_at: z.iso.datetime(),
});
export type IssueHandoffResponse = z.infer<typeof IssueHandoffResponse>;

export const VerifyHandoffRequest = z.strictObject({
  brand_id: BrandId,
  token: z.string().max(512),
});
export type VerifyHandoffRequest = z.infer<typeof VerifyHandoffRequest>;

export const VerifyHandoffValid = z.strictObject({
  valid: z.literal(true),
  requested_amount: z.number().int().positive(),
  zip: Zip5,
  expires_at: z.iso.datetime(),
});
/** A bad or expired signature sends the visitor to `/` (BR-3). */
export const VerifyHandoffInvalid = z.strictObject({
  valid: z.literal(false),
  reason: z.enum(["malformed", "bad_signature", "expired", "brand_mismatch"]),
});
export const VerifyHandoffResponse = z.discriminatedUnion("valid", [VerifyHandoffValid, VerifyHandoffInvalid]);
export type VerifyHandoffResponse = z.infer<typeof VerifyHandoffResponse>;

// --- live public settings --------------------------------------------------------------------
export const BrandSettingsRequest = z.strictObject({ brand_id: BrandId });
export const BrandSettingsResponse = z.strictObject({
  flow_gate_mode: FlowGateMode,
  paused: z.boolean(),
  amount_buckets: AmountBuckets,
  ab_config: AbConfig.nullable(),
  keyword_default: Keyword.nullable(),
  form_route: FormRoute,
});
export type BrandSettingsResponse = z.infer<typeof BrandSettingsResponse>;

/**
 * Authenticated Worker context headers; the existing submitLead JSON shape is unchanged.
 * submitLead requires x-consent-brand = encodeURIComponent(configured display name).
 * Forward Sec-GPC verbatim when 0/1; absence means no signal was received.
 */
export const SUBMIT_CONTEXT_HEADERS = { gpc: "sec-gpc", consent_brand: "x-consent-brand" } as const;

// --- errors and routing table -----------------------------------------------------------------

/** Non-2xx RPC body. `forbidden_brand` = brand_id outside the caller's account (CO-2). */
export const RpcError = z.strictObject({
  error: z.enum(["unauthorized", "forbidden_brand", "not_found", "invalid", "rate_limited", "internal"]),
});
export type RpcError = z.infer<typeof RpcError>;

export const RPC_PREFIX = "/rpc/";

/** Method -> path and schemas. Core and brand runtime both import this table. */
export const LeadsRpc = {
  recordClick: { path: "/rpc/recordClick", request: RecordClickRequest, response: RecordClickResponse },
  submitLead: { path: "/rpc/submitLead", request: SubmitLeadRequest, response: SubmitLeadResponse },
  resolveContinuation: { path: "/rpc/resolveContinuation", request: ResolveContinuationRequest, response: ResolveContinuationResponse },
  zip: { path: "/rpc/zip", request: ZipRequest, response: ZipRpcResponse },
  issueHandoff: { path: "/rpc/issueHandoff", request: IssueHandoffRequest, response: IssueHandoffResponse },
  verifyHandoff: { path: "/rpc/verifyHandoff", request: VerifyHandoffRequest, response: VerifyHandoffResponse },
  brandSettings: { path: "/rpc/brandSettings", request: BrandSettingsRequest, response: BrandSettingsResponse },
} as const;
export type LeadsRpcMethod = keyof typeof LeadsRpc;
export type LeadsRpcRequest<M extends LeadsRpcMethod> = z.input<(typeof LeadsRpc)[M]["request"]>;
export type LeadsRpcResponse<M extends LeadsRpcMethod> = z.output<(typeof LeadsRpc)[M]["response"]>;
