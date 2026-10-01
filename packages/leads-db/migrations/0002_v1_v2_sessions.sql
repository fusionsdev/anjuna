-- Migration 0002 — port of V1 db/migrations/010_v2_sessions.sql (fusion_formv_v1@8404ec2).
-- DDL unchanged; V1's rationale comments are kept in ../v1/migrations/010_v2_sessions.sql.

CREATE TABLE IF NOT EXISTS v2_sessions (
  session_ref         TEXT PRIMARY KEY,      -- opaque ref, e.g. "sess_<uuid>"; never guessable
  brand_id            TEXT NOT NULL,
  workflow_id         TEXT NOT NULL,
  workflow_version    TEXT NOT NULL,
  steps               TEXT NOT NULL,         -- JSON array of step ids, in workflow order
  current_step_index  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | EXPIRED | SUBMITTED
  created_at          INTEGER NOT NULL,      -- epoch ms, server clock (`now` at createSession)
  expires_at          INTEGER NOT NULL       -- epoch ms; EXPIRED transition is sticky
);

CREATE INDEX IF NOT EXISTS idx_v2_sessions_status_expires
  ON v2_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS v2_session_submissions (
  session_ref       TEXT NOT NULL REFERENCES v2_sessions (session_ref),
  idempotency_key   TEXT NOT NULL,
  submission_ref    TEXT NOT NULL,     -- opaque ref, e.g. "sub_<uuid>"
  projection        TEXT NOT NULL,     -- JSON of the exact "submit" projection returned to the caller
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (session_ref, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_v2_session_submissions_submission_ref
  ON v2_session_submissions (submission_ref);
