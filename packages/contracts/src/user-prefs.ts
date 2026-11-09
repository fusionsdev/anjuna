import { z } from "zod";
import { BrandId } from "./common.js";

export const UserPrefs = z.strictObject({
  brand_scope: z.strictObject({
    hide_inactive: z.boolean(), show_demo: z.boolean(), brand_ids: z.array(BrandId).max(500).nullable(),
  }),
  saved_views: z.record(z.string().min(1).max(100), z.json()),
});
export type UserPrefs = z.infer<typeof UserPrefs>;
