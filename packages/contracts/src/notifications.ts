import { z } from "zod";

const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const NotifySettings = z.strictObject({
  telegram: z.strictObject({ enabled: z.boolean(), chat_ids: z.array(z.string().regex(/^-?\d+$/)).max(20) }),
  routing: z.record(z.string().min(1).max(100), z.strictObject({
    telegram: z.boolean(),
    repeat_hours: z.union([z.literal(1), z.literal(6), z.literal(24)]),
    quiet: z.strictObject({ from: Time, to: Time }).nullable(),
  })),
  digest: z.strictObject({ enabled: z.boolean(), time: Time }),
});
export type NotifySettings = z.infer<typeof NotifySettings>;

export const NotificationLogRow = z.strictObject({
  id: z.string().min(1), channel: z.literal("telegram"), target: z.string(),
  alert_key: z.string().min(1), status: z.enum(["sent", "failed"]),
  response_code: z.number().int().min(100).max(599).nullable(),
  body_hash: z.string().regex(/^[a-f0-9]{64}$/), sent_at: z.iso.datetime(),
});
export type NotificationLogRow = z.infer<typeof NotificationLogRow>;
