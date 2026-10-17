/**
 * Site text defaults of a submitted template, read from index.html (spec section 3):
 *   brand_name: first [data-brand] element's text, else og:site_name, else <title> before " | "
 *   title: head > title; description: meta[name=description]
 * Each value is whitespace-collapsed, cut to its limit and dropped when it fails the site text rules.
 */
import { normalizeSiteText, type TemplateTextDefaults } from "@anjuna/contracts";
import type { FileMap } from "./archive";
import { allElements, decode, parseHtml, rawText, visibleText } from "./html";

export function extractTextDefaults(files: FileMap): TemplateTextDefaults {
  const index = files.get("index.html");
  if (!index) return { brand_name: null, title: null, description: null };
  const elements = allElements(parseHtml(decode(index)));
  const titleElement = elements.find((el) => el.name === "title" && (el.parent as { name?: string } | null)?.name === "head");
  const title = titleElement ? rawText(titleElement) : "";
  const meta = (attribute: "name" | "property", value: string): string | null =>
    elements.find((el) => el.name === "meta" && el.attribs[attribute]?.toLowerCase() === value)?.attribs.content ?? null;
  const slot = elements.find((el) => "data-brand" in el.attribs);
  const brandCandidates = [slot ? visibleText(slot) : null, meta("property", "og:site_name"), title.includes(" | ") ? title.split(" | ")[0]! : null];
  return {
    brand_name: brandCandidates.map((candidate) => normalizeSiteText(candidate, "brand_name")).find((value) => value !== null) ?? null,
    title: normalizeSiteText(title, "title"),
    description: normalizeSiteText(meta("name", "description"), "description"),
  };
}
