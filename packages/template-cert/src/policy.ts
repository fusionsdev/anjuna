/** Submit-time policy only. Owner authorization and screenshot evidence at seal are separate. */
export const TEMPLATE_RULE_POLICY = {
  // Four blocking groups: brand bytes, scripts, CTA/keyword, required legal pages.
  brand: "block",
  "external-script": "block",
  cta: "block",
  keyword: "block",
  structure: "block", // required pages, static entry, server files and build limits
  // Safety checks remain blocking.
  wording: "block", // Personal Loan wording
  "archive-limits": "block",
  archive: "block",
  "published-url": "block",
  "static-html": "block",
  "template-name": "block",
  // Advisories do not prevent owner review.
  meta: "warn",
  guarantees: "warn",
  pii: "warn",
  external: "warn",
  links: "warn",
  "cta-advisory": "warn",
  similarity: "warn",
  fingerprint: "warn",
  identity_scan: "warn",
  screenshot_desktop: "warn",
  screenshot_mobile: "warn",
  "static-output": "warn",
  "host-badge": "warn",
} as const satisfies Record<string, "block" | "warn">;

export type TemplateRuleId = keyof typeof TEMPLATE_RULE_POLICY;
export type RuleDisposition = "block" | "warn";

/** New or malformed ids fail closed, including Object prototype names. */
export function ruleDisposition(checkId: string): RuleDisposition {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_RULE_POLICY, checkId)
    ? TEMPLATE_RULE_POLICY[checkId as TemplateRuleId]
    : "block";
}
