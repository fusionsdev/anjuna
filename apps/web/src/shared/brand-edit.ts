/**
 * Shapes of the brand edit routes (src/server/brand-edit.ts) shared with the SPA. Panel-only: none of these are core admin contracts.
 */
import { MicrosoftAdsAccount } from "@anjuna/contracts";
import { z } from "zod";

/** GET /api/brands/:id/edit: what the live brand runs, as the config panel shows it. */
export const BrandEditState = z.strictObject({
  brand_id: z.string().min(1).max(128),
  status: z.string().min(1),
  /** The template version of the brand's current revision (latest revision before the first install). */
  template_version_id: z.string().min(1).max(128),
  /** profile.ads.microsoft_ads_account of that revision. Null = not set. */
  microsoft_ads_account: MicrosoftAdsAccount.nullable(),
});
export type BrandEditState = z.infer<typeof BrandEditState>;

/** PATCH /api/brands/:id/microsoft-ads. Null clears the account. */
export const MicrosoftAdsRequest = z.strictObject({ microsoft_ads_account: MicrosoftAdsAccount.nullable() });
export type MicrosoftAdsRequest = z.infer<typeof MicrosoftAdsRequest>;
