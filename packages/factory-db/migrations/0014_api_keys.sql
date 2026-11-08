-- Migration 0014: scoped keys for the panel API v1 (/api/v1/*, panel redesign Task 10).
--
-- An owner mints a key with a label and a set of scopes. Only the SHA-256 hex of the key is stored, the
-- same hashing as builder_keys; the key itself is shown once in the create response and never again.
-- Scopes are a JSON array of brand:draft, adkit:read, adkit:conversion and brand:generate. Revoking sets
-- revoked_at. Never lead data.

CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  label        TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  scopes_json  TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  created_by   TEXT NOT NULL,                    -- auth user id of the owner who minted it
  created_at   TEXT NOT NULL,                    -- ISO 8601 UTC
  last_used_at TEXT,
  revoked_at   TEXT
);
