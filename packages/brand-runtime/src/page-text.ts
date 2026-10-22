/**
 * Page text a brand's revision bakes into its template pages: the wizard copy (H1, CTA, sub), the contact phone and
 * email, and the template's own brand name. The factory install render and the wizard preview both call
 * renderPageText, so the preview shows the bytes the install uploads. The brand Worker then applies live site text
 * (site-text.ts): it fills every [data-brand], including the spans written here, with the live brand name.
 * Output depends only on the revision, never on the visitor.
 */
import {
  BrandProfile, COPY_KEYWORD_MARKER, TemplateTextDefaults, renderCopyH1, validateCopy, type BrandCopy, type CopyField,
} from "@anjuna/contracts";
import { brandSourceReplacer, escapeText } from "./site-text.js";

export interface PageTextData {
  /** Public display name at render (profile.copy.brand_name, else the brand name). Never an internal ID. */
  brand_name: string;
  /** The template's own brand name: text_defaults.brand_name, else the template display name. */
  template_brand?: string | null;
  /** Default text of the H1 [data-kw] slot. Required when profile.copy.h1 is set. */
  keyword_default?: string | null;
  profile?: BrandProfile;
}

/**
 * The template's own brand name from template_versions.text_defaults_json, else the template display name
 * (templates.name). Install and preview resolve it the same way.
 */
export function templateBrandName(textDefaultsJson: string | null | undefined, templateName: string | null | undefined): string | null {
  let fromDefaults: string | null = null;
  try {
    const parsed = TemplateTextDefaults.safeParse(JSON.parse(textDefaultsJson ?? "null"));
    if (parsed.success) fromDefaults = parsed.data.brand_name;
  } catch { /* invalid JSON: no defaults */ }
  return fromDefaults ?? (templateName?.trim() || null);
}

/** The saved copy breaks the copy rules (validateCopy). Install fails with this message; the preview shows it. */
export class PageCopyError extends Error {
  override name = "PageCopyError";
}

