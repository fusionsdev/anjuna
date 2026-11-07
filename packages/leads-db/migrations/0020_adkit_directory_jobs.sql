-- Migration 0020: AdKit directory and job queue (panel redesign T9, ADR-0005).
-- Workers never call AdKit. The VPS drain host runs `adkit`:
--   * scripts/drain/adkit-directory-sync.mjs posts projects, accounts and conversion actions to
--     POST /api/adkit/directory/ingest every hour. The panel wizard reads selects from adkit_directory.
--   * the panel inserts one adkit_jobs row per request (POST /admin/adkit/jobs). scripts/drain/adkit-executor.mjs
--     lists pending jobs, claims one, runs `adkit` and posts the result.
--
-- adkit_directory: one row per (kind, id). parent_id is the project of an account and the account of a
-- conversion action. A row whose updated_at is older than 2 hours is not served (ADR-0005 decision 10), so an
-- item AdKit no longer returns ages out without a delete.
--
-- adkit_jobs: status queued -> claimed -> done | queued (retry after backoff) | failed (final).
-- idempotency_key is UNIQUE so a retried POST keeps one row. attempts counts claims. A claimed row whose
-- claimed_at is older than the lease (30 minutes) is a crashed run and may be claimed again while attempts
-- are left. claim_id identifies the claim a result must name. next_attempt_at is set for a queued retry only.

CREATE TABLE adkit_directory (
  kind       TEXT NOT NULL CHECK (kind IN ('project', 'account', 'conversion_action')),
  id         TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  parent_id  TEXT CHECK (parent_id IS NULL OR length(parent_id) BETWEEN 1 AND 64),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  currency   TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX idx_adkit_directory_parent ON adkit_directory(kind, parent_id, updated_at);

CREATE TABLE adkit_jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('conversion_action.create')),
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  status          TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  result          TEXT CHECK (result IS NULL OR json_valid(result)),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  requested_by    TEXT NOT NULL,
  claim_id        TEXT,
  claimed_at      TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (status != 'claimed' OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE INDEX idx_adkit_jobs_status ON adkit_jobs(status, created_at);
