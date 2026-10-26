-- Migration 0010: the theme variables detected in a submitted template.
--
-- The submit pipeline reads the template's CSS and records which custom properties carry the primary, primary dark
-- and secondary colors, as {"primary": [...], "primary_dark": [...], "secondary": [...]}. The owner can correct the
-- map on approve. NULL means no detection ran (a version imported before this column existed). Never lead data,
-- never secrets.

ALTER TABLE template_versions ADD COLUMN theme_vars_json TEXT CHECK (theme_vars_json IS NULL OR json_valid(theme_vars_json));
