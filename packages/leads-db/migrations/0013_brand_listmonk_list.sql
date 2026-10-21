-- Migration 0013: per-brand listmonk list, created by the install workflow (sync_runtime step).
-- The mailing cron sends a brand's outbox rows to this list. NULL means "no list yet": the cron
-- falls back to the tenant LISTMONK_LIST_MAP entry for the brand. Leads never depend on it.

ALTER TABLE brand_runtime ADD COLUMN listmonk_list_id INTEGER
  CHECK (listmonk_list_id IS NULL OR (typeof(listmonk_list_id) = 'integer' AND listmonk_list_id > 0));
