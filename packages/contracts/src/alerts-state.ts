import { z } from "zod";

export const AlertStateRow = z.strictObject({
  alert_key: z.string().min(1).max(200),
  state: z.enum(["ok", "warn", "alert"]),
  first_seen: z.iso.datetime(),
  last_sent: z.iso.datetime().nullable(),
  acknowledged_by: z.string().nullable(),
  acknowledged_at: z.iso.datetime().nullable(),
  closed_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
});
export type AlertStateRow = z.infer<typeof AlertStateRow>;
