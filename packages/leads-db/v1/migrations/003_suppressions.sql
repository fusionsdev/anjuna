-- Migration 003 — email suppression list (mailing-list reverse-sync sink).
-- listmonk is the authoritative send-time suppression store; this table mirrors its
-- blocklist/unsubscribes back into D1 (the source of truth) so a listmonk rebuild — or a
-- second list seeded from /api/admin/subscribers.csv — never re-mails a complainer.
-- Written by POST /api/admin/suppress (see functions/api/[[path]].ts), read by the CSV export.
--
-- Apply once:  wrangler d1 execute aurum_leads --file=db/migrations/003_suppressions.sql
-- (Fresh databases get this from db/schema.sql directly.)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,        -- lowercased
  reason TEXT NOT NULL,          -- blocklisted | unsubscribed | complaint | bounce | manual
  source TEXT NOT NULL,          -- listmonk | ses | manual
  created_at TEXT NOT NULL,
  updated_at TEXT
);
