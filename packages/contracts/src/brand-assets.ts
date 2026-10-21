/**
 * Brand assets: the favicon and the logo a brand serves. The panel stores the bytes in the factory D1
 * (`brand_assets`, base64 text, like template upload chunks), core hands them to the brand Worker over
 * the `brandAsset` RPC, and the brand Worker serves the same bytes to every visitor.
 *
 * This module holds what the three sides share: kinds, size caps, byte sniffing, the SVG safety rule and the
 * generated initial-letter fallback. The brand-clean scan (other brands' names and domains) needs the list of
 * other brands, so the panel runs it with @anjuna/template-cert before it stores anything.
 */
import { z } from "zod";

export const BRAND_ASSET_KINDS = ["favicon", "logo"] as const;
export const BrandAssetKind = z.enum(BRAND_ASSET_KINDS);
export type BrandAssetKind = z.infer<typeof BrandAssetKind>;

/** Largest stored file per kind, in bytes. The row holds base64 text, so 256 KiB stays far below D1's 2 MB row limit. */
export const BRAND_ASSET_MAX_BYTES = { favicon: 64 * 1024, logo: 256 * 1024 } as const satisfies Record<BrandAssetKind, number>;

export const BRAND_ASSET_CONTENT_TYPES = ["image/png", "image/svg+xml", "image/x-icon"] as const;
export const BrandAssetContentType = z.enum(BRAND_ASSET_CONTENT_TYPES);
export type BrandAssetContentType = z.infer<typeof BrandAssetContentType>;

/** Public routes of a brand Worker. `/favicon.svg` serves the favicon only when it is an SVG. */
export const BRAND_ASSET_PATHS = { "/favicon.ico": "favicon", "/favicon.svg": "favicon", "/brand/logo": "logo" } as const satisfies Record<string, BrandAssetKind>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Invalid SHA-256");

/** One stored asset as the panel lists it. */
export const BrandAssetSummary = z.strictObject({
  kind: BrandAssetKind,
  content_type: BrandAssetContentType,
  byte_length: z.number().int().positive().max(BRAND_ASSET_MAX_BYTES.logo),
  sha256: Sha256,
  updated_at: z.iso.datetime(),
});
export type BrandAssetSummary = z.infer<typeof BrandAssetSummary>;

export const BrandAssetListResponse = z.strictObject({
  brand_id: z.string().min(1).max(128),
  assets: z.array(BrandAssetSummary),
});
export type BrandAssetListResponse = z.infer<typeof BrandAssetListResponse>;

/** Longest base64 text a stored asset can have. */
export const BRAND_ASSET_MAX_BASE64 = Math.ceil(BRAND_ASSET_MAX_BYTES.logo / 3) * 4;
export const BrandAssetBody = z.strictObject({
  content_type: BrandAssetContentType,
  sha256: Sha256,
  body_base64: z.string().min(4).max(BRAND_ASSET_MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Invalid base64"),
});
export type BrandAssetBody = z.infer<typeof BrandAssetBody>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (bytes: Uint8Array, prefix: number[]) => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

/** `<svg ...>` after an optional BOM, XML declaration and comments. A DOCTYPE or entity declaration is not accepted. */
const SVG_START = /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/**
 * Why SVG text is refused, or null when it is safe to serve from the brand's own origin. An uploaded SVG never
 * runs script, loads another file or sends a request: every reference must be a fragment (`#id`).
 */
export function svgSafetyIssue(text: string): string | null {
  if (/<!doctype|<!entity/i.test(text)) return "doctype";
  if (/<\s*(?:[a-z]+:)?(?:script|foreignobject|iframe|embed|object|audio|video|animate|set|handler)(?![a-z0-9])/i.test(text)) return "active_element";
  if (/[\s"'/]on[a-z]+\s*=/i.test(text)) return "event_handler";
  if (/javascript:|vbscript:|(?<![a-z0-9])data:|@import/i.test(text)) return "script_or_import";
  if (/(?:^|[\s:])href\s*=\s*(?:["'](?!#)|[^"'#\s])/i.test(text)) return "external_reference";
  if (/url\(\s*(?:["'](?!#)|[^"'#\s])/i.test(text)) return "external_reference";
  return null;
}

export type BrandAssetCheck =
  | { ok: true; content_type: BrandAssetContentType }
  | { ok: false; code: "empty" | "too_large" | "unsupported_type" | "unsafe_svg"; message: string };

/**
 * Size, type and (for SVG) safety of an upload. The type comes from the bytes, never from the file name or the
 * browser's content type. PNG and ICO are accepted for both kinds; SVG likewise.
 */
export function checkBrandAssetBytes(kind: BrandAssetKind, bytes: Uint8Array): BrandAssetCheck {
  if (bytes.byteLength === 0) return { ok: false, code: "empty", message: "The file is empty." };
  if (bytes.byteLength > BRAND_ASSET_MAX_BYTES[kind]) {
    return { ok: false, code: "too_large", message: `The ${kind} must be at most ${BRAND_ASSET_MAX_BYTES[kind]} bytes.` };
  }
  if (startsWith(bytes, PNG_SIGNATURE)) return { ok: true, content_type: "image/png" };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) > 0) return { ok: true, content_type: "image/x-icon" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimStart();
  } catch {
    return { ok: false, code: "unsupported_type", message: "Use a PNG, SVG or ICO file." };
  }
  if (!SVG_START.test(text) || !/<\/svg\s*>$/i.test(text.trimEnd())) {
    return { ok: false, code: "unsupported_type", message: "Use a PNG, SVG or ICO file." };
  }
  const unsafe = svgSafetyIssue(text);
  if (unsafe) return { ok: false, code: "unsafe_svg", message: "The SVG has scripts or references to other files. Export a plain SVG." };
  return { ok: true, content_type: "image/svg+xml" };
}

/**
 * The fallback icon: the first letter of the brand name on a colored square. The color comes from the name,
 * so the bytes depend only on the brand, never on the visitor.
 */
export function brandInitialSvg(name: string): string {
  const letter = ([...name.trim()][0] ?? "?").toUpperCase().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let hash = 0;
  for (const char of name.trim()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="hsl(${hash % 360} 55% 38%)"/>` +
    `<text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#fff">${letter}</text></svg>`;
}

/** Standard base64 of bytes, in chunks so a 256 KiB file never exceeds the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
