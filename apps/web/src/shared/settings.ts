/**
 * Shape of GET /api/settings/brands (src/server/settings.ts) shared with the SPA. Panel-only: not a core admin contract.
 */
import { BrandConfig, BrandId, Hostname } from "@anjuna/contracts";
import { z } from "zod";

/** One brand of the Settings table. `unavailable` = core listed the brand but its getBrand failed. */
export const SettingsRow = z.union([
  z.strictObject({ brand_id: BrandId, hostname: Hostname, brand: BrandConfig, error: z.null() }),
  z.strictObject({ brand_id: BrandId, hostname: Hostname, brand: z.null(), error: z.literal("unavailable") }),
]);
export type SettingsRow = z.infer<typeof SettingsRow>;

export const SettingsBrandsResponse = z.strictObject({
  rows: z.array(SettingsRow),
  generated_at: z.iso.datetime(),
});
export type SettingsBrandsResponse = z.infer<typeof SettingsBrandsResponse>;
