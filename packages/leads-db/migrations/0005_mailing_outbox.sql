-- Migration 0005 — Anjuna: mailing-list outbox (CO-7 / T8).
--
-- Core writes one row in the SAME D1 batch as the lead, so a lead can never exist without its
-- outbox row and a listmonk outage can never lose a lead. A cron (every 5 min) upserts pending
-- rows into listmonk (one list per brand) and moves them through:
--   pending -> sent                          (upserted)
--   pending -> pending (next_attempt_at)     (transient failure, retry with backoff)
--   pending -> dead                          (retries exhausted)
--   pending -> skipped                       (email is in `suppressions`)
--
-- The row carries no PII copy: subscriber attributes (email, name, phone, state, amount,
-- consent_version) are read from `leads` / `consent_evidence` at sync time, so PII lives in
-- exactly one place. Phone numbers are stored only, never used to send.

CREATE TABLE IF NOT EXISTS mailing_outbox (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id                TEXT NOT NULL UNIQUE,          -- one outbox row per lead: re-submits never re-add
  brand                  TEXT NOT NULL,                 -- selects the listmonk list (one list per brand)
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'sent', 'skipped', 'dead')),
  attempts               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TEXT,                          -- NULL = due now
  last_error             TEXT,
  listmonk_subscriber_id INTEGER,
  created_at             TEXT NOT NULL,
  updated_at             TEXT,
  sent_at                TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);

-- Cron scan: "due pending rows, oldest first".
CREATE INDEX IF NOT EXISTS idx_mailing_outbox_due ON mailing_outbox(status, next_attempt_at);
