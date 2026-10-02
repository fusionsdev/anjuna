/**
 * `factory` D1 schema: templates, certifications, form artifacts, brands, installs, audit log.
 * The SQL in `../migrations` is the source of truth (wrangler D1 migration format); this module
 * exports the migration list and the enumerations the CHECK constraints enforce.
 */

export const FACTORY_DB_MIGRATIONS = ["0001_factory.sql", "0002_builder_keys.sql", "0003_template_fingerprints.sql"] as const;

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
] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

export const RECEIPT_STATUSES = ["ok", "failed", "skipped"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const AUDIT_ACTOR_ROLES = ["owner", "employee", "system"] as const;
export type AuditActorRole = (typeof AUDIT_ACTOR_ROLES)[number];
