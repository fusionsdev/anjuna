-- Migration 0011: the owner's theme variable map for a template version, kept apart from the version row.
--
-- A sealed template_versions row is immutable (TP-3, trigger template_versions_sealed_immutable), so a map detected
-- or corrected after sealing cannot be written to template_versions.theme_vars_json. It goes here, one row per
-- version. The effective map of a version is this row when it exists, else the import-time column. Never lead data,
-- never secrets.

CREATE TABLE IF NOT EXISTS template_theme_vars (
  template_version_id TEXT PRIMARY KEY REFERENCES template_versions(template_version_id),
  theme_vars_json TEXT NOT NULL CHECK (json_valid(theme_vars_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
