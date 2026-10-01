-- Migration 001 — own S2S conversion tracking.
-- For an EXISTING aurum_leads D1 that predates the click_id column.
-- Apply once:  wrangler d1 execute aurum_leads --file=db/migrations/001_click_id_and_conversions.sql
-- (Fresh databases get these from db/schema.sql directly.)
--
-- NOTE: SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS — run this only once.
-- If click_id already exists, skip the ALTER line.

PRAGMA foreign_keys = ON;

ALTER TABLE leads ADD COLUMN click_id TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_click_id ON leads(click_id);

CREATE TABLE IF NOT EXISTS conversion_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at TEXT NOT NULL,
  google_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (lead_id),
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);

CREATE INDEX IF NOT EXISTS idx_conversion_uploads_status ON conversion_uploads(status);
