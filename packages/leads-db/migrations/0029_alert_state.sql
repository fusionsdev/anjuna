CREATE TABLE alert_state (
  alert_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_sent TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL
);
