-- Migration 0005: builder submissions (template MCP submit_template / submit_template_url).
--
-- text_defaults_json: brand name, page title and meta description extracted from index.html at submit
-- time. They are copied into each brand revision's config_json as the baked fallback.
-- submitted_by_key_id / submitted_by_label: the builder key (or dashboard user) that sent the version.
-- Set before sealing; sealed versions stay immutable (trigger in 0001).

ALTER TABLE template_versions ADD COLUMN text_defaults_json TEXT
  CHECK (text_defaults_json IS NULL OR json_valid(text_defaults_json));
ALTER TABLE template_versions ADD COLUMN submitted_by_key_id TEXT;
ALTER TABLE template_versions ADD COLUMN submitted_by_label TEXT;
