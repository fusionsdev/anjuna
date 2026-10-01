-- Migration 0001 — V1 baseline (port of fusion_formv_v1@8404ec2 db/schema.sql).
--
-- V1 ships two paths: db/schema.sql for a FRESH database, and db/migrations/001–009 to
-- upgrade databases that predate it ("Fresh databases get these from db/schema.sql
-- directly", per each V1 migration header). Anjuna only ever starts from an empty D1, so the
-- fresh path is the port: this file is V1 db/schema.sql with its DDL unchanged. It already
-- contains every effect of V1 migrations 001–009 (click_id, conversion queue hardening,
-- suppressions, prequal fields, click_sessions, msclkid, traffic_events, click_sessions.hostname;
-- 006/007 cancel out). V1 migration 010 is ported as 0002.
-- The verbatim V1 sources live in ../v1/ and test/leads-db.test.ts checks parity against them.
--
-- Only change from V1: the leading `PRAGMA foreign_keys = ON;` is dropped — D1 always
-- enforces foreign keys and wrangler runs each migration inside a transaction, where that
-- PRAGMA is a no-op.


CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,               -- idempotency key (our lead id)
  session_id TEXT NOT NULL,
  form_version TEXT NOT NULL,
  form_variant TEXT NOT NULL,
  site_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  hostname TEXT NOT NULL,
  -- LeadsGate-shaped applicant fields
  requested_amount INTEGER NOT NULL,      -- 100-5000
  loan_purpose TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT NOT NULL,               -- YYYY-MM-DD
  email TEXT NOT NULL,
  home_phone TEXT NOT NULL,               -- 10 digits, no delimiters
  work_phone TEXT,                        -- 10 digits, optional
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,                    -- 2-letter USPS
  zip TEXT NOT NULL,                      -- 5 digits
  address_length_months INTEGER NOT NULL, -- 1-120
  own_home INTEGER NOT NULL,              -- 0|1
  income_type TEXT NOT NULL,             -- EMPLOYMENT|BENEFITS|SELF_EMPLOYED|MILITARY
  employer TEXT NOT NULL,
  job_title TEXT NOT NULL,
  employed_months INTEGER NOT NULL,       -- 1-60
  pay_date1 TEXT NOT NULL,               -- YYYY-MM-DD, next payday
  pay_frequency TEXT NOT NULL,           -- WEEKLY|BIWEEKLY|TWICEMONTHLY|MONTHLY
  direct_deposit INTEGER NOT NULL,       -- 0|1
  monthly_income INTEGER NOT NULL,        -- 1126-6000
  tracking_json TEXT NOT NULL,           -- gclid/gbraid/wbraid + attribution (no PII)
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  click_id TEXT                          -- our own alphanumeric click token (= lead_id sans hyphens); the LeadsGate `cid` join key
);

CREATE INDEX IF NOT EXISTS idx_leads_session_id ON leads(session_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_click_id ON leads(click_id);

-- Consent evidence is stored separately (FCRA/TCPA audit trail).
CREATE TABLE IF NOT EXISTS consent_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL UNIQUE,
  application_consent INTEGER NOT NULL,
  consent_version TEXT NOT NULL,
  partner_list_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  page_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  ip_hash TEXT,                           -- SHA-256(ip:site_id) — never the raw IP
  user_agent TEXT,
  form_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);

-- One tracker postback per (lead_id, event_type) — LeadsGate postback deduplication.
CREATE TABLE IF NOT EXISTS postback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  event_type TEXT NOT NULL,               -- newLead|soldLead|rejectLead|duplicate
  payout REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (lead_id, event_type),
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);

-- Google Ads offline-conversion upload ledger. One row per sold conversion.
-- Drained to Google Ads (via AdKit, OAuth) — see functions/api/[[path]].ts.
CREATE TABLE IF NOT EXISTS conversion_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  gclid TEXT,
  gbraid TEXT,
  wbraid TEXT,
  msclkid TEXT,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  occurred_at TEXT NOT NULL,              -- ISO8601 with offset (Google requires tz)
  google_order_id TEXT,                   -- = our lead_id (Google-side dedup key)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|uploaded|dead
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,                   -- when this row is (re)eligible to attempt (retry backoff)
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (lead_id),                       -- one upload per lead; postback dedup already gates soldLead
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
);

