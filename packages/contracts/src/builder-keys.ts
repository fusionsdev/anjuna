/** Template MCP builder keys managed from the control panel. The key is stored beside its SHA-256 hash and listed to staff. */
import { z } from "zod";

export const BUILDER_KEY_PREFIX = "anj_mcp_";

/** Timestamps stay plain strings: keys minted by hand may carry datetime('now') values. */
export const BuilderKeySummary = z.strictObject({
  key_id: z.string().min(1).max(64),
  label: z.string().min(1),
  /** Null for keys minted before migration 0007 or by hand. */
  secret: z.string().regex(/^anj_mcp_[A-Za-z0-9_-]{43}$/).nullable(),
  created_by: z.string().min(1),
  created_at: z.string().min(1),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type BuilderKeySummary = z.infer<typeof BuilderKeySummary>;

export const BuilderKeyListResponse = z.strictObject({ keys: z.array(BuilderKeySummary) });
export type BuilderKeyListResponse = z.infer<typeof BuilderKeyListResponse>;

export const BuilderKeyCreateRequest = z.strictObject({ label: z.string().trim().min(1).max(80) });
export type BuilderKeyCreateRequest = z.infer<typeof BuilderKeyCreateRequest>;

export const BuilderKeyCreateResponse = z.strictObject({ key: BuilderKeySummary });
export type BuilderKeyCreateResponse = z.infer<typeof BuilderKeyCreateResponse>;
