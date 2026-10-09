# <database>[@<account_id>]|<SELECT>  Run by the supervisor through d1-read.sh, never by an agent.
maimax-leads@c1a44deffd54a8ce35cb9e68abeb7b11|SELECT COUNT(*) AS zips FROM zip_lookup
maimax-leads@c1a44deffd54a8ce35cb9e68abeb7b11|SELECT status, COUNT(*) AS n FROM leads GROUP BY status
aduplift-leads|SELECT COUNT(*) AS zips FROM zip_lookup
aduplift-leads|SELECT status, COUNT(*) AS n FROM leads WHERE state = '' GROUP BY status
