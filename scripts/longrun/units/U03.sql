# <database>[@<account_id>]|<SELECT>  Run by the supervisor through d1-read.sh, never by an agent.
aduplift-leads|SELECT lead_id, click_id, state, zip, status, form_variant, brand, hostname, created_at FROM leads WHERE lead_id = '364b99d5-236b-4df8-9357-b2971fcbea05'
aduplift-leads|SELECT id, lead_id, event_type, payout, created_at FROM postback_events WHERE lead_id = '364b99d5-236b-4df8-9357-b2971fcbea05'
aduplift-leads|SELECT id, lead_id, gclid IS NOT NULL AS has_gclid, value, currency, status, attempts, last_error, created_at FROM conversion_uploads WHERE lead_id = '364b99d5-236b-4df8-9357-b2971fcbea05'
aduplift-leads|SELECT lead_id, brand_id, expires_at, used_at FROM continuations WHERE lead_id = '364b99d5-236b-4df8-9357-b2971fcbea05'
