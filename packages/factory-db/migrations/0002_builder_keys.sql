-- Migration 0002 — builder API keys for the template MCP (workers/template-mcp).
--
-- Design-tool builders (open-design.ai, v0, Bolt, Lovable, Magic Patterns) get one key each. Only the
-- SHA-256 hex of the key is stored; the key itself is shown once at mint time. Revoking sets revoked_at.

CREATE TABLE IF NOT EXISTS builder_keys (
  key_id       TEXT PRIMARY KEY,
  label        TEXT NOT NULL,                    -- builder / owner label, e.g. 'v0 - harbor'
  key_hash     TEXT NOT NULL UNIQUE,             -- lowercase hex SHA-256 of the API key
  created_by   TEXT NOT NULL,                    -- auth user id or 'system'
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  CHECK (length(key_hash) = 64)
);

-- Fixed-window request counters for per-key rate limiting. Old windows are pruned opportunistically.
CREATE TABLE IF NOT EXISTS builder_key_usage (
  key_id       TEXT NOT NULL REFERENCES builder_keys(key_id),
  window_start INTEGER NOT NULL,                 -- unix seconds, floored to the window
  requests     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);
