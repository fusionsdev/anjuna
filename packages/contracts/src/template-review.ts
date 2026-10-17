/** Template submissions and review (template MCP submit_template, control panel Templates screen). */
import { z } from "zod";
import { TemplateTextDefaults } from "./site-text.js";

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
