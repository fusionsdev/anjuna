-- Migration 005 — server-side click-session store for unforgeable, single-use gclid attribution.
-- Apply once:  wrangler d1 execute aurum_leads --remote --file=db/migrations/005_click_sessions.sql
-- (Fresh databases get this from db/schema.sql directly.)
-- Idempotent: CREATE ... IF NOT EXISTS only — no ALTER, safe to re-run.
--
-- Written by functions/_middleware.ts on a paid landing ("/"); consumed by POST /api/leads
-- (atomic UPDATE ... WHERE lead_id IS NULL RETURNING). lead_id has NO FK to leads on purpose:
-- the claim stamps lead_id BEFORE the leads INSERT, and an FK would reject that ordering.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS click_sessions (
  click_session_id   TEXT PRIMARY KEY,   -- opaque 256-bit token = the fo_click cookie value
  gclid              TEXT,
  gbraid             TEXT,
  wbraid             TEXT,
  msclkid            TEXT,
  fbclid             TEXT,
  external_click_id  TEXT,               -- affiliate clickid/click_id
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_term           TEXT,
  utm_content        TEXT,
  source             TEXT,
  aid                TEXT,
  landing_path       TEXT,               -- pathname ONLY (never the query string = PII-safe)
  referrer_origin    TEXT,               -- origin ONLY (never the full referrer = PII-safe)
  click_seen_at      TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  lead_id            TEXT,               -- set single-use when this session produces a lead
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_click_sessions_gclid   ON click_sessions(gclid);
CREATE INDEX IF NOT EXISTS idx_click_sessions_lead_id ON click_sessions(lead_id);
-- Prune scan: unconverted sessions, oldest first.
CREATE INDEX IF NOT EXISTS idx_click_sessions_prune   ON click_sessions(lead_id, last_seen_at);
