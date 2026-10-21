/**
 * Site-text preview logic shared by the Runtime config panel (ConfigPanel), which previews a live brand, and
 * the brand wizard preview, which renders a draft before install. Pure text, no React and no runtime row.
 */

const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * The brand Worker's replacement of the template brand name in an unedited title, on plain text: whole words only,
 * so "Max" leaves "Maximum" unchanged.
 */
export function replaceTemplateBrand(text: string, from: string | null | undefined, to: string): string {
  if (!from || from === to) return text;
  const chars = [...from];
  const before = WORD_CHAR.test(chars[0] ?? "") ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test(chars.at(-1) ?? "") ? "(?![\\p{L}\\p{N}])" : "";
  const literal = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${before}${literal}${after}`, "gu"), () => to);
}
