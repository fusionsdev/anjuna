/**
 * Auto-created Google Ads conversion action (FUS-384). The VPS drain asks core which brands have a
 * Google Ads account but no conversion action (`GET /api/conversions/setup/pending`), claims one
 * (`POST .../claim`), creates the action through AdKit, then reports the id or an error
 * (`POST .../result`). All three use the drain token in the `Authorization` header only.
 * The panel reads one brand's state through `GET /admin/brands/:id/conversion-setup`.
 * The conversion name is opaque (`cv-` plus 16 hex) so no brand text reaches Google Ads.
 */
import { z } from "zod";
import { AdkitProject, BrandId, GoogleAdsAccount, GoogleConversionAction } from "./common.js";

const Timestamp = z.iso.datetime();

/** Same pattern as the SQL CHECK in migration 0018 and the drain's name generator. */
export const ConversionName = z.string().regex(/^cv-[0-9a-f]{16}$/, "Invalid conversion name");
export type ConversionName = z.infer<typeof ConversionName>;

/** A claim older than this is treated as a crashed run and may be claimed again. */
export const CONVERSION_SETUP_LEASE_MS = 30 * 60 * 1000;
/** After this many failed attempts the row stays failed until the account changes or the owner sets an action by hand. */
export const CONVERSION_SETUP_MAX_ATTEMPTS = 5;

/** Wait before the next claim after the `attempts`-th failure: 1 h, 2 h, 4 h ... capped at 24 h. */
export function conversionSetupBackoffMs(attempts: number): number {
  const hour = 60 * 60 * 1000;
  return Math.min(2 ** Math.max(attempts - 1, 0) * hour, 24 * hour);
}

export const ConversionSetupPendingResponse = z.strictObject({
  brands: z.array(
    z.strictObject({
      brand_id: BrandId,
      account: GoogleAdsAccount,
      project: AdkitProject.nullable(),
      name: ConversionName.nullable(),
    }),
  ),
});
export type ConversionSetupPendingResponse = z.infer<typeof ConversionSetupPendingResponse>;

export const ConversionSetupClaimRequest = z.strictObject({ brand_id: BrandId, name: ConversionName });
export type ConversionSetupClaimRequest = z.infer<typeof ConversionSetupClaimRequest>;

export const ConversionSetupClaimResponse = z.strictObject({
  status: z.literal("claimed"),
  claim_id: z.string().uuid(),
  name: ConversionName,
  account: GoogleAdsAccount,
  project: AdkitProject.nullable(),
});
export type ConversionSetupClaimResponse = z.infer<typeof ConversionSetupClaimResponse>;

/** Exactly one of `conversion_action_id` or `error`: each shape forbids the other key. */
export const ConversionSetupResultRequest = z.union([
  z.strictObject({ brand_id: BrandId, claim_id: z.string().uuid(), conversion_action_id: GoogleConversionAction }),
  z.strictObject({ brand_id: BrandId, claim_id: z.string().uuid(), error: z.string().min(1).max(500) }),
]);
export type ConversionSetupResultRequest = z.infer<typeof ConversionSetupResultRequest>;

export const ConversionSetupStatus = z.enum(["none", "pending", "created", "failed"]);
export type ConversionSetupStatus = z.infer<typeof ConversionSetupStatus>;

export const ConversionSetupState = z.strictObject({
  status: ConversionSetupStatus,
  error: z.string().nullable(),
  name: ConversionName.nullable(),
  conversion_action_id: GoogleConversionAction.nullable(),
  attempts: z.number().int().min(0),
  updated_at: Timestamp.nullable(),
});
export type ConversionSetupState = z.infer<typeof ConversionSetupState>;

export const ConversionSetupStateResponse = z.strictObject({ conversion_setup: ConversionSetupState });
export type ConversionSetupStateResponse = z.infer<typeof ConversionSetupStateResponse>;
