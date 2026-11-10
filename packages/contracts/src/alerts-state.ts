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

/**
 * One page of the alert states that carry an acknowledge or a close, in alert_key order (a key does not change while cron rewrites updated_at).
 * `next_cursor` is an opaque string: pass it back as `cursor` to read the next page. Null means this was the last page.
 * A reader that wants every state follows the cursor to the end, then sorts the rows as it needs them.
 */
export const ALERT_STATES_PAGE_DEFAULT = 200;
export const ALERT_STATES_PAGE_MAX = 500;
export const AlertStatesResponse = z.strictObject({
  rows: z.array(AlertStateRow).max(ALERT_STATES_PAGE_MAX),
  next_cursor: z.string().min(1).max(200).nullable(),
});
export type AlertStatesResponse = z.infer<typeof AlertStatesResponse>;
