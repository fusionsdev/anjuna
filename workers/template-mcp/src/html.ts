import { parseDocument } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";

export type { Element };

export const TEXT_EXT = /\.(html?|css|m?js|cjs|json|svg|txt|xml|map|webmanifest|md|csv)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

export const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

export function parseHtml(text: string) {
  return parseDocument(text, { lowerCaseAttributeNames: true, lowerCaseTags: true });
}

export function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

export function* walk(node: { children?: AnyNode[] }): Generator<Element> {
  for (const child of node.children ?? []) {
    if (isElement(child)) {
      yield child;
      yield* walk(child);
    }
  }
}

export function allElements(doc: { children: AnyNode[] }): Element[] {
  return [...walk(doc)];
}

/** Text content of a node, skipping script/style. Element boundaries become spaces. */
export function visibleText(node: { children?: AnyNode[] }): string {
  let out = "";
  const visit = (n: AnyNode) => {
    if (n.type === "text") out += n.data;
    else if (isElement(n)) {
      if (n.name === "script" || n.name === "style" || n.name === "noscript") return;
      out += " ";
      for (const c of n.children) visit(c);
      out += " ";
    }
  };
  for (const c of node.children ?? []) visit(c);
  return out.replace(/\s+/g, " ").trim();
}

export function rawText(node: { children?: AnyNode[] }): string {
  let out = "";
  for (const c of node.children ?? []) {
    if (c.type === "text") out += c.data;
    else if (isElement(c)) out += rawText(c);
  }
  return out;
}

export function hasAncestor(el: Element, name: string): boolean {
  for (let p = el.parent; p; p = p.parent) if (isElement(p as AnyNode) && (p as Element).name === name) return true;
  return false;
}

export function isExternalUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim()) && !/^data:/i.test(url.trim());
}

/** URLs found in a srcset attribute. */
export function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/** URLs referenced by CSS: url(...) and @import "..." . */
export function cssUrls(css: string): string[] {
  const urls: string[] = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (m[2]) urls.push(m[2].trim());
  for (const m of css.matchAll(/@import\s+(['"])(.*?)\1/gi)) if (m[2]) urls.push(m[2].trim());
  return urls;
}

export function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  return text.slice(start, index + length + 30).replace(/\s+/g, " ").trim();
}
