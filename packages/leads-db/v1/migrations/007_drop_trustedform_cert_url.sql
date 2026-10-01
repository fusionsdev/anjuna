-- Migration 007 — rollback of migration 006 (TrustedForm cert URL column).
-- Apply once:  wrangler d1 execute aurum_leads --remote --file=db/migrations/007_drop_trustedform_cert_url.sql
--
-- LeadsGate confirmed 2026-08 they do not accept a TrustedForm certificate URL at all (it adds
-- processing latency on their side and none of their lenders require it) — not a temporary
-- blocker, a closed decision. The client script, hidden field, and server plumbing added in
-- migration 006 have been removed; this drops the now-unused column.

ALTER TABLE consent_evidence DROP COLUMN trustedform_cert_url;
