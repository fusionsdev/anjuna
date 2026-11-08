-- Migration 0025: claim and result order on adkit_jobs (T13-4d, status check ordering).
--
-- claim_seq and result_seq share one counter, the job event order. Core sets claim_seq in the claim UPDATE (every
-- claim and every reclaim after the lease) and result_seq in the UPDATE that records a final result (done, failed
-- or unknown), both with
--   (SELECT MAX(COALESCE(MAX(claim_seq), 0), COALESCE(MAX(result_seq), 0)) + 1 FROM adkit_jobs)
-- inside the same statement. D1 runs one write at a time, so the order is the commit order of those writes.
-- A status check is ordered against other checks by claim_seq, and it is stale when a write of its campaign got a
-- result_seq between the check's claim_seq and its result_seq. No clock is read for either rule.
--
-- Backfill: every existing claim (claimed_at set) and every final result (status done, failed or unknown) is one
-- event. Events are numbered 1..n by time (claimed_at for a claim, updated_at for a result), then rowid, with a
-- row's claim before its own result. A row claimed or finished later by old core (deploy order broken) keeps NULL,
-- which core reads as 0: such a check sorts first and is more often stale.
--
-- Columns are added with ADD COLUMN (nullable, no rebuild), so the 0023 unique key, the CHECKs and the 0023/0024
-- indexes stay as they are.
--
-- Rollback: deploy the core from before T13-4d first (it never reads these columns), then
--   DROP INDEX idx_adkit_jobs_claim_seq; DROP INDEX idx_adkit_jobs_result_seq;
--   ALTER TABLE adkit_jobs DROP COLUMN claim_seq; ALTER TABLE adkit_jobs DROP COLUMN result_seq;
-- and delete the 0025 row from d1_migrations. Leaving the columns in place with the old core is also safe.

ALTER TABLE adkit_jobs ADD COLUMN claim_seq INTEGER;
ALTER TABLE adkit_jobs ADD COLUMN result_seq INTEGER;

WITH events AS (
  SELECT id, 0 AS k, claimed_at AS t, rowid AS r FROM adkit_jobs WHERE claimed_at IS NOT NULL
  UNION ALL
  SELECT id, 1 AS k, updated_at AS t, rowid AS r FROM adkit_jobs WHERE status IN ('done', 'failed', 'unknown')
),
numbered AS (SELECT id, k, ROW_NUMBER() OVER (ORDER BY t, r, k) AS n FROM events)
UPDATE adkit_jobs SET
  claim_seq = (SELECT n FROM numbered WHERE numbered.id = adkit_jobs.id AND numbered.k = 0),
  result_seq = (SELECT n FROM numbered WHERE numbered.id = adkit_jobs.id AND numbered.k = 1);

CREATE INDEX idx_adkit_jobs_claim_seq ON adkit_jobs(claim_seq);
CREATE INDEX idx_adkit_jobs_result_seq ON adkit_jobs(result_seq);
