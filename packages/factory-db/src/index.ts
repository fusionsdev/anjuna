/**
 * `factory` D1 schema: templates, certifications, form artifacts, brands, installs, audit log.
 * The SQL in `../migrations` is the source of truth (wrangler D1 migration format); this module
 * exports the migration list and the enumerations the CHECK constraints enforce.
 */

export const FACTORY_DB_MIGRATIONS = [
  "0001_factory.sql",
  "0002_builder_keys.sql",
  "0003_template_fingerprints.sql",
  "0004_lifecycle.sql",
  "0005_template_submissions.sql",
  "0006_template_uploads.sql",
  "0007_builder_key_secret.sql",
  "0008_brand_assets.sql",
  "0009_ads_account_events.sql",
  "0010_template_theme_vars.sql",
  "0011_template_theme_vars_backfill.sql",
] as const;

export const TEMPLATE_FRAMEWORKS = ["astro", "next_export", "react_spa"] as const;
export type TemplateFramework = (typeof TEMPLATE_FRAMEWORKS)[number];

export const TEMPLATE_VERSION_STATUSES = ["draft", "certifying", "certified", "rejected", "sealed"] as const;
export type TemplateVersionStatus = (typeof TEMPLATE_VERSION_STATUSES)[number];

export const CERTIFICATION_CHECKS = ["lint", "identity_scan", "screenshot_desktop", "screenshot_mobile"] as const;
export type CertificationCheck = (typeof CERTIFICATION_CHECKS)[number];

export const BRAND_STATUSES = ["draft", "installing", "live", "paused", "failed", "retired"] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const INSTALL_KINDS = ["install", "rollback", "upgrade"] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

export const INSTALL_STATUSES = ["queued", "running", "ready", "failed", "rolled_back"] as const;
export type InstallStatus = (typeof INSTALL_STATUSES)[number];

/** install-brand Workflow steps (FA-1 order), plus `rollback`. One receipt per (install, step). */
export const INSTALL_STEPS = [
  "validate",
  "save_rollback",
  "render",
  "upload_assets",
  "upload_script",
  "deploy",
  "attach_domains",
  "smoke",
  "receipt",
  "rollback",
  "provision_runtime",
  "sync_runtime",
] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export const RECEIPT_STATUSES = ["ok", "failed", "skipped"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const AUDIT_ACTOR_ROLES = ["owner", "employee", "system"] as const;
export type AuditActorRole = (typeof AUDIT_ACTOR_ROLES)[number];

/** Checklist item names shared with the lifecycle wire contract. */
export const CHECKLIST_ITEMS = ["drain_route", "leadsgate_postbacks", "test_sold", "final_url"] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

/**
 * SQL true when the install named by `installIdExpr` was undone by an automatic compensation: a compensate-<id> install
 * exists, or its ok rollback receipt names one. `installIdExpr` is a SQL expression such as `i.install_id` or `?`.
 * It appears twice in the fragment, so a caller passing `?` binds the id once per occurrence.
 * The fragment aliases its subqueries `comp` and `rb`, so callers must not use those aliases in the enclosing query.
 */
export function compensatedInstallSql(installIdExpr: string): string {
  return `(EXISTS (SELECT 1 FROM installs comp WHERE comp.install_id='compensate-' || ${installIdExpr})
    OR EXISTS (SELECT 1 FROM install_receipts rb WHERE rb.install_id=${installIdExpr} AND rb.step='rollback' AND rb.status='ok'
      AND CASE WHEN json_valid(rb.output_json) THEN json_extract(rb.output_json,'$.compensation_install_id') IS NOT NULL ELSE 0 END))`;
}

/** SQL for a version's effective theme map: the owner's backfill (template_theme_vars) over the import-time column. */
export function effectiveThemeVarsSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("invalid alias");
  return `COALESCE((SELECT o.theme_vars_json FROM template_theme_vars o WHERE o.template_version_id = ${alias}.template_version_id), ${alias}.theme_vars_json)`;
}

export { sealTemplateVersionRecord } from "./seal.js";
export type { SealFailure, SealOutcome } from "./seal.js";
