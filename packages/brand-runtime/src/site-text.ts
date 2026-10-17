/**
 * Site text the brand Worker writes into every page. Values come from core's live settings (dashboard
 * edits), then the brand's display name, then the revision's baked template defaults. Output depends only
 * on settings, never on the visitor.
 */
import type { BrandSettings } from "./config.js";

export interface EffectiveSiteText {
  /** [data-brand] text, cfg.brand and the consent header: dashboard value, else the brand's display name, else the template default. */
  brand: string;
  /** Dashboard title. Null keeps the template's title and og:title with the template brand name replaced. */
  title: string | null;
  /** Dashboard description. Null keeps the template's meta description and og:description. */
  description: string | null;
  /** The template's own brand name, replaced inside <title> (and the index og:title when no title was edited). */
  templateBrand: string | null;
}

export function effectiveSiteText(settings: BrandSettings): EffectiveSiteText {
  const defaults = settings.text_defaults;
  return {
    brand: settings.brand_name ?? (settings.brand || defaults?.brand_name) ?? settings.brand,
    title: settings.site_title,
    description: settings.site_description,
    templateBrand: defaults?.brand_name ?? null,
  };
}

/** Text content as HTML source. Site text never contains < > " (contract); & and ' may appear. */
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** lol-html escapes the double quote in attribute values; the ampersand is escaped here. */
const attributeValue = (value: string) => value.replace(/&/g, "&amp;");

/** The ways a template's HTML source can spell each character of the brand name; other characters match literally. */
const SOURCE_FORMS: Record<string, string> = { "&": "&amp;|&#0*38;|&#x0*26;|&", "'": "&#0*39;|&#x0*27;|&apos;|'" };
/** A character reference in the source. Matched as a whole so a brand like "amp" never matches inside "&amp;". */
const ENTITY = "&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);";
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Group 1 matches the brand name as written in HTML source; the other branch consumes whole entities.
 * A brand that starts or ends with a letter or digit needs a non-letter, non-digit neighbor there, so
 * "Max" leaves "Maximum" unchanged.
 */
function brandSourcePattern(text: string): RegExp {
  const chars = [...text];
  const parts = chars.map((char) => SOURCE_FORMS[char] ? `(?:${SOURCE_FORMS[char]})` : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const before = WORD_CHAR.test(chars[0] ?? "") ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test(chars.at(-1) ?? "") ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`(${before}${parts.join("")}${after})|${ENTITY}`, "gu");
}

/** Replace the template brand name in HTML source; entities the template wrote (&mdash;, &nbsp;) pass through. */
function brandReplacer(from: string, to: string): (source: string) => string {
  const pattern = brandSourcePattern(from);
  const replacement = escapeText(to);
  return (source) => source.replace(pattern, (match, brand: string | undefined) => brand === undefined ? match : replacement);
}

/** <title> text can arrive in several chunks: collect them, then write the replaced source once. */
function titleBrandHandler(replace: (source: string) => string): HTMLRewriterElementContentHandlers {
  let buffer = "";
  return { text(chunk) {
    buffer += chunk.text;
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }
    chunk.replace(replace(buffer), { html: true });
    buffer = "";
  } };
}

export function applySiteText(rewriter: HTMLRewriter, text: EffectiveSiteText, page: "index" | "other"): HTMLRewriter {
  let next = rewriter.on("[data-brand]", { element(element) { element.setInnerContent(text.brand); } });
  const from = text.templateBrand;
  const replace = from && from !== text.brand ? brandReplacer(from, text.brand) : null;
  // Ruling C9: only the document title and head meta tags. An inline SVG <title> in the body is an icon label.
  if (page === "index") {
    const { title, description } = text;
    if (title !== null) {
      next = next
        .on("head > title", { element(element) { element.setInnerContent(title); } })
        .on('head > meta[property="og:title"]', { element(element) { element.setAttribute("content", attributeValue(title)); } });
    } else if (replace) {
      next = next
        .on("head > title", titleBrandHandler(replace))
        .on('head > meta[property="og:title"]', { element(element) {
          const content = element.getAttribute("content");
          if (content !== null) element.setAttribute("content", replace(content));
        } });
    }
    if (description !== null) {
      next = next
        .on('head > meta[name="description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } })
        .on('head > meta[property="og:description"]', { element(element) { element.setAttribute("content", attributeValue(description)); } });
    }
    return next;
  }
  return replace ? next.on("head > title", titleBrandHandler(replace)) : next;
}
