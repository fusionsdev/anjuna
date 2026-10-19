import { parseDocument } from "htmlparser2";
import type { FileMap } from "./archive";
import { allElements, decode } from "./html";

/** Script tags that hosting platforms inject at publish time. They are not part of the template, so URL import removes them. */
const HOST_BADGE_SCRIPTS: readonly { host: string; matches: (src: URL) => boolean }[] = [
  // bolt.host adds "Built with Bolt" to every published page. The query string carries a site id and may vary.
  { host: "bolt.host", matches: (src) => src.hostname === "bolt.new" && src.pathname === "/badge.js" },
];

export interface StrippedBadge { file: string; host: string }

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const MAX_BADGE_TAG_LENGTH = 512;

/** Source ranges [start, end) of the script elements whose src the matcher accepts, in document order. */
function badgeRanges(html: string, matches: (src: URL) => boolean): [number, number][] {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const ranges: [number, number][] = [];
  for (const el of allElements(doc)) {
    if (el.name !== "script" || el.endIndex === null) continue;
    const start = el.startIndex ?? 0;
    // An unclosed or non-empty tag is not the injected badge, and cutting to end of file would destroy the page.
    if (el.children.length > 0 || el.endIndex - start > MAX_BADGE_TAG_LENGTH) continue;
    const src = parseUrl(el.attribs.src);
    if (src && matches(src)) ranges.push([start, el.endIndex + 1]);
  }
  return ranges;
}

/**
 * Remove host-injected badge scripts from every HTML file. Returns the new map and one entry per file changed.
 * Only the script element is cut out, so the whitespace around it stays. A file with no match keeps its original bytes;
 * a rewritten file loses a leading BOM because decode() drops it.
 */
export function stripHostBadges(files: FileMap): { files: FileMap; stripped: StrippedBadge[] } {
  const next: FileMap = new Map();
  const stripped: StrippedBadge[] = [];
  for (const [path, bytes] of files) {
    if (!/\.html?$/i.test(path)) {
      next.set(path, bytes);
      continue;
    }
    let text = decode(bytes);
    let changed = false;
    for (const { host, matches } of HOST_BADGE_SCRIPTS) {
      const ranges = badgeRanges(text, matches);
      if (ranges.length === 0) continue;
      for (let i = ranges.length - 1; i >= 0; i--) text = text.slice(0, ranges[i]![0]) + text.slice(ranges[i]![1]);
      stripped.push({ file: path, host });
      changed = true;
    }
    next.set(path, changed ? new TextEncoder().encode(text) : bytes);
  }
  return { files: next, stripped };
}
