-- Migration 0027: the terminal.run job kind on adkit_jobs (T13-6, panel AdKit Terminal). 0026 is taken by the open T13-3 PR 193.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with the same columns, rows and
-- indexes as after 0025 (seq from 0024, claim_seq and result_seq from 0025). The only change is the new kind
-- 'terminal.run' in the kind CHECK. A terminal job is one allowlisted `adkit manage ...` line the owner typed in the
-- panel. The executor (scripts/drain/adkit-executor.mjs) runs it once through the same allowlist as every other job:
-- it is never retried and an expired claim fails it (a retried write could run twice).
--
-- Deploy order: apply this migration, deploy core, then update the VPS executor. Until the executor is updated it
-- does not know the kind and fails a terminal job for good ("unknown job kind"), which is safe. Apply it while the
-- executor is stopped (scripts/drain/README.md "Deploy 0025"): the rebuild copies every row, and a claim or result
-- written between the copy and the rename would be lost.
--
-- Rollback (no down migration): stop the executor, delete or archive every row with kind 'terminal.run', then rebuild
-- adkit_jobs the same way with the 0023 kind CHECK. D1 Time Travel restore to before 0027 is the other way back.

CREATE TABLE adkit_jobs_0027 (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'conversion_action.create',
                    'campaign.draft.create', 'campaign.update_budget', 'campaign.pause', 'campaign.enable',
                    'campaign.status_check', 'terminal.run')),
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  status          TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'held', 'unknown')),
  result          TEXT CHECK (result IS NULL OR json_valid(result)),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  requested_by    TEXT NOT NULL,
  claim_id        TEXT,
  claimed_at      TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  claim_seq       INTEGER,
  result_seq      INTEGER,
  CHECK (status != 'claimed' OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL))
);

INSERT INTO adkit_jobs_0027 (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id, claimed_at,
  next_attempt_at, created_at, updated_at, seq, claim_seq, result_seq)
SELECT id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id, claimed_at,
  next_attempt_at, created_at, updated_at, seq, claim_seq, result_seq
FROM adkit_jobs;

DROP TABLE adkit_jobs;
ALTER TABLE adkit_jobs_0027 RENAME TO adkit_jobs;
CREATE INDEX idx_adkit_jobs_status ON adkit_jobs(status, created_at);
CREATE INDEX idx_adkit_jobs_campaign ON adkit_jobs(kind, json_extract(payload, '$.campaign_id'));
CREATE INDEX idx_adkit_jobs_seq ON adkit_jobs(seq);
CREATE INDEX idx_adkit_jobs_claim_seq ON adkit_jobs(claim_seq);
CREATE INDEX idx_adkit_jobs_result_seq ON adkit_jobs(result_seq);
