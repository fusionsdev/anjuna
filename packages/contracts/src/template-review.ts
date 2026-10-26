/** Template submissions and review (template MCP submit_template, control panel Templates screen). */
import { z } from "zod";
import { TemplateTextDefaults } from "./site-text.js";
import { TemplateThemeVars } from "./theme.js";

export const TEMPLATE_REVIEW_STATUSES = ["checking", "rejected", "awaiting_approval", "approved"] as const;
export const TemplateReviewStatus = z.enum(TEMPLATE_REVIEW_STATUSES);
export type TemplateReviewStatus = z.infer<typeof TemplateReviewStatus>;

/** factory D1 template_versions.status -> what the builder and the dashboard see. */
export const TEMPLATE_VERSION_REVIEW_STATUS = {
  draft: "checking",
  certifying: "checking",
  rejected: "rejected",
  certified: "awaiting_approval",
  sealed: "approved",
} as const satisfies Record<string, TemplateReviewStatus>;
export type TemplateVersionStatusName = keyof typeof TEMPLATE_VERSION_REVIEW_STATUS;

export const TemplateId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use 2-63 lowercase letters, digits or dashes");

/** A template id from a display name. Names without Latin letters get a stable "tpl-" id from their code points. */
export function templateSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (slug.length >= 2) return slug;
  const code = [...name.trim()].map((c) => c.codePointAt(0)!.toString(36)).join("").slice(0, 40);
  return `tpl-${code || "x"}`;
}

export const TemplateSubmitIssue = z.strictObject({
  rule: z.string().min(1),
  file: z.string().optional(),
  message: z.string().min(1),
  fix: z.string().min(1),
});
export type TemplateSubmitIssue = z.infer<typeof TemplateSubmitIssue>;

export const TemplateSubmitResult = z.strictObject({
  status: z.enum(["awaiting_approval", "rejected", "duplicate"]),
  template_version_id: z.string().nullable(),
  version: z.number().int().positive().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  dashboard_url: z.string().nullable(),
  issues: z.array(TemplateSubmitIssue),
  warnings: z.array(TemplateSubmitIssue),
  text_defaults: TemplateTextDefaults.nullable(),
  similarity: z.strictObject({ pass: z.boolean(), summary: z.string(), fixes: z.array(z.string()) }).nullable(),
  next_step: z.string().min(1),
});
export type TemplateSubmitResult = z.infer<typeof TemplateSubmitResult>;

// ── Control panel: Templates screen ─────────────────────────────────────────────

/** Timestamps stay plain strings: rows written by hand with datetime('now') must still list. */
const Stamp = z.string().min(1);

export const TemplateVersionSummary = z.strictObject({
  template_version_id: z.string().min(1).max(128),
  template_id: z.string().min(1).max(64),
  name: z.string().min(1),
  version: z.number().int().positive(),
  status: TemplateReviewStatus,
  submitted_by_label: z.string().nullable(),
  created_at: Stamp,
  sealed_at: Stamp.nullable(),
  thumbnail_url: z.string().nullable().default(null),
  brands_using: z.number().int().nonnegative().default(0),
});
export type TemplateVersionSummary = z.infer<typeof TemplateVersionSummary>;

export const TemplateListResponse = z.strictObject({ templates: z.array(TemplateVersionSummary) });
export type TemplateListResponse = z.infer<typeof TemplateListResponse>;

export const TemplateCheckResult = z.strictObject({
  check_name: z.enum(["lint", "identity_scan", "screenshot_desktop", "screenshot_mobile"]),
  result: z.enum(["pass", "fail"]),
  details: z.unknown(),
  created_at: Stamp,
});
export type TemplateCheckResult = z.infer<typeof TemplateCheckResult>;

export const TemplateDetailResponse = z.strictObject({
  template: TemplateVersionSummary.extend({
    sha256: z.string(),
    sealed_by: z.string().nullable(),
    text_defaults: TemplateTextDefaults.nullable(),
    theme_vars: TemplateThemeVars.nullable(),
  }),
  checks: z.array(TemplateCheckResult),
  screenshots: z.strictObject({ desktop: z.string().nullable(), mobile: z.string().nullable() }),
});
export type TemplateDetailResponse = z.infer<typeof TemplateDetailResponse>;

export const TemplateImportRequest = z.strictObject({
  url: z.url(),
  template_name: z.string().trim().min(1).max(128),
});
export type TemplateImportRequest = z.infer<typeof TemplateImportRequest>;

/** Approve may carry the owner's corrected color variable map; absent keeps the detected one. */
export const TemplateApproveRequest = z.strictObject({ theme_vars: TemplateThemeVars.optional() });
export type TemplateApproveRequest = z.infer<typeof TemplateApproveRequest>;

export const TemplateApproveResponse = z.strictObject({
  ok: z.literal(true),
  template_version_id: z.string(),
  sealed_by: z.string(),
  sealed_at: z.string(),
  already_sealed: z.boolean(),
});
export type TemplateApproveResponse = z.infer<typeof TemplateApproveResponse>;
