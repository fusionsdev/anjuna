-- Migration 0018: auto-created Google Ads conversion action per brand (FUS-384), written by core
-- through POST /api/conversions/setup/{claim,result} for the VPS drain and read by the panel
-- through GET /admin/brands/:id/conversion-setup.
-- One row per brand. account is the google_ads_account at claim time; name is the opaque
-- conversion name (cv- plus 16 hex), fixed per (brand, account) so a retry adopts the same action.
-- The name CHECK avoids one 16-class GLOB: D1 rejects it as too complex.
-- A claimed row older than 30 minutes is a crashed run. next_attempt_at and last_error are for
-- failed rows only, conversion_action_id for created rows only.

CREATE TABLE conversion_setup (
  brand_id             TEXT PRIMARY KEY,
  account              TEXT NOT NULL CHECK (length(account) = 10 AND account NOT GLOB '*[^0-9]*'),
  name                 TEXT NOT NULL CHECK (
    length(name) = 19 AND substr(name, 1, 3) = 'cv-' AND substr(name, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  status               TEXT NOT NULL CHECK (status IN ('claimed', 'created', 'failed')),
  claim_id             TEXT NOT NULL,
  claimed_at           TEXT NOT NULL,
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at      TEXT,
  last_error           TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  conversion_action_id TEXT CHECK (
    conversion_action_id IS NULL
    OR (length(conversion_action_id) BETWEEN 1 AND 20 AND conversion_action_id NOT GLOB '*[^0-9]*')
  ),
  updated_at           TEXT NOT NULL
);
