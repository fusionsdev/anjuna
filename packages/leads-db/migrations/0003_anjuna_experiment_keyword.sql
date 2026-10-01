-- Migration 0003 — Anjuna: A/B experiment + ad keyword attribution on clicks and leads.
--
-- The brand Worker assigns a weighted A/B variant per visitor (BR-9, sticky cookie together with
-- experiment_id) and inserts the cleaned ad keyword into the page (BR-4). Both are recorded on
-- the click (recordClick) and copied onto the lead (submitLead) so the funnel report (FA-6) can
-- break down click -> submit -> sold -> revenue by brand x keyword x variant.
--
-- Additive and nullable only: V1 rows/columns are untouched. `variant` is the A/B arm chosen by
-- the brand Worker; it is distinct from V1 leads.form_variant (which form layout was rendered).

ALTER TABLE click_sessions ADD COLUMN experiment_id TEXT;
ALTER TABLE click_sessions ADD COLUMN variant TEXT;
ALTER TABLE click_sessions ADD COLUMN keyword TEXT;      -- cleaned keyword (text only, <= 60 chars)

ALTER TABLE leads ADD COLUMN experiment_id TEXT;
ALTER TABLE leads ADD COLUMN variant TEXT;
ALTER TABLE leads ADD COLUMN keyword TEXT;               -- cleaned keyword (text only, <= 60 chars)

CREATE INDEX IF NOT EXISTS idx_click_sessions_experiment ON click_sessions(experiment_id, variant);
CREATE INDEX IF NOT EXISTS idx_leads_experiment          ON leads(experiment_id, variant);
