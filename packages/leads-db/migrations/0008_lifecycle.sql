-- Migration 0008 — core runtime lifecycle visibility.

ALTER TABLE brand_runtime ADD COLUMN form_version TEXT;
ALTER TABLE brand_runtime ADD COLUMN applied_revision_id TEXT;
ALTER TABLE brand_runtime ADD COLUMN last_lifecycle_install_id TEXT;