CREATE INDEX IF NOT EXISTS idx_conversion_uploads_status ON conversion_uploads(status);
-- Claim/retry scan: "eligible pending or stale processing, oldest first".
CREATE INDEX IF NOT EXISTS idx_conversion_uploads_claim ON conversion_uploads(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS client_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  error_type TEXT NOT NULL,
  error_message TEXT,
  screen_id TEXT,
  occurred_at TEXT NOT NULL
);

-- Email suppression list (mailing-list reverse-sync sink). listmonk is the authoritative
-- send-time store; this mirrors its blocklist/unsubscribes back so a rebuild never re-mails a
-- complainer. Written by POST /api/admin/suppress; the CSV export excludes these emails.
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,        -- lowercased
  reason TEXT NOT NULL,          -- blocklisted | unsubscribed | complaint | bounce | manual
  source TEXT NOT NULL,          -- listmonk | ses | manual
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- ZIP -> city/state lookup (autofill + real-ZIP validation).
-- Seed with:  wrangler d1 execute aurum_leads --file=db/zip_seed.sql   (generated by scripts/build-zip-data.mjs)
CREATE TABLE IF NOT EXISTS zip_lookup (
  zip TEXT PRIMARY KEY,       -- 5 digits, left-padded
  city TEXT NOT NULL,
  state TEXT NOT NULL
);

-- Server-side click-session store (migration 005) — unforgeable, single-use gclid attribution.
-- Written by functions/_middleware.ts on a paid landing; consumed by POST /api/leads via an
-- atomic UPDATE ... WHERE lead_id IS NULL RETURNING. lead_id has NO FK to leads (claim stamps it
-- before the leads INSERT). PII-safe: stores pathname + referrer origin only, never the raw query.
CREATE TABLE IF NOT EXISTS click_sessions (
  click_session_id   TEXT PRIMARY KEY,   -- opaque 256-bit token = the fo_click cookie value
  gclid              TEXT,
  gbraid             TEXT,
  wbraid             TEXT,
  msclkid            TEXT,
  fbclid             TEXT,
  external_click_id  TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_term           TEXT,
  utm_content        TEXT,
  source             TEXT,
  aid                TEXT,
  landing_path       TEXT,
  referrer_origin    TEXT,
  click_seen_at      TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  lead_id            TEXT,
  created_at         TEXT NOT NULL,
  hostname           TEXT                -- normalised: lowercase, no port, no leading "www."
);
CREATE INDEX IF NOT EXISTS idx_click_sessions_gclid   ON click_sessions(gclid);
CREATE INDEX IF NOT EXISTS idx_click_sessions_lead_id ON click_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_click_sessions_prune   ON click_sessions(lead_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_click_sessions_host_seen ON click_sessions(hostname, click_seen_at);

-- Funnel/step telemetry (migration 009). Written by POST /api/telemetry, which fails open on
-- any storage error — this table is never on the funnel's critical path.
CREATE TABLE IF NOT EXISTS traffic_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  click_session_id TEXT,             -- fo_click cookie, read server-side: the ONLY direct join to click_sessions
  hostname        TEXT,
  brand           TEXT,
  form_version    TEXT,
  form_variant    TEXT,
  build_id        TEXT NOT NULL DEFAULT 'unknown',
  form_step       INTEGER,
  error_code      TEXT,
  device_class    TEXT,
  browser_family  TEXT,
  browser_timezone TEXT,
  touch_capable   INTEGER NOT NULL DEFAULT 0,
  source          TEXT,
  campaign        TEXT,
  occurred_at     TEXT NOT NULL,
  clock_skew      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traffic_events_created_step ON traffic_events(created_at, form_step, event_type);
CREATE INDEX IF NOT EXISTS idx_traffic_events_host_created ON traffic_events(hostname, created_at);
CREATE INDEX IF NOT EXISTS idx_traffic_events_session      ON traffic_events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_traffic_events_click_session ON traffic_events(click_session_id);
