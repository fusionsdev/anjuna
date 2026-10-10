import { z } from "zod";

/** Shared identifiers used by RPC and admin schemas (no dependency between those modules). */
export const OpaqueToken = z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/, "Invalid token");
export const ExperimentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const VariantId = z.string().regex(/^[a-z0-9_-]{1,32}$/);

/** Opaque brand id from `brand_runtime`. Never served to the browser (BR-5). */
export const BrandId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Invalid brand_id");
export type BrandId = z.infer<typeof BrandId>;

/** Lowercase hostname without port or scheme, e.g. `example.com` or `www.example.com`. */
export const Hostname = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, "Invalid hostname");
export type Hostname = z.infer<typeof Hostname>;

/**
 * Charset and length of a brand screen name (1 to 60 characters; letters, marks, digits, space, & . ' -),
 * with surrounding whitespace tolerated because the value is trimmed. `&` and `-` are written as
 * \x26 and \x2d so the source compiles as an HTML `pattern` under both the u and v flags.
 * The forbidden-word check is not a charset rule and lives in `BrandName`.
 */
export const BRAND_NAME_PATTERN = String.raw`\s*[\p{L}\p{N}][\p{L}\p{M}\p{N} .\x26'\x2d]{0,59}\s*`;

/** Brand screen name. The control panel server and the create form both use this rule. */
export const BrandName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(new RegExp(`^(?:${BRAND_NAME_PATTERN})$`, "u"), "ชื่อแบรนด์ใช้ได้เฉพาะตัวอักษร ตัวเลข ช่องว่าง และ & . ' -")
  .refine(isBrandClean, "ชื่อแบรนด์มีคำที่ไม่อนุญาต");
export type BrandName = z.infer<typeof BrandName>;

/** Five-digit US ZIP. */
export const Zip5 = z.string().regex(/^\d{5}$/, "Invalid ZIP");

/** Strings that must never appear in anything a brand serves (AGENTS.md hard rule 4). */
export const FORBIDDEN_BRAND_STRINGS = ["anjuna", "aurum"] as const;

/** True when `s` contains none of FORBIDDEN_BRAND_STRINGS (case-insensitive). */
export function isBrandClean(s: string): boolean {
  const lower = s.toLowerCase();
  return !FORBIDDEN_BRAND_STRINGS.some((w) => lower.includes(w));
}
