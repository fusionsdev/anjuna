-- Migration 0011: per-brand site text edited in the control panel.
-- NULL means "use the template default" (the revision's config_json text_defaults).
-- Core validates values on save (length, brand clean, no "personal loan" wording); the CHECKs bound the length.

ALTER TABLE brand_runtime ADD COLUMN brand_name TEXT
  CHECK (brand_name IS NULL OR length(brand_name) BETWEEN 1 AND 80);
ALTER TABLE brand_runtime ADD COLUMN site_title TEXT
  CHECK (site_title IS NULL OR length(site_title) BETWEEN 1 AND 70);
ALTER TABLE brand_runtime ADD COLUMN site_description TEXT
  CHECK (site_description IS NULL OR length(site_description) BETWEEN 1 AND 160);
