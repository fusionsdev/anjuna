/**
 * Site text the brand Worker writes into every page. Values come from core's live settings (dashboard
 * edits), then the revision's baked template defaults. Output depends only on settings, never on the visitor.
 */
import type { BrandSettings } from "./config.js";

export interface EffectiveSiteText {
  /** [data-brand] text, cfg.brand and the consent header: dashboard value, else template default, else the factory brand name. */
  brand: string;
  title: string | null;
  description: string | null;
  /** The template's own brand name, replaced inside other pages' <title>. */
  templateBrand: string | null;
}

export function effectiveSiteText(settings: BrandSettings): EffectiveSiteText {
  const defaults = settings.text_defaults;
  return {
    brand: settings.brand_name ?? defaults?.brand_name ?? settings.brand,
    title: settings.site_title ?? defaults?.title ?? null,
    description: settings.site_description ?? defaults?.description ?? null,
    templateBrand: defaults?.brand_name ?? null,
  };
}

/** Text content as HTML source. Site text never contains < > " (contract); & and ' may appear. */
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** lol-html escapes the double quote in attribute values; the ampersand is escaped here. */
const attributeValue = (value: string) => value.replace(/&/g, "&amp;");

/** The ways a template's HTML source can spell each character of the brand name; other characters match literally. */
const SOURCE_FORMS: Record<string, string> = { "&": "&amp;|&#0*38;|&#x0*26;|&", "'": "&#0*39;|&#x0*27;|&apos;|'" };
function sourcePattern(text: string): RegExp {
  const parts = [...text].map((char) => SOURCE_FORMS[char] ? `(?:${SOURCE_FORMS[char]})` : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join(""), "g");
}

export function applySiteText(rewriter: HTMLRewriter, text: EffectiveSiteText, page: "index" | "other"): HTMLRewriter {
  let next = rewriter.on("[data-brand]", { element(element) { element.setInnerContent(text.brand); } });
  // Ruling C9: only the document title and head meta tags. An inline SVG <title> in the body is an icon label.
  if (page === "index") {
    const { title, description } = text;
    if (title !== null) {
      next = next
        .on("head > title", { element(element) { element.setInnerContent(title); } })
        .on('head > meta[property="og:title"]', { element(element) { element.setAttribute("content", attributeValue(title)); } });
    }
    if (description !== null) {
      next = next
        .on('head > meta[name="description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } })
        .on('head > meta[property="og:description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } });
    }
    return next;
  }
  const from = text.templateBrand;
  if (!from || from === text.brand) return next;
  // Replace in the HTML source so entities the template wrote (&mdash;, &nbsp;) pass through unchanged.
  // <title> text can arrive in several chunks: collect them, then write the replaced source once.
  const pattern = sourcePattern(from);
  const replacement = escapeText(text.brand);
  let buffer = "";
  return next.on("head > title", { text(chunk) {
    buffer += chunk.text;
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }
    chunk.replace(buffer.replace(pattern, () => replacement), { html: true });
    buffer = "";
  } });
}
