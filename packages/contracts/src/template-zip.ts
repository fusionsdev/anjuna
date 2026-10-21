import { z } from "zod";
import { TemplateId } from "./template-review.js";

/** The same upload limits apply to the panel and template MCP. */
export const TEMPLATE_ZIP_LIMITS = {
  maxArchiveBytes: 30 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
} as const;

export const TemplateZipImportRequest = z.strictObject({
  template_id: TemplateId,
  template_name: z.string().trim().min(1).max(128),
});
export type TemplateZipImportRequest = z.infer<typeof TemplateZipImportRequest>;
export type TemplateZipType = "astro" | "bolt_static" | "vite_react";
/** Multipart overhead allowance above the archive limit; readers cap request bytes at this size. */
export const TEMPLATE_ZIP_FORM_MAX_BYTES = TEMPLATE_ZIP_LIMITS.maxArchiveBytes + 16 * 1024;
export const TEMPLATE_ZIP_BUILD_MESSAGE = "Upload the built dist folder";

/** Select built output without executing a build. Archive safety is checked before this step. */
export function templateZipRoot(input: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  let files = new Map([...input].filter(([path]) =>
    !path.endsWith("/") && !path.startsWith("__MACOSX/") && !path.split("/").includes(".DS_Store")));
  for (;;) {
    // Prefer dist even when the source project also has an index.html at the root.
    if (files.has("dist/index.html")) {
      return new Map([...files].filter(([path]) => path.startsWith("dist/")).map(([path, bytes]) => [path.slice(5), bytes]));
    }
    if (files.has("index.html") || files.size === 0) return files;
    const tops = new Set([...files.keys()].map((path) => path.split("/")[0]));
    if (tops.size !== 1 || [...files.keys()].some((path) => !path.includes("/"))) return files;
    files = new Map([...files].map(([path, bytes]) => [path.slice(path.indexOf("/") + 1), bytes]));
  }
}

/** Pure byte-to-text for markup checks. The contracts package has no TextDecoder type. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}

/** Detection is a hint, not certification. Every accepted upload still runs the shared checks. */
export function detectTemplateZip(input: ReadonlyMap<string, Uint8Array>): TemplateZipType {
  const files = templateZipRoot(input);
  const index = files.get("index.html");
  const paths = [...files.keys()];
  if (!index) throw new Error(TEMPLATE_ZIP_BUILD_MESSAGE);
  const html = latin1(index);
  if (paths.some((path) =>
    /(^|\/)(?:src|node_modules)\//.test(path) || /\.(?:tsx?|jsx|astro|vue|svelte)$/.test(path) ||
    /(^|\/)(?:package\.json|(?:astro|vite|next)\.config\.[^/]+)$/.test(path)) ||
    /(?:src|href)\s*=\s*["'][^"']*\.(?:tsx?|jsx)(?:[?#][^"']*)?["']/i.test(html)) {
    throw new Error(TEMPLATE_ZIP_BUILD_MESSAGE);
  }
  if (paths.some((path) => path.startsWith("_astro/")) || /<meta\b[^>]*content=["']Astro\b/i.test(html)) return "astro";
  if (/<script\b[^>]*type\s*=\s*["']module["']/i.test(html) &&
    paths.some((path) => /^assets\/.*\.m?js$/.test(path))) return "vite_react";
  return "bolt_static";
}
