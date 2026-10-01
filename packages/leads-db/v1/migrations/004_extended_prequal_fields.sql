-- Migration 004 — extend `leads` to mirror LeadsGate's 14-step pre-screen flow.
-- Apply once:  wrangler d1 execute aurum_leads --remote --file=db/migrations/004_extended_prequal_fields.sql
-- (Fresh databases get these from db/schema.sql directly.)
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS — run this only once.
-- New columns are nullable since existing rows predate them.

PRAGMA foreign_keys = ON;

ALTER TABLE leads ADD COLUMN address_length_months INTEGER;
ALTER TABLE leads ADD COLUMN own_home INTEGER;
ALTER TABLE leads ADD COLUMN employer TEXT;
ALTER TABLE leads ADD COLUMN job_title TEXT;
ALTER TABLE leads ADD COLUMN employed_months INTEGER;
ALTER TABLE leads ADD COLUMN pay_date1 TEXT;
ALTER TABLE leads ADD COLUMN pay_frequency TEXT;
ALTER TABLE leads ADD COLUMN direct_deposit INTEGER;

-- bank_account_type is no longer collected (dropped from LeadsGate's own hosted
-- Banking Details step, filled after handoff) — drop the column entirely.
ALTER TABLE leads DROP COLUMN bank_account_type;
