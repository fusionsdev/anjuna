-- Migration 0013: template categories for the panel template manager.
--
-- Categories live in their own tables so a sealed template_versions row stays untouched (TP-3,
-- trigger template_versions_sealed_immutable). One template has at most one category. Archive uses the
-- existing templates.archived_at column from 0001. Never lead data, never secrets.

CREATE TABLE IF NOT EXISTS template_categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS template_category_map (
  template_id TEXT PRIMARY KEY REFERENCES templates(template_id),
  category_id TEXT NOT NULL REFERENCES template_categories(id)
);
CREATE INDEX IF NOT EXISTS idx_template_category_map_category ON template_category_map(category_id);