const INDEX_PAGE = /^\/?index\.html?$/i;
/** North American numbers as templates print them: (833) 710-3200, 833-710-3200, +1 833.710.3200. */
const PHONE_TEXT = /(?<![\d+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const EMAIL_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Attributes whose text a visitor or a crawler reads. */
const TEXT_ATTRIBUTES = ["alt", "title", "aria-label", "placeholder"] as const;

/** Digits of a phone number, without the North American country code. */
function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** The copy fields the employee filled. A filled field that breaks the copy rules throws PageCopyError. */
function filledCopy(profile: BrandProfile, keywordDefault: string): Partial<BrandCopy> {
  const copy = profile.copy ?? {};
  const filled: Partial<BrandCopy> = {};
  for (const field of ["h1", "cta", "sub"] as const) if (copy[field]?.trim()) filled[field] = copy[field]!.trim();
  // Empty fields keep the template text; they get known-valid stand-ins so validateCopy judges only the filled ones.
  const probe: BrandCopy = { h1: filled.h1 ?? COPY_KEYWORD_MARKER, cta: filled.cta ?? "Continue", sub: filled.sub ?? "Check your options." };
  const issues = validateCopy(probe, keywordDefault)
    .filter((issue) => issue.field === "keyword_default" ? filled.h1 !== undefined : filled[issue.field as CopyField] !== undefined);
  if (issues.length) throw new PageCopyError(`Page copy is invalid: ${issues.map((issue) => issue.message).join(" ")}`);
  return filled;
}

/** tel: and mailto: targets the template's pages link to: the template's own contact values. */
async function templateContacts(pages: ReadonlyMap<string, string>): Promise<{ phones: Set<string>; emails: Set<string> }> {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const rewriter = new HTMLRewriter().on("a[href]", { element(element) {
    const href = (element.getAttribute("href") ?? "").trim();
    if (/^tel:/i.test(href)) {
      const digits = phoneDigits(href.slice(4));
      if (digits.length >= 7) phones.add(digits);
    } else if (/^mailto:/i.test(href)) {
      const address = href.slice(7).split("?")[0]!.trim().toLowerCase();
      if (address.includes("@")) emails.add(address);
    }
  } });
  for (const html of pages.values()) {
    if (/tel:|mailto:/i.test(html)) await rewriter.transform(new Response(html)).text();
  }
  return { phones, emails };
}

/**
 * Rewrite every HTML page of a template with the revision's page text. Pages with nothing to change come back as
 * the same string. Throws PageCopyError when filled copy breaks the copy rules.
 *   index page: <h1> gets profile.copy.h1 through renderCopyH1 (the [data-kw] slot keeps keyword_default); the CTA
 *     form's submit button gets copy.cta; the first <p> after the H1 and before the CTA form gets copy.sub.
 *   every page: [data-contact="phone|email|address"] gets the profile value (an <a> slot gets a tel:/mailto: href);
 *     tel:/mailto: links get the profile phone/email; the template's phone numbers and emails found in those links
 *     are replaced in text; the template brand name in body text becomes <span data-brand>, and in alt/title/
 *     aria-label/placeholder, meta content and JSON-LD becomes the brand name. <title>, and og:title on the index
 *     page, stay with the brand Worker, which replaces the template brand there with the live name.
 */
export async function renderPageText(pages: ReadonlyMap<string, string>, data: PageTextData): Promise<Map<string, string>> {
  const profile = BrandProfile.parse(data.profile ?? {});
  const copy = filledCopy(profile, data.keyword_default ?? "");
  const h1Html = copy.h1 === undefined ? null : renderCopyH1(copy.h1, data.keyword_default ?? "");
  const contact = profile.contact ?? {};
  const template = await templateContacts(pages);
  const from = data.template_brand?.trim() || null;
  const brand = data.brand_name.trim();
  const renameBrand = from !== null && brand !== "" && from !== brand;
  const brandSpan = renameBrand ? brandSourceReplacer(from, `<span data-brand>${escapeText(brand)}</span>`) : null;
  const brandText = renameBrand ? brandSourceReplacer(from, escapeText(brand)) : null;
  // JSON-LD is raw script text: the name goes in as a JSON string body, and "<" is escaped so it cannot close the script.
  const brandJson = renameBrand ? brandSourceReplacer(from, JSON.stringify(brand).slice(1, -1).replace(/</g, "\\u003c")) : null;
  const phoneHtml = contact.phone ? escapeText(contact.phone) : null;
  const emailHtml = contact.email ? escapeText(contact.email) : null;

  /**
   * One text node or attribute value, as HTML source. `span` wraps the brand name in a [data-brand] slot; `json` is
   * the text of a JSON-LD script.
   */
  const rewriteSource = (source: string, mode: "span" | "plain" | "json"): string => {
    let out = source;
    const replaceBrand = mode === "span" ? brandSpan : mode === "json" ? brandJson : brandText;
    if (replaceBrand) out = replaceBrand(out);
    if (phoneHtml && template.phones.size) out = out.replace(PHONE_TEXT, (match) => template.phones.has(phoneDigits(match)) ? phoneHtml : match);
    if (emailHtml && template.emails.size) out = out.replace(EMAIL_TEXT, (match) => template.emails.has(match.toLowerCase()) ? emailHtml : match);
    return out;
  };

  const out = new Map<string, string>();
  for (const [path, html] of pages) {
    const index = INDEX_PAGE.test(path);
    const pageCopy = index && (copy.h1 !== undefined || copy.cta !== undefined || copy.sub !== undefined);
    const pageContact = (phoneHtml !== null || emailHtml !== null || contact.address !== undefined) && /tel:|mailto:|data-contact/i.test(html);
    if (!pageCopy && !pageContact && !renameBrand) {
      out.set(path, html);
      continue;
    }
    out.set(path, await rewritePage(html, index));
  }
  return out;

  async function rewritePage(html: string, index: boolean): Promise<string> {
    // Text inside scripts (except JSON-LD), style and <title> is never touched; inside <textarea>, <svg> and
    // [data-brand] the brand name is plain text. An element whose end tag never arrives (a void element, a missing
    // end tag) leaves later text in the stricter mode, never in a looser one.
    const depth = { skip: 0, json: 0, plain: 0 };
    const enter = (kind: keyof typeof depth, element: Element) => {
      try {
        element.onEndTag(() => { depth[kind]--; });
      } catch { return; }
      depth[kind]++;
    };
    const track = (kind: "skip" | "plain"): HTMLRewriterElementContentHandlers => ({ element(element) {
      const jsonLd = element.tagName === "script" && element.getAttribute("type")?.trim().toLowerCase() === "application/ld+json";
      enter(jsonLd ? "json" : kind, element);
    } });
    let h1Seen = false;
    let h1Closed = false;
    let formSeen = false;
    let subDone = false;
    let buffer = "";
    let rewriter = new HTMLRewriter()
      .on("script, style, title", track("skip"))
      .on("textarea, svg, [data-brand]", track("plain"));
    if (index) {
      rewriter = rewriter
        .on("h1", { element(element) {
          if (h1Seen) return;
          h1Seen = true;
          if (h1Html !== null) element.setInnerContent(h1Html, { html: true });
          element.onEndTag(() => { h1Closed = true; });
        } })
        .on("form[data-cta]", { element() { formSeen = true; } })
        .on("p", { element(element) {
          if (copy.sub === undefined || subDone || !h1Closed || formSeen) return;
          subDone = true;
          element.setInnerContent(copy.sub);
        } });
      if (copy.cta !== undefined) {
        const cta = copy.cta;
        rewriter = rewriter
          .on('form[data-cta] button:not([type]), form[data-cta] button[type="submit"]', { element(element) { element.setInnerContent(cta); } })
          .on('form[data-cta] input[type="submit"]', { element(element) { element.setAttribute("value", cta.replace(/&/g, "&amp;")); } });
      }
    }
    rewriter = rewriter
      .on("[data-contact]", { element(element) {
        const key = element.getAttribute("data-contact");
        const value = key === "phone" ? contact.phone : key === "email" ? contact.email : key === "address" ? contact.address : undefined;
        if (!value) return;
        if (element.tagName === "a" && key === "phone") element.setAttribute("href", `tel:${value.replace(/[^\d+]/g, "")}`);
        if (element.tagName === "a" && key === "email") element.setAttribute("href", `mailto:${value}`);
        element.setInnerContent(value);
      } })
      .on("a[href]", { element(element) {
        const href = (element.getAttribute("href") ?? "").trim();
        if (contact.phone && /^tel:/i.test(href)) element.setAttribute("href", `tel:${contact.phone.replace(/[^\d+]/g, "")}`);
        if (contact.email && /^mailto:/i.test(href)) element.setAttribute("href", `mailto:${contact.email}${href.includes("?") ? href.slice(href.indexOf("?")) : ""}`);
      } })
      .on(`${TEXT_ATTRIBUTES.map((name) => `[${name}]`).join(", ")}, meta[content]`, { element(element) {
        for (const name of [...TEXT_ATTRIBUTES, "content"] as const) {
          if (name === "content" && (element.tagName !== "meta" || (index && element.getAttribute("property") === "og:title"))) continue;
          const value = element.getAttribute(name);
          if (value === null) continue;
          const next = rewriteSource(value, "plain");
          if (next !== value) element.setAttribute(name, next);
        }
      } })
      .onDocument({ text(chunk) {
        if (chunk.removed || depth.skip > 0) { buffer = ""; return; }
        // A text node can arrive in several chunks: collect them, then write the rewritten source once.
        buffer += chunk.text;
        if (!chunk.lastInTextNode) { chunk.remove(); return; }
        const source = buffer;
        buffer = "";
        const next = rewriteSource(source, depth.json > 0 ? "json" : depth.plain > 0 ? "plain" : "span");
        if (next !== source || chunk.text !== source) chunk.replace(next, { html: true });
      } });
    return rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  }
}
