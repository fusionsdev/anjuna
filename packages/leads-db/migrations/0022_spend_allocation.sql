-- Migration 0022: split the spend of one Google Ads account between the brands that share it (T13, Part A).
-- 0021 is reserved by the open T12 pull request, so this file takes 0022.
--
-- campaign_brand_map says which brand owns a campaign. source 'create' = the panel created the campaign
-- for that brand; 'click' = core saw the campaign id in utm_campaign on at least 3 clicks of one brand and
-- on no other brand; 'manual' = the owner assigned it. Core never overwrites a 'create' or 'manual' row
-- from clicks. A campaign belongs to one brand.
--
-- ad_spend.allocation: 'exact' = the cost came from campaigns mapped to the brand (or the brand is alone
-- on its account); 'estimated' = part of the cost is an unmapped campaign split by click share. Existing
-- rows came from account level spend of brands alone on their account, so they are exact.
--
-- ad_spend_unallocated holds the unmapped cost when the panel setting ads_allocation_mode is
-- 'exact_only': no brand row gets it. hour is NULL for a whole-day row; SQLite cannot put an expression
-- in a PRIMARY KEY, so the key is a unique index on COALESCE(hour, -1), like ad_spend_key in 0014.
-- One row per currency: a sum never crosses currencies.

ALTER TABLE ad_spend ADD COLUMN allocation TEXT NOT NULL DEFAULT 'exact' CHECK (allocation IN ('exact', 'estimated'));

-- ad_spend.account: the Google Ads account a campaign level ingest split the row from. A rerun of a slot
-- deletes that account's rows of brands no longer on it. NULL = account level ingest or a row from before
-- 0022; core never deletes those for a brand that left an account.
ALTER TABLE ad_spend ADD COLUMN account TEXT CHECK (account IS NULL OR (length(account) = 10 AND account NOT GLOB '*[^0-9]*'));

CREATE TABLE campaign_brand_map (
  account     TEXT NOT NULL CHECK (length(account) = 10 AND account NOT GLOB '*[^0-9]*'),
  campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 20 AND campaign_id NOT GLOB '*[^0-9]*'),
  brand_id    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('create', 'click', 'manual')),
  first_seen  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account, campaign_id)
);

CREATE INDEX campaign_brand_map_brand ON campaign_brand_map (brand_id);

CREATE TABLE ad_spend_unallocated (
  account    TEXT NOT NULL CHECK (length(account) = 10 AND account NOT GLOB '*[^0-9]*'),
  date       TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  hour       INTEGER CHECK (hour IS NULL OR (typeof(hour) = 'integer' AND hour BETWEEN 0 AND 23)),
  cost       REAL NOT NULL CHECK (cost >= 0),
  currency   TEXT NOT NULL CHECK (currency IN ('THB', 'USD')),
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ad_spend_unallocated_key ON ad_spend_unallocated (account, date, COALESCE(hour, -1), currency);

-- deriveCampaignMap reads click_sessions by utm_campaign inside a recent window.
CREATE INDEX IF NOT EXISTS idx_click_sessions_campaign ON click_sessions (utm_campaign, click_seen_at);
