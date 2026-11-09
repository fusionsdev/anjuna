-- Notification settings use the three dotted keys in the shared panel contract.
-- Preserve existing settings and keep every other dotted key prohibited.
CREATE TABLE panel_settings_next (
  key TEXT PRIMARY KEY CHECK (
    (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) <= 64)
    OR key IN ('notify.telegram', 'notify.routing', 'notify.digest')
  ),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO panel_settings_next SELECT key, value_json, updated_by, updated_at FROM panel_settings;
DROP TABLE panel_settings;
ALTER TABLE panel_settings_next RENAME TO panel_settings;
