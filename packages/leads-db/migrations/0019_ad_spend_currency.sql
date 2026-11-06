-- Migration 0019: billing currency of each ad_spend row (panel redesign, Task 1).
-- 0014 said cost is USD. It is not: cost is in the Google Ads account's billing currency, and every
-- account bills in THB. Existing rows are baht, so the column defaults to 'THB'. The panel converts
-- to USD with its own fx_thb_per_usd setting; core never sums across currencies.

ALTER TABLE ad_spend ADD COLUMN currency TEXT NOT NULL DEFAULT 'THB' CHECK (currency IN ('THB', 'USD'));
