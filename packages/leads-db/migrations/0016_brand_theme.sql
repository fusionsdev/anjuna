-- Migration 0016: the brand's two colors (FUS-381), edited in the control panel Settings.
-- NULL means "use the template colors". Core validates the hex values on save; the CHECK
-- only guarantees the column holds JSON (or NULL).

ALTER TABLE brand_runtime ADD COLUMN theme_json TEXT
  CHECK (theme_json IS NULL OR json_valid(theme_json));
