-- Migration 0012: per-brand Google Ads drain route, edited in the control panel.
-- Core serves these rows to the VPS drain as BRAND_ROUTING_JSON (GET /api/conversions/routing).
-- NULL means "not routed": the drain skips the brand until account and conversion action are both set.
-- Core validates values on save; the CHECKs bound the shape.

ALTER TABLE brand_runtime ADD COLUMN google_ads_account TEXT
  CHECK (google_ads_account IS NULL OR (length(google_ads_account) = 10 AND google_ads_account NOT GLOB '*[^0-9]*'));
ALTER TABLE brand_runtime ADD COLUMN google_conversion_action TEXT
  CHECK (google_conversion_action IS NULL OR (length(google_conversion_action) BETWEEN 1 AND 20 AND google_conversion_action NOT GLOB '*[^0-9]*'));
ALTER TABLE brand_runtime ADD COLUMN adkit_project TEXT
  CHECK (adkit_project IS NULL OR (length(adkit_project) BETWEEN 1 AND 64 AND adkit_project NOT GLOB '*[^A-Za-z0-9_-]*'));
