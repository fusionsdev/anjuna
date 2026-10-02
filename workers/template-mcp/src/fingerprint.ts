/**
 * Template fingerprints for the uniqueness check. Each brand must ship a visibly different design,
 * so sealed templates store a compact fingerprint and new candidates are compared against all of them.
 * Signals: DOM structure shingles, CSS class set, section order, image hashes, visible-text shingles.
 * Set signals are stored as bottom-k sketches (exact below k members).
 */
import type { FileMap } from "./archive";
import { normalizeRoot } from "./checker";
import { IMAGE_EXT, allElements, decode, parseHtml, visibleText, type Element } from "./html";

const SKETCH_K = 256;
const SECTION_TAGS = new Set(["header", "nav", "main", "section", "article", "aside", "footer", "form"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "path", "head", "title", "meta", "link"]);

export interface Fingerprint {
  v: 1;
  dom: number[];
  classes: number[];
  sections: string[];
  images: string[];
  text: number[];
}

/** FNV-1a 32-bit. Deterministic and synchronous. */
export function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const sketch = (hashes: Iterable<number>): number[] => [...new Set(hashes)].sort((a, b) => a - b).slice(0, SKETCH_K);

function shingles<T>(items: T[], k: number, toStr: (items: T[]) => string): number[] {
  const out: number[] = [];
  if (items.length < k) return items.length ? [hash32(toStr(items))] : out;
  for (let i = 0; i + k <= items.length; i++) out.push(hash32(toStr(items.slice(i, i + k))));
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeFingerprint(input: FileMap): Promise<Fingerprint> {
  const { files } = normalizeRoot(input);
  const indexText = files.has("index.html") ? decode(files.get("index.html")!) : "";
  const doc = parseHtml(indexText);
  const els = allElements(doc);

  // DOM structure: pre-order tag sequence of the body, 4-tag shingles.
  const body = els.find((e) => e.name === "body");
  const tags: string[] = [];
  const visit = (el: Element) => {
    if (SKIP_TAGS.has(el.name)) return;
    tags.push(el.name);
    for (const c of el.children) if (c.type === "tag") visit(c);
  };
  for (const c of (body ?? doc).children) if (c.type === "tag") visit(c);

  // Classes used in the markup (Astro scope hashes and Tailwind utilities included).
  const classes = new Set<number>();
  for (const el of els) for (const cls of (el.attribs.class ?? "").split(/\s+/)) if (cls && !/^astro-[a-z0-9]+$/.test(cls)) classes.add(hash32(cls));

  // Section order: landmark/section elements with the heading level they open with.
  const sections: string[] = [];
  for (const el of els) {
    if (!SECTION_TAGS.has(el.name)) continue;
    const heading = findHeading(el);
    sections.push(heading ? `${el.name}:${heading}` : el.name);
  }

  // Images: content hashes of image files (SVG whitespace-normalized).
  const images = new Set<string>();
  for (const [path, bytes] of files) {
    if (!IMAGE_EXT.test(path) || bytes.length < 256) continue;
    const data = /\.svg$/i.test(path) ? new TextEncoder().encode(decode(bytes).replace(/\s+/g, " ").trim()) : bytes;
    images.add(await sha256Hex(data));
  }

  // Visible text: 5-word shingles of the landing page copy.
  const words = visibleText(doc).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

  return {
    v: 1,
    dom: sketch(shingles(tags, 4, (t) => t.join(">"))),
    classes: sketch(classes),
    sections: sections.slice(0, 80),
    images: [...images].sort().slice(0, 200),
    text: sketch(shingles(words, 5, (w) => w.join(" "))),
  };
}

function findHeading(el: Element): string | null {
  const stack: Element[] = [el];
  while (stack.length) {
    const cur = stack.shift()!;
    if (/^h[1-6]$/.test(cur.name)) return cur.name;
    for (const c of cur.children) if (c.type === "tag") stack.push(c);
  }
  return null;
}

/** Jaccard similarity of two bottom-k sketches (exact when both are below k). */
export function sketchJaccard(a: number[], b: number[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  const merged = [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, SKETCH_K);
  let both = 0;
  for (const h of merged) if (sa.has(h) && sb.has(h)) both++;
  return merged.length ? both / merged.length : 0;
}

function setJaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  let both = 0;
  for (const x of new Set(b)) if (sa.has(x)) both++;
  const union = new Set([...a, ...b]).size;
  return union ? both / union : 0;
}

/** 1 - normalized edit distance of two sequences. */
function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

export interface SignalScores {
  text: number;
  dom: number;
  classes: number;
  sections: number;
  images: number | null;
}

export const WEIGHTS = { text: 0.3, dom: 0.25, classes: 0.15, sections: 0.15, images: 0.15 } as const;

export function compareFingerprints(candidate: Fingerprint, other: Fingerprint): { score: number; signals: SignalScores; sharedImages: number } {
  const sharedImages = candidate.images.filter((i) => other.images.includes(i)).length;
  const signals: SignalScores = {
    text: sketchJaccard(candidate.text, other.text),
    dom: sketchJaccard(candidate.dom, other.dom),
    classes: sketchJaccard(candidate.classes, other.classes),
    sections: sequenceSimilarity(candidate.sections, other.sections),
    images: candidate.images.length && other.images.length ? setJaccard(candidate.images, other.images) : null,
  };
  let weight = 0;
  let sum = 0;
  for (const key of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    const value = signals[key];
    if (value === null) continue;
    weight += WEIGHTS[key];
    sum += WEIGHTS[key] * value;
  }
  return { score: weight ? sum / weight : 0, signals, sharedImages };
}

export const SIGNAL_FIXES: Record<keyof SignalScores, string> = {
  text: "Rewrite the landing-page copy from scratch: different headlines, section copy, wording and CTA text.",
  dom: "Change the page structure: different section layout, nesting and components (not just colors).",
  classes: "Use a different CSS approach and class vocabulary (new design tokens, component names, layout system).",
  sections: "Reorder or replace the page sections (hero, benefits, steps, FAQ, trust) so the section sequence differs.",
  images: "Replace shared images, icons and illustrations with new, original assets for this brand.",
};
