import { useSyncExternalStore } from 'react';

/**
 * Runtime config written by the brand Worker into
 * `<script type="application/json" id="cfg">`. Only the field this package needs is typed.
 */
export interface KeywordRuntimeConfig {
  keyword?: string | null;
}

export const CFG_ELEMENT_ID = 'cfg';

/**
 * Reads `cfg.keyword` from `<script type="application/json" id="cfg">`.
 * Returns null when there is no DOM, no cfg element, invalid JSON or no usable keyword.
 * The brand Worker has already cleaned the keyword (text only, safe charset, <= 60 chars);
 * React renders it as a text node, so it is never interpreted as HTML.
 */
export function readCfgKeyword(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string | null {
  if (!doc) return null;
  const el = doc.getElementById(CFG_ELEMENT_ID);
  if (!el || !el.textContent) return null;
  try {
    const cfg = JSON.parse(el.textContent) as KeywordRuntimeConfig | null;
    const kw = cfg && typeof cfg.keyword === 'string' ? cfg.keyword.trim() : '';
    return kw ? kw : null;
  } catch {
    return null;
  }
}

// The cfg element is written once per response by the server; it never changes on the client.
const subscribe = () => () => {};

export interface KeywordSlotProps {
  /** Default text emitted by the static build and kept when no keyword is present. */
  default: string;
}

/**
 * Template-contract keyword slot for React templates (vinext / Next.js static export, Vite SPA).
 * Place exactly one inside the page H1.
 *
 * Hydration: the static HTML contains the default text, and the brand Worker may have rewritten
 * that text to the ad keyword before the browser sees it. During hydration React uses the server
 * snapshot (the default), so the rendered tree matches what the build emitted; the text mismatch
 * against the rewritten DOM is limited to this span and silenced by `suppressHydrationWarning`,
 * which keeps the Worker's text in place. Right after hydration React re-renders with the client
 * snapshot (`cfg.keyword`), so React state and the DOM agree. In a client-only SPA (createRoot)
 * the client snapshot is used directly and the keyword renders on the first paint.
 */
export function KeywordSlot({ default: fallback }: KeywordSlotProps) {
  const text = useSyncExternalStore(
    subscribe,
    () => readCfgKeyword() ?? fallback,
    () => fallback,
  );
  // A single string child keeps this one text node, which suppressHydrationWarning covers.
  return (
    <span data-kw="" suppressHydrationWarning>
      {String(text)}
    </span>
  );
}

export default KeywordSlot;
