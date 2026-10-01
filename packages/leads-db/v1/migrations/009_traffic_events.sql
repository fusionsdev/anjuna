-- Migration 009 — funnel telemetry: traffic_events + click_sessions.hostname
--
-- WHY: between 2026-08-20 and 2026-08-26 the blended click->lead rate fell from ~25% to
-- ~16% and no stored data could say where in the 14 steps the loss happened. `leads` records
-- only completions, and `client_errors` produced one row in fourteen days. The question was
-- eventually settled by diffing archived Cloudflare deployment bundles — which worked only
-- because those artifacts still existed, and Cloudflare retains just 75 deployments. Two
-- separate investigations also reached a wrong conclusion because per-brand conversion could
-- not be computed at all: `click_sessions` had no hostname, so the only per-brand denominator
-- available came from `leads`, i.e. converted sessions only — survivorship bias by design.
--
-- This migration adds both missing pieces. Nothing here is on the hot path: writes come from
-- POST /api/telemetry, which fails open on any storage error (including "no such table"), so
-- applying this migration late cannot break the funnel — it only starts recording.
--
-- NUMBERING: an earlier draft of this table exists as `008_traffic_events.sql` in the
-- aurum-admin-dashboard worktree. 008 is taken here by 008_msclkid_conversion_uploads.sql.
-- Use THIS file; do not copy that one across.
--
-- Apply once: wrangler d1 execute aurum_leads --remote --file=db/migrations/009_traffic_events.sql
-- (Fresh databases get this from db/schema.sql directly.)
--
-- NOT IDEMPOTENT: SQLite has no "ADD COLUMN IF NOT EXISTS". If click_sessions.hostname
-- already exists, run the CREATE TABLE / CREATE INDEX statements alone.

CREATE TABLE IF NOT EXISTS traffic_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT NOT NULL,      -- allowlisted server-side; see TRAFFIC_EVENTS
  session_id      TEXT NOT NULL,      -- opaque per-tab id, same value stored on leads.session_id
  -- The fo_click cookie value, read SERVER-SIDE. This is the ONLY direct join to
  -- click_sessions. session_id above is a browser-minted UUID and click_sessions is keyed by a
  -- server-minted token, so without this column the only path between them runs through
  -- leads.lead_id — which exists only for sessions that converted, i.e. never for the abandoned
  -- sessions this table was built to study.
  click_session_id TEXT,
  hostname        TEXT,               -- normalised from request.url; never client-supplied
  brand           TEXT,
  form_version    TEXT,               -- FORM_CONFIG.formVersion at the time of the event
  form_variant    TEXT,               -- FORM_CONFIG.formVariant
  build_id        TEXT NOT NULL DEFAULT 'unknown',  -- ties a row to a deployed bundle
  form_step       INTEGER,            -- 1..14, NULL for non-step events
  error_code      TEXT,               -- allowlisted CODE only, never a message
  device_class    TEXT,               -- mobile | tablet | desktop | unknown
  browser_family  TEXT,               -- chrome | safari | firefox | edge | other | unknown
  browser_timezone TEXT,
  touch_capable   INTEGER NOT NULL DEFAULT 0,
  source          TEXT,               -- utm_source, never a raw click id
  campaign        TEXT,               -- utm_campaign
  occurred_at     TEXT NOT NULL,      -- client clock, validated and clamped server-side
  -- 1 when occurred_at was unparseable or outside [-5min, +24h] and server time was
  -- substituted. Without this flag a substituted timestamp is indistinguishable from a real
  -- one, and every time-series silently inherits the lie.
  clock_skew      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL       -- server clock; trust this one for time-series
);

-- The drop-off query: per-step counts over a recent window.
CREATE INDEX IF NOT EXISTS idx_traffic_events_created_step
  ON traffic_events (created_at, form_step, event_type);

-- The join that makes abandoned sessions attributable to the paid click that bought them.
CREATE INDEX IF NOT EXISTS idx_traffic_events_click_session
  ON traffic_events (click_session_id);

-- Per-brand funnel comparison — the thing that was impossible before.
CREATE INDEX IF NOT EXISTS idx_traffic_events_host_created
  ON traffic_events (hostname, created_at);

-- Reconstructing a single applicant's path through the 14 steps.
CREATE INDEX IF NOT EXISTS idx_traffic_events_session
  ON traffic_events (session_id, occurred_at);

-- Which brand did this paid click actually land on? Written by functions/_middleware.ts.
-- Nullable: every row written before this migration keeps hostname = NULL, and analysis
-- must therefore treat pre-migration rows as "unknown brand" rather than as a real value.
ALTER TABLE click_sessions ADD COLUMN hostname TEXT;

CREATE INDEX IF NOT EXISTS idx_click_sessions_host_seen
  ON click_sessions (hostname, click_seen_at);
