-- Migration 008 — add msclkid (Microsoft Ads) to conversion_uploads.
--
-- Scratchpaypaw runs Microsoft Ads (msclkid) instead of Google Ads (gclid); the
-- drain routes by whichever click id is present on the row. The click id is already
-- captured into the lead's tracking_json (TRACKING_KEYS includes msclkid) and the
-- click_sessions table (migration 005) — this only adds the column that carries it
-- into the conversion-upload queue, where the postback previously dropped it.
--
-- Additive only: a nullable column, no data change. Google-only rows simply keep
-- msclkid = NULL, so the existing Google drain path is unaffected.
--
-- Apply once: wrangler d1 execute aurum_leads --remote --file=db/migrations/008_msclkid_conversion_uploads.sql
-- (Fresh databases get this from db/schema.sql directly.)

ALTER TABLE conversion_uploads ADD COLUMN msclkid TEXT;
