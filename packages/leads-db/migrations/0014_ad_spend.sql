-- Migration 0014: ad spend per brand (FUS-368), written by the VPS spend-sync job through
-- POST /api/spend/ingest and read by the panel through GET /admin/spend.
-- One row per (brand_id, date, hour, source). hour is 0-23 for an hourly row and NULL for a
-- whole-day row. SQLite treats NULLs as distinct in a UNIQUE constraint, so the unique index uses
-- COALESCE(hour, -1); the ingest upsert names the same expression as its conflict target.
-- cost is USD. date is the ad account's calendar day as AdKit reports it.

CREATE TABLE ad_spend (
  brand_id    TEXT NOT NULL,
  date        TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  hour        INTEGER CHECK (hour IS NULL OR (typeof(hour) = 'integer' AND hour BETWEEN 0 AND 23)),
  cost        REAL NOT NULL CHECK (cost >= 0),
  clicks      INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  source      TEXT NOT NULL DEFAULT 'google' CHECK (source IN ('google')),
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX ad_spend_key ON ad_spend (brand_id, date, COALESCE(hour, -1), source);
CREATE INDEX ad_spend_date ON ad_spend (date, brand_id);
