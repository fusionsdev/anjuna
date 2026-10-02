-- Migration 0003 — similarity fingerprints of sealed templates (workers/template-mcp similarity_check).
--
-- Every brand must ship a visibly different design (identical sites risk Google Ads bans). Sealing
-- (T11) stores the fingerprint of the sealed dist; the template MCP compares candidates against all
-- of them. fingerprint_json holds DOM-structure shingles, CSS class set, section order, image hashes
-- and visible-text shingles as compact sketches. It is derived data and holds no lead or secret data.

CREATE TABLE IF NOT EXISTS template_fingerprints (
  template_version_id TEXT PRIMARY KEY REFERENCES template_versions(template_version_id),
  fingerprint_json    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK (json_valid(fingerprint_json))
);
