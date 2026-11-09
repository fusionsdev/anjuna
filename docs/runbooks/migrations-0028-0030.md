# Migrations runbook: leads 0028–0030 and auth 0002 (panel redesign Wave 5)

- **Date:** 2026-11-10
- **Lane:** W03-2 · reviewed against `W01-backend.md` task W01-2 (W01 owns the SQL)
- **Rule:** no deploy and no real external call from an agent (AGENTS.md rule 7). Applying these migrations on a real tenant is an owner action (Wave 4 gate), executed by the person holding the tenant's Cloudflare token — `CLOUDFLARE_API_TOKEN` is a Worker-adjacent token, it is never committed.

## Files (owned by lane W01, task W01-2)

| Migration | Database | File | Adds |
| --- | --- | --- | --- |
| 0028 | leads | `packages/leads-db/migrations/0028_traffic_ua_country.sql` | nullable `user_agent_family TEXT`, `country TEXT`, `region TEXT` on `traffic_events`; indexes on `(created_at)` and `(brand, created_at)` when missing |
| 0029 | leads | `packages/leads-db/migrations/0029_alert_state.sql` | `alert_state(alert_key TEXT PRIMARY KEY, state TEXT NOT NULL, first_seen TEXT NOT NULL, last_sent TEXT, acknowledged_by TEXT, acknowledged_at TEXT, closed_at TEXT, updated_at TEXT NOT NULL)` |
| 0030 | leads | `packages/leads-db/migrations/0030_notification_log.sql` | `notification_log(id TEXT PRIMARY KEY, channel TEXT NOT NULL, target TEXT NOT NULL, alert_key TEXT NOT NULL, status TEXT NOT NULL, response_code INTEGER, body_hash TEXT NOT NULL, sent_at TEXT NOT NULL)` + index on `sent_at` |
| 0002 | auth | `packages/auth-db/migrations/0002_user_prefs.sql` | `user_prefs(user_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, key))` |

All three leads migrations and the auth migration are additive: new nullable columns and new tables. No column is rewritten, no row is touched, no table is recreated, so nothing blocks a running core during apply.

## Order

`wrangler d1 migrations apply` runs pending migrations in filename order inside a database, so one apply command per database is enough. Apply leads first (0028 → 0029 → 0030), then auth (0002). Choose the config of the tenant you are touching — the database ids differ per tenant:

| Tenant | Cloudflare account id | Core domain | Panel |
| --- | --- | --- | --- |
| aduplift | `6cb8500c35210800451bd9a535482850` | `core.aduplift.ai` | `app.aduplift.ai` |
| maimax | `c1a44deffd54a8ce35cb9e68abeb7b11` | `core.maimax.com` | `app.maimax.com` |

Account ids and database ids live in `workers/core/wrangler.deploy.*.jsonc` and `apps/web/wrangler.deploy.*.jsonc` (they guard against applying in the wrong account). This is the same sequence the deploy workflow runs (`.github/workflows/deploy.yml` lines 55–57 and 167–169).

## Apply (aduplift)

```sh
bun x wrangler d1 migrations apply aduplift-leads   --remote --config workers/core/wrangler.deploy.aduplift.jsonc    # 0028, 0029, 0030
bun x wrangler d1 migrations apply aduplift-factory --remote --config workers/core/wrangler.deploy.aduplift.jsonc    # no-op, sanity check
bun x wrangler d1 migrations apply aduplift-auth    --remote --config apps/web/wrangler.deploy.aduplift.jsonc        # 0002
```

## Apply (maimax)

```sh
bun x wrangler d1 migrations apply maimax-leads   --remote --config workers/core/wrangler.deploy.maimax.jsonc     # 0028, 0029, 0030
bun x wrangler d1 migrations apply maimax-factory --remote --config workers/core/wrangler.deploy.maimax.jsonc     # no-op, sanity check
bun x wrangler d1 migrations apply maimax-auth    --remote --config apps/web/wrangler.deploy.maimax.jsonc         # 0002
```

Each apply prints the applied migration list; the last line must be `0028` (or higher) on leads and `0002` on auth. A second run without changes prints "No migrations to apply" — idempotent, safe to re-run.

After each tenant's leads and auth applies, deploy that tenant's core and web (the new columns and tables are useless to an old Worker and harmless to an existing one — additive, so deploy order is not urgent). Deploy is owner-gated; see `docs/runbooks/gates/`.

