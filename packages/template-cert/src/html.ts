/**
 * HTML parsing helpers. We use `node-html-parser` (a small, dependency-light WHATWG-ish parser)
 * only to reason about element structure: h1/[data-kw], the CTA form and its inputs, forms,
 * scripts, iframes, images, links. Raw text (wording, brand bytes) is scanned as bytes, not
 * through the parser, so case and file names are checked independently.
 */

import { parse, type HTMLElement } from "node-html-parser";

export function parseHtml(html: string): HTMLElement {
  return parse(html);
}

export function attr(el: HTMLElement, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v === undefined ? undefined : v;
}

/** Lowercased, trimmed attribute value ("" when the attribute is absent). */
export function attrLower(el: HTMLElement, name: string): string {
  return (attr(el, name) ?? "").trim().toLowerCase();
}

/** True when the element contains no nested element children (text/comment only). */
export function hasNoElementChildren(el: HTMLElement): boolean {
  return el.querySelectorAll("*").length === 0;
}

/** Whether a file should be scanned as text (for wording / brand byte checks). */
export function isTextLike(path: string, bytes: Uint8Array): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (/^(html?|css|js|mjs|cjs|json|txt|svg|xml|webmanifest|map|md|webapp|ico)$/.test(ext)) return true;
  if (path.includes(".") === false) return true;
  // Sniff for binary content: a NUL byte in the first 512 bytes means binary.
  const end = Math.min(bytes.length, 512);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
  return true;
}