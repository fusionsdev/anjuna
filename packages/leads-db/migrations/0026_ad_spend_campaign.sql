-- Migration 0026: campaign level cost of the Google Ads accounts that several brands share (T13, Part A3).
--
-- POST /api/spend/campaign-ingest writes one row per (account, date, hour, campaign) it receives, next to
-- the per-brand ad_spend rows it derives from them. The panel tab "จัดสรรค่าโฆษณา" lists unmapped campaigns
-- with their 7 day cost from this table, and the alert ad_spend_unallocated compares the unmapped part with
-- the account cost. ad_spend cannot answer either: one brand row mixes exact and estimated parts.
--
-- cost is the campaign's share of the slot total in hundredths (the same rounding the brand rows use), so
-- the campaign rows of a slot add up to the brand rows of that slot. A rerun of a slot deletes the slot's
-- rows for that account and currency first, so a campaign that disappeared from AdKit leaves no row.
-- utc_offset_minutes is the account zone the ingest posted; the owner assigning a campaign re-runs the slot
-- allocation from these rows and needs it to weight by the same local hours.
-- hour is NULL for a whole-day row; the key is a unique index on COALESCE(hour, -1), like ad_spend_key.

CREATE TABLE ad_spend_campaign (
  account     TEXT NOT NULL CHECK (length(account) = 10 AND account NOT GLOB '*[^0-9]*'),
  date        TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  hour        INTEGER CHECK (hour IS NULL OR (typeof(hour) = 'integer' AND hour BETWEEN 0 AND 23)),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 20 AND campaign_id NOT GLOB '*[^0-9]*'),
  cost        REAL NOT NULL CHECK (cost >= 0),
  currency    TEXT NOT NULL CHECK (currency IN ('THB', 'USD')),
  clicks      INTEGER NOT NULL CHECK (clicks >= 0),
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  updated_at  TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 0 CHECK (utc_offset_minutes BETWEEN -720 AND 840)
);

CREATE UNIQUE INDEX ad_spend_campaign_key ON ad_spend_campaign (account, date, COALESCE(hour, -1), campaign_id, currency);
CREATE INDEX ad_spend_campaign_date ON ad_spend_campaign (date);
