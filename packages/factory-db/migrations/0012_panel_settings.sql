-- Migration 0012: panel-wide settings as key/value rows (panel redesign, Task 1).
--
-- First key: fx_thb_per_usd, the baht per US dollar rate the panel uses to show ad spend in USD and to
-- compute profit. A missing row means the code default (35). Only the owner writes rows; updated_by
-- and updated_at record the last write. Values are JSON text so a later key can hold any shape.

CREATE TABLE IF NOT EXISTS panel_settings (
  key         TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) <= 64),
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by  TEXT NOT NULL,                    -- auth user id
  updated_at  TEXT NOT NULL                     -- ISO 8601 UTC
);
