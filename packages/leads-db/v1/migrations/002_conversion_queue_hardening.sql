-- Migration 002 — conversion-upload queue hardening (security audit H-04, H-05).
-- Adds retry scheduling so a transient upload failure is retried with backoff instead of
-- being lost forever, and supports an atomic claim (status='processing') so overlapping
-- drains don't double-upload the same row. status now spans:
--   pending -> processing -> uploaded            (success)
--   pending -> processing -> pending (backoff)   (transient failure, retry later)
--   pending -> processing -> dead                (retries exhausted; DLQ)
--
-- Apply once:  wrangler d1 execute aurum_leads --file=db/migrations/002_conversion_queue_hardening.sql
-- (Fresh databases get this from db/schema.sql directly.)
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS — run this only once.

PRAGMA foreign_keys = ON;

-- When the row becomes eligible to (re)attempt. Set to created_at on enqueue; pushed into the
-- future on each transient failure. Backfill existing rows to their created_at so they stay due.
ALTER TABLE conversion_uploads ADD COLUMN next_attempt_at TEXT;
UPDATE conversion_uploads SET next_attempt_at = created_at WHERE next_attempt_at IS NULL;

-- Any rows previously marked terminal 'failed' were unrecoverable under the old code — requeue
-- them so the new retry path can pick them up.
UPDATE conversion_uploads SET status = 'pending' WHERE status = 'failed';

-- Claim/retry scan: "eligible pending or stale processing, oldest first".
CREATE INDEX IF NOT EXISTS idx_conversion_uploads_claim
  ON conversion_uploads(status, next_attempt_at);
