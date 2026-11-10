import { isBrandClean } from "./common.js";
import { cleanKeyword } from "./runtime-config.js";
import { TEMPLATE_RULES } from "./template.js";

/** Plain-text copy uses this token; renderCopyH1 emits the existing KeywordSlot markup. The slot shows the brand name. */
export const COPY_KEYWORD_MARKER = "{{keyword}}";
/** H1 limit counts the visible text with the slot text (the brand name; keyword_default when none is given) substituted. */
export const COPY_LIMITS = { h1: 140, cta: 40, sub: 240 } as const;
export type CopyField = keyof typeof COPY_LIMITS;
export interface BrandCopy { h1: string; cta: string; sub: string }
export interface CopyIssue {
  field: CopyField | "keyword_default" | "adapter";
  code: "required" | "plain_text" | "length" | "forbidden_wording" | "brand_clean" | "keyword_slot" | "adapter_failed";
  message: string;
}

/** Match the identities/credentials forbidden by the final rendered-byte check too. */
function cleanCopy(value: string): boolean {
  return isBrandClean(value) && !/brand_[0-9a-f]{16}|ph[cx]_[a-z0-9]{16,}|https?:\/\/[^\s"'<>/@]+(?::[^\s"'<>/@]+)?@[a-z0-9.-]+(?::\d+)?\/\d+|[a-z0-9-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io/i.test(value);
}

/**
 * Validate without rewriting employee text. Issues never echo an untrusted value. `slotText` is what the H1 marker
 * becomes on the page; it defaults to keywordDefault, which is always checked as the brand's keyword.
 */
export function validateCopy(copy: BrandCopy, keywordDefault: string, slotText: string = keywordDefault): CopyIssue[] {
  const issues: CopyIssue[] = [];
  const add = (field: CopyIssue["field"], code: CopyIssue["code"], message: string) => issues.push({ field, code, message });
  if (typeof keywordDefault !== "string" || !keywordDefault || cleanKeyword(keywordDefault) !== keywordDefault) {
    add("keyword_default", "keyword_slot", "Use a clean title-case keyword of 1–60 characters.");
  } else {
    if (!cleanCopy(keywordDefault)) add("keyword_default", "brand_clean", "Keyword contains a forbidden identity or credential.");
    if (TEMPLATE_RULES.forbiddenWording.test(keywordDefault)) add("keyword_default", "forbidden_wording", 'Keyword must not use "personal loan" wording.');
  }
  for (const field of Object.keys(COPY_LIMITS) as CopyField[]) {
    const value = copy[field];
    if (typeof value !== "string" || !value.trim()) {
      add(field, "required", `${field} needs text.`);
      continue;
    }
    if (/[\u0000-\u001f\u007f<>"\u2028\u2029]/.test(value)) add(field, "plain_text", `${field} must be a single line of plain text without HTML or double quotes.`);
    const visible = field === "h1" ? value.replaceAll(COPY_KEYWORD_MARKER, typeof slotText === "string" ? slotText : "") : value;
    if (!cleanCopy(value) || !cleanCopy(visible)) add(field, "brand_clean", `${field} contains a forbidden identity or credential.`);
    if (TEMPLATE_RULES.forbiddenWording.test(visible)) add(field, "forbidden_wording", `${field} must not use "personal loan" wording.`);
    if (visible.length > COPY_LIMITS[field]) add(field, "length", `${field} must be at most ${COPY_LIMITS[field]} visible characters.`);
    if (field === "h1") {
      if (value.split(COPY_KEYWORD_MARKER).length !== 2 || /[{}]/.test(value.replace(COPY_KEYWORD_MARKER, ""))) {
        add(field, "keyword_slot", `h1 must contain exactly one ${COPY_KEYWORD_MARKER} token and no other placeholders.`);
      }
    } else if (/[{}]/.test(value)) {
      add(field, "keyword_slot", `${field} must not contain placeholders.`);
    }
  }
  return issues;
}

/** Escaped H1 inner HTML. The caller replaces the single H1's contents at render time. The slot holds `slotText`. */
export function renderCopyH1(h1: string, keywordDefault: string, slotText: string = keywordDefault): string {
  const issues = validateCopy({ h1, cta: "Continue", sub: "Check your options." }, keywordDefault, slotText);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join(" "));
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const [before, after] = h1.split(COPY_KEYWORD_MARKER);
  return `${escape(before!)}${TEMPLATE_RULES.keywordSlotMarkup}${escape(slotText)}</span>${escape(after!)}`;
}
