import { z } from "zod";

/** Status values of `conversion_uploads.status` (leads D1, 0001_v1_baseline.sql). */
export const CONVERSION_STATUSES = ["pending", "processing", "uploaded", "dead"] as const;
export const ConversionStatus = z.enum(CONVERSION_STATUSES);
export type ConversionStatus = z.infer<typeof ConversionStatus>;

export const ConversionReasonCode = z.enum([
  "no_click_id", "lease_exhausted", "no_route", "not_ready", "ms_env_missing", "upload_failed", "platform_error",
]);
export type ConversionReasonCode = z.infer<typeof ConversionReasonCode>;

/** Rows returned by one conversions report call. */
export const CONVERSIONS_ROW_LIMIT = 200;
/** Same threshold as the conversion_stalled alert (insights alerts.ts). */
export const CONVERSION_STALLED_HOURS = 6;

// Prefixes of the `last_error` strings core and drain.mjs write. First match wins.
const PREFIXES: Array<[string, ConversionReasonCode]> = [
  ["no click id", "no_click_id"],
  ["no gclid/gbraid/wbraid", "no_click_id"],
  ["no msclkid", "no_click_id"],
  ["reclaim: exhausted attempts", "lease_exhausted"],
  ["no route for brand=", "no_route"],
  ["not ready yet", "not_ready"],
  ["missing microsoft env", "ms_env_missing"],
  ["upload failed", "upload_failed"],
];

// The only `last_error` texts a non-owner sees: the fixed strings core and the drain write.
const EMPLOYEE_ERRORS = new Set([
  "no click id", "no gclid/gbraid/wbraid", "no msclkid", "reclaim: exhausted attempts after stale lease",
  "missing microsoft env (account/conversion_name)", "upload failed",
]);
const NO_ROUTE_ERROR = /^no route for brand=[a-z0-9_-]{1,64} hostname=[a-z0-9.-]{1,253}$/i;

/**
 * The drain stores raw AdKit failure text, which can echo the upload payload (click id and value).
 * A non-owner sees only the fixed templates, trimmed; any other text is null. Core and the panel mock core share this.
 */
export function employeeLastError(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  return EMPLOYEE_ERRORS.has(trimmed.toLowerCase()) || NO_ROUTE_ERROR.test(trimmed) ? trimmed : null;
}

/** Reason code for a row's `last_error`. Uploaded rows and empty text have no reason. */
export function conversionReasonCode(status: ConversionStatus, lastError: string | null): ConversionReasonCode | null {
  if (status === "uploaded") return null;
  const text = (lastError ?? "").trim().toLowerCase();
  if (!text) return null;
  return PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "platform_error";
}
