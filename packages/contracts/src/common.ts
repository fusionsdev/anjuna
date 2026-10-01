import { z } from "zod";

/** Opaque brand id from `brand_runtime`. Never served to the browser (BR-5). */
export const BrandId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Invalid brand_id");
export type BrandId = z.infer<typeof BrandId>;

/** Lowercase hostname without port or scheme, e.g. `example.com` or `www.example.com`. */
export const Hostname = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, "Invalid hostname");
export type Hostname = z.infer<typeof Hostname>;

/** Five-digit US ZIP. */
export const Zip5 = z.string().regex(/^\d{5}$/, "Invalid ZIP");

/** Strings that must never appear in anything a brand serves (AGENTS.md hard rule 4). */
export const FORBIDDEN_BRAND_STRINGS = ["anjuna", "aurum"] as const;

/** True when `s` contains none of FORBIDDEN_BRAND_STRINGS (case-insensitive). */
export function isBrandClean(s: string): boolean {
  const lower = s.toLowerCase();
  return !FORBIDDEN_BRAND_STRINGS.some((w) => lower.includes(w));
}
