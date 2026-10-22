/**
 * Analytics forward: brand Worker -> core (ADR-0004, BR-11).
 *
 * The brand Worker caps the visitor's POST body and forwards it as one JSON envelope to
 * `POST <core><ANALYTICS_FORWARD_PATHS[kind]>` with `Authorization: Bearer <per-account
 * credential>`, like `/rpc/*`. It never swaps keys. Core swaps the PostHog key and the Sentry
 * DSN server-side, or stores telemetry and errors. A success is an empty 204; an error is
 * `RpcError`. Core never reflects upstream content to the brand.
 */
import { z } from "zod";
import { BrandId, Hostname, OpaqueToken } from "./common.js";

export const ANALYTICS_KINDS = ["posthog", "sentry", "telemetry", "errors"] as const;
export const AnalyticsKind = z.enum(ANALYTICS_KINDS);
export type AnalyticsKind = z.infer<typeof AnalyticsKind>;

/** Largest accepted body in UTF-8 bytes. The brand Worker enforces it on the stream, core again on the envelope. */
export const ANALYTICS_LIMITS = {
  posthog: 256 * 1024, sentry: 1024 * 1024, telemetry: 64 * 1024, errors: 64 * 1024,
} as const satisfies Record<AnalyticsKind, number>;

/** One core endpoint per kind, so each can have its own size cap (ADR-0004). */
export const ANALYTICS_FORWARD_PATHS = {
  posthog: "/analytics/posthog", sentry: "/analytics/sentry",
  telemetry: "/analytics/telemetry", errors: "/analytics/errors",
} as const satisfies Record<AnalyticsKind, string>;

// Not TextEncoder: this package builds without DOM or Node types. A lone surrogate counts 3, as in UTF-8 encoding.
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * What the brand Worker saw about the visitor of a telemetry request (FUS-372). Core scores the
 * event from it and stores only the score, the signal ids and the click session id. Every field is
 * optional: an older brand Worker omits the object and its events score 0.
 */
export const AnalyticsVisitor = z.strictObject({
  user_agent: z.string().max(512).optional(),
  /** Cloudflare edge `request.cf.timezone`, e.g. America/Chicago. */
  edge_timezone: z.string().max(64).optional(),
  /** Hex SHA-256 of `<ip>:<brand_id>`; core keeps it for one hour only. The raw IP never leaves the edge. */
  ip_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** The `_vc` click cookie, the only join from a telemetry row to its click (gclid). */
  click_session_id: OpaqueToken.optional(),
});
export type AnalyticsVisitor = z.infer<typeof AnalyticsVisitor>;

export const AnalyticsForwardRequest = z.strictObject({
  brand_id: BrandId,
  hostname: Hostname,
  kind: AnalyticsKind,
  /** Relative suffix below the public proxy path, e.g. /i/v0/e/. Never an arbitrary URL. */
  path: z.string().max(200).regex(/^\/[A-Za-z0-9_./-]*$/)
    .refine((path) => !path.includes("..") && !path.includes("//"), "Path must be a plain suffix"),
  content_type: z.string().max(256).regex(/^[\x20-\x7e]*$/),
  /** The visitor's original request body, decoded as text. */
  body: z.string(),
  /** Telemetry only. Read by core for observe-only risk scoring; it never changes a response. */
  visitor: AnalyticsVisitor.optional(),
}).superRefine((request, ctx) => {
  if (utf8Length(request.body) > ANALYTICS_LIMITS[request.kind]) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "Body exceeds the limit for this kind" });
  }
});
export type AnalyticsForwardRequest = z.input<typeof AnalyticsForwardRequest>;
