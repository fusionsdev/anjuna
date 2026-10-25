-- Migration 0009: manual Google Ads account events a brand's operators note on its timeline.
--
-- The panel writes a row when an owner or employee records an event (an ad disapproved, an account suspended, ...);
-- the panel's brand timeline reads it and merges it with the stored change history. These are operator notes, never
-- lead data, never secrets. `brand_id` has no foreign key: a brand known only to core (unmanaged) has no factory row,
-- and it still takes events.

CREATE TABLE IF NOT EXISTS ads_account_events (
  event_id     TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  brand_id     TEXT NOT NULL,                    -- factory or core brand id; no FK, an unmanaged brand has no factory row
  type         TEXT NOT NULL CHECK (type IN ('ad_disapproved', 'account_suspended', 'account_reinstated',
                                             'policy_warning', 'bot_visit_observed', 'other')),
  occurred_at  TEXT NOT NULL,                    -- ISO 8601 UTC, when it happened in the Ads account
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by   TEXT NOT NULL,                    -- auth user id
  created_role TEXT NOT NULL CHECK (created_role IN ('owner', 'employee')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_account_events_brand ON ads_account_events(brand_id, occurred_at);
