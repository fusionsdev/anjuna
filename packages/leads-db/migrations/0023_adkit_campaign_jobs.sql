-- Migration 0023: campaign job kinds on adkit_jobs (T13 Part B, panel campaigns).
-- 0021 is reserved by the open T12 PR 174 and 0022 by T13-1 (campaign_brand_map), so this file is 0023.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with the same columns, rows and
-- index. The new kinds are campaign.draft.create, campaign.update_budget, campaign.pause and campaign.enable.
-- Campaign jobs use the same queue rules as conversion_action.create (lease, attempts, backoff, claim_id).
-- The executor (scripts/drain/adkit-executor.mjs) is the only code that runs them; a draft is created
-- without --publish and only campaign.enable may publish ENABLED.

CREATE TABLE adkit_jobs_0023 (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'conversion_action.create',
                    'campaign.draft.create', 'campaign.update_budget', 'campaign.pause', 'campaign.enable')),
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

INSERT INTO adkit_jobs_0023 (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id, claimed_at,
  next_attempt_at, created_at, updated_at)
SELECT id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id, claimed_at,
  next_attempt_at, created_at, updated_at
FROM adkit_jobs;

DROP TABLE adkit_jobs;
ALTER TABLE adkit_jobs_0023 RENAME TO adkit_jobs;
CREATE INDEX idx_adkit_jobs_status ON adkit_jobs(status, created_at);
-- Campaign state is derived from the jobs of one campaign id; this keeps that read off a full scan.
CREATE INDEX idx_adkit_jobs_campaign ON adkit_jobs(kind, json_extract(payload, '$.campaign_id'));
