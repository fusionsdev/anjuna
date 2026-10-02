-- Migration 0002 — template_fingerprints
-- Stores the compact fingerprint computed during certification for each sealed template version.
-- Used by workers/template-mcp's similarity_check to compare new candidates against all sealed versions.
-- Added by T11 (template certification pipeline).
CREATE TABLE IF NOT EXISTS template_fingerprints (
  template_version_id TEXT PRIMARY KEY REFERENCES template_versions(template_version_id),
  fingerprint_json    TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
