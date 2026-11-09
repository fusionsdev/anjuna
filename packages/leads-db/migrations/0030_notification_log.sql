CREATE TABLE notification_log (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  status TEXT NOT NULL,
  response_code INTEGER,
  body_hash TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX idx_notification_log_sent_at ON notification_log(sent_at);
