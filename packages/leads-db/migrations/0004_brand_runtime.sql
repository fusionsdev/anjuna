-- Migration 0004 — Anjuna: per-brand runtime configuration owned by core.
--
-- One row per brand. Core reads it to authorize /rpc/* calls (the brand must belong to the
-- calling account, CO-2), to verify the per-brand postback token (CO-3), to build the LeadsGate
-- prepop redirect (CO-1) and to serve the brand Worker its runtime config (BR-2..BR-10).
--
-- Secrets are never stored in clear: the postback token is stored only as a SHA-256 hex hash.
-- `drain_key` is the brand's routing key in the VPS drain's BRAND_ROUTING_JSON (an identifier,
-- not a credential).

CREATE TABLE IF NOT EXISTS brand_runtime (
  brand_id            TEXT PRIMARY KEY,                -- opaque, never sent to the browser (BR-5)
  account             TEXT NOT NULL,                   -- installation/account label the brand belongs to
  hostnames           TEXT NOT NULL DEFAULT '[]',      -- JSON array of normalised hostnames (apex + www)
  drain_key           TEXT NOT NULL,                   -- key in the drain's BRAND_ROUTING_JSON
  postback_token_hash TEXT,                            -- hex SHA-256 of the per-brand LeadsGate postback token
  aid                 TEXT NOT NULL,                   -- LeadsGate affiliate id for the prepop redirect
  prepop_base         TEXT NOT NULL,                   -- LeadsGate prepop form URL
  amount_buckets      TEXT NOT NULL DEFAULT '[]',      -- JSON array of allowed requested_amount integers (BR-2)
  flow_gate_mode      TEXT NOT NULL DEFAULT 'param'
                        CHECK (flow_gate_mode IN ('param', 'signed_cookie')),
  paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  ab_config_json      TEXT,                            -- {"experiment_id": "...", "variants": [{"id": "A", "weight": 50}, ...]}; NULL = no test
  keyword_default     TEXT,                            -- H1/form header text when ?keyword is missing
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (json_valid(hostnames) AND json_type(hostnames) = 'array'),
  CHECK (json_valid(amount_buckets) AND json_type(amount_buckets) = 'array'),
  CHECK (ab_config_json IS NULL OR json_valid(ab_config_json))
);

CREATE INDEX IF NOT EXISTS idx_brand_runtime_account ON brand_runtime(account);
