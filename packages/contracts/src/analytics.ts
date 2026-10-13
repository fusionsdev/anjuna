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
import { BrandId, Hostname } from "./common.js";

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
}).superRefine((request, ctx) => {
  if (new TextEncoder().encode(request.body).length > ANALYTICS_LIMITS[request.kind]) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "Body exceeds the limit for this kind" });
  }
});
export type AnalyticsForwardRequest = z.input<typeof AnalyticsForwardRequest>;
