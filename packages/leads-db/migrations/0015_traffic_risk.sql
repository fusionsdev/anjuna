-- Migration 0015: observe-only click risk scoring (FUS-372), ported from V1 handleTelemetry.
-- Core scores each telemetry event at ingest. The score never changes any response (AGENTS.md
-- rule 3); the panel reads it and the owner exports high-risk gclids for a Google refund request.
-- Both columns stay NULL on rows written before this migration.

-- Sum of the weights of the signals that fired (known_bot_ua 50, timezone_geo_mismatch 20,
-- rapid_repeat_session 30). 50 or more is high risk.
ALTER TABLE traffic_events ADD COLUMN risk_score INTEGER
  CHECK (risk_score IS NULL OR (typeof(risk_score) = 'integer' AND risk_score >= 0));
-- JSON array of the signal ids that fired, e.g. ["known_bot_ua"]; "[]" when none did.
ALTER TABLE traffic_events ADD COLUMN risk_signals TEXT
  CHECK (risk_signals IS NULL OR json_valid(risk_signals));

-- Per-hour telemetry counter for rapid_repeat_session. ip_hash is SHA-256 of "<ip>:<brand_id>",
-- computed by the brand Worker; the raw IP never reaches core. Core deletes every row older than
-- the current UTC hour on each telemetry write, so a hash lives at most about two hours.
CREATE TABLE IF NOT EXISTS traffic_velocity (
  hour    TEXT NOT NULL,                 -- UTC clock hour, e.g. 2026-10-22T11
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  events  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, ip_hash)
) WITHOUT ROWID;
