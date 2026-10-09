# <database>[@<account_id>]|<SELECT>  Run by the supervisor through d1-read.sh, never by an agent.
aduplift-factory|SELECT install_id, kind, status, error, is_canary, started_at, finished_at FROM installs WHERE brand_id = 'brand_e210d8e7f5234dde' ORDER BY started_at
aduplift-factory|SELECT r.install_id, r.step, r.status, r.created_at FROM install_receipts r JOIN installs i ON i.install_id = r.install_id WHERE i.brand_id = 'brand_e210d8e7f5234dde' ORDER BY r.created_at
aduplift-factory|SELECT brand_id, domain, status, current_revision_id, updated_at FROM brands WHERE brand_id = 'brand_e210d8e7f5234dde'
