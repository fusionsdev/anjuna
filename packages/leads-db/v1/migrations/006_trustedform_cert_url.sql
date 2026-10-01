-- Migration 006 — ActiveProspect TrustedForm consent-certificate URL.
-- Apply once:  wrangler d1 execute aurum_leads --remote --file=db/migrations/006_trustedform_cert_url.sql
-- (Fresh databases get this from db/schema.sql directly.)
--
-- Stores the TrustedForm cert URL alongside the rest of the FCRA/TCPA consent audit trail.
-- Never forwarded to the buyer except over the server_post POST body (see functions/api/[[path]].ts
-- forwardToBuyer) — never a query string, never sent to Sentry/PostHog/GTM/logs.

ALTER TABLE consent_evidence ADD COLUMN trustedform_cert_url TEXT;
