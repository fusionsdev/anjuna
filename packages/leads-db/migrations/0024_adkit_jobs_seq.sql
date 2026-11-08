-- Migration 0024: insert order on adkit_jobs (T13-4b, campaign cap rechecks).
-- 0023 is merged on main, so the column is added here instead of in the 0023 table rebuild.
--
-- seq is the insert order. Core sets it in the INSERT itself with (SELECT COALESCE(MAX(seq), 0) + 1 FROM adkit_jobs);
-- D1 runs one write at a time, so two inserts never get the same value. The cap recheck of a held campaign job counts
-- the held rows with a smaller seq, so of two concurrent rows the later-inserted one always counts the other.
-- created_at and the random id do not follow insert order. rowid may be renumbered by VACUUM on a table without an
-- INTEGER PRIMARY KEY, so core never reads it; only this one-time backfill uses it.
--
-- ADD COLUMN with NOT NULL DEFAULT 0 needs no table rebuild, so the unique key, both indexes and every CHECK stay as
-- 0023 made them. Existing rows get seq 1..n in rowid order (the insert order of the 0023 rebuild copy, which kept
-- the old table order). A row inserted later without seq (old core) gets 0 and sorts first, so a recheck counts it:
-- that errs toward refusing.
--
-- Rollback: deploy the core from before T13-4b first (it never reads seq), then
--   DROP INDEX idx_adkit_jobs_seq; ALTER TABLE adkit_jobs DROP COLUMN seq;
-- and delete the 0024 row from d1_migrations. Leaving the column in place with the old core is also safe.

ALTER TABLE adkit_jobs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

UPDATE adkit_jobs SET seq = (SELECT COUNT(*) FROM adkit_jobs b WHERE b.rowid <= adkit_jobs.rowid);

CREATE INDEX idx_adkit_jobs_seq ON adkit_jobs(seq);
