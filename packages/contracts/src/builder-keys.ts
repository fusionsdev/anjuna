/** Template MCP builder keys managed from the control panel (owner only). Only a SHA-256 hash is stored. */
import { z } from "zod";

export const BUILDER_KEY_PREFIX = "anj_mcp_";

/** Timestamps stay plain strings: keys minted by hand may carry datetime('now') values. */
export const BuilderKeySummary = z.strictObject({
  key_id: z.string().min(1).max(64),
  label: z.string().min(1),
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

export const BuilderKeyCreateResponse = z.strictObject({
  key: BuilderKeySummary,
  /** Shown once; the server keeps only its SHA-256 hash. */
  secret: z.string().regex(/^anj_mcp_[A-Za-z0-9_-]{43}$/),
});
export type BuilderKeyCreateResponse = z.infer<typeof BuilderKeyCreateResponse>;