## Verify after apply

Expected state on a tenant that just picked up Wave 5 (traffic counters and notification state start empty; `traffic_events` counts are whatever the brand already had):

```sh
# applied-migration ledger: 0028, 0029, 0030 must be listed d1 shows unapplied only before apply
bun x wrangler d1 migrations list aduplift-leads --remote --config workers/core/wrangler.deploy.aduplift.jsonc

# new columns exist with the right nullability and defaults
bun x wrangler d1 execute aduplift-leads --remote --config workers/core/wrangler.deploy.aduplift.jsonc \
  --command "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('traffic_events') WHERE name IN ('user_agent_family','country','region')"

# tables exist and start empty
bun x wrangler d1 execute aduplift-leads --remote --config workers/core/wrangler.deploy.aduplift.jsonc \
  --command "SELECT (SELECT COUNT(*) FROM alert_state) AS alert_state, (SELECT COUNT(*) FROM notification_log) AS notification_log"

bun x wrangler d1 execute aduplift-auth --remote --config apps/web/wrangler.deploy.aduplift.jsonc \
  --command "SELECT COUNT(*) AS user_prefs FROM user_prefs"
```

Expected row counts:

| Query | Expected |
| --- | --- |
| `pragma_table_info('traffic_events') WHERE name IN ('user_agent_family','country','region')` | 3 rows, all `notnull = 0`, `dflt_value = NULL` |
| `alert_state` count | 0 (rows only appear after the first cron tick delivers or transitions an alert) |
| `notification_log` count | 0 |
| `user_prefs` count | 0 (rows appear when a panel user saves brand scope or a saved view) |

Repeat each query with `maimax-*` names and the maimax configs.

## Rollback

Rollback is per migration, reverse filename order, additive inverses of the above — no data recovery needed because every rolled back object was created empty in this wave.

```sh
# leads, tenant aduplift (repeat with maimax config for the other tenant)
bun x wrangler d1 execute aduplift-leads --remote --config workers/core/wrangler.deploy.aduplift.jsonc \
  --command "DROP INDEX IF EXISTS idx_bot_hits_sent_at" --command "DROP INDEX IF EXISTS idx_notification_log_sent_at"
```

Per-migration rollback SQL (run newest first):

| Migration | Rollback SQL |
| --- | --- |
| 0030 | `DROP INDEX IF EXISTS idx_notification_log_sent_at; DROP TABLE IF EXISTS notification_log;` |
| 0029 | `DROP TABLE IF EXISTS alert_state;` |
| 0028 | `DROP INDEX IF EXISTS idx_traffic_events_created_at; DROP INDEX IF EXISTS idx_traffic_events_brand_created_at; ALTER TABLE traffic_events DROP COLUMN user_agent_family; ALTER TABLE traffic_events DROP COLUMN country; ALTER TABLE traffic_events DROP COLUMN region;` |
| 0002 (auth) | `DROP TABLE IF EXISTS user_prefs;` |

Index names above follow whatever W01 actually names them — copy the exact names from the applied `0028` file into the rollback command (the `d1_migrations` ledger tells you which migrations are present; rollback itself is manual `wrangler d1 execute`, not `d1 migrations apply`), and re-run by hand where a partial rollback already dropped some objects. Dropping a column is supported by D1 (SQLite ≥ 3.35). Rolling back tables that have already collected rows loses only state for this feature: `alert_state` (re-derived from the current report on the next cron tick; at worst one duplicate notification), `notification_log` (delivery history gone — the only real loss), `user_prefs` (writers recreate rows on next save). `traffic_events.country` is derived at insert, past rows simply report "unknown".

## Notes

- Never run with two operators at once: wrangler d1 migrations apply takes a per-entry advisory mark; a concurrent second editor could double-apply — serialize.
- W03 lane did not author the SQL and cannot run it: apply commands were reviewed here (runbook review only), the acceptance for W01-2 remains "migrations apply on a fresh Miniflare D1 in a test".
- The `factory` apply command in the snippets is a deliberate no-op check that the config still points at the right account — it prints "No migrations to apply".
- After 0030 the panel's "ประวัติการส่ง" tab reads `notification_log` — see `docs/runbooks/notifications.md`.
