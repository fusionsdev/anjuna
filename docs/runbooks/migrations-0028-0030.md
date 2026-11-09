# Migrations runbook: Wave 5 (leads 0028–0030, auth 0002)

- **Date:** 2026-11-10
- **Lane:** W03-2 · reviewed against `W01-backend.md` task W01-2 (W01 owns
  the SQL) and the merged PR 198 (`6ff122b`), which is the source of truth
  for the file contents below
- **Rule:** no deploy and no real external call from an agent (AGENTS.md
  rule 7). Applying these migrations on a real tenant is an owner action
  (Wave 4 gate), executed by the person holding the tenant's Cloudflare
  token — `CLOUDFLARE_API_TOKEN` is a Worker-adjacent token, it is never
  committed.

## Files (owned by lane W01, task W01-2)

| Migration | Database | File |
| --- | --- | --- |
| 0028 | leads | `packages/leads-db/migrations/0028_traffic_ua_country.sql` |
| 0029 | leads | `packages/leads-db/migrations/0029_alert_state.sql` |
| 0030 | leads | `packages/leads-db/migrations/0030_notification_log.sql` |
| 0002 | auth | `packages/auth-db/migrations/0002_user_prefs.sql` |

What each adds:

- **0028** (leads): nullable `user_agent_family TEXT`, `country TEXT`,
  `region TEXT` on `traffic_events`, and one index
  `idx_traffic_events_brand_created` on `traffic_events(brand, created_at)`.
  The existing `idx_traffic_events_created_step` already covers the
  `created_at` prefix; no new created_at index is created.
- **0029** (leads): table `alert_state(alert_key TEXT PRIMARY KEY, state
  TEXT NOT NULL, first_seen TEXT NOT NULL, last_sent TEXT,
  acknowledged_by TEXT, acknowledged_at TEXT, closed_at TEXT, updated_at
  TEXT NOT NULL)`.
- **0030** (leads): table `notification_log(id TEXT PRIMARY KEY, channel
  TEXT NOT NULL, target TEXT NOT NULL, alert_key TEXT NOT NULL, status
  TEXT NOT NULL, response_code INTEGER, body_hash TEXT NOT NULL, sent_at
  TEXT NOT NULL)` plus index
  `idx_notification_log_sent_at ON notification_log(sent_at)`.
- **0002** (auth): table `user_prefs(user_id TEXT NOT NULL, key TEXT NOT
  NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, key))`.

All four migrations are additive: new nullable columns and new tables. No
column is rewritten, no row is touched, no table is recreated, so nothing
blocks a running core during apply.

## Order

`wrangler d1 migrations apply` runs pending migrations in filename order
inside a database, so one apply command per database is enough. Apply leads
first (0028 → 0029 → 0030), then auth (0002). Choose the config of the
tenant you are touching — the database ids differ per tenant:

| Tenant | Cloudflare account id | Panel origin |
| --- | --- | --- |
| aduplift | `6cb8500c35210800451bd9a535482850` | `app.aduplift.ai` |
| maimax | `c1a44deffd54a8ce35cb9e68abeb7b11` | `app.maimax.com` |

Core domains follow the same tenant origin shape (`core.aduplift.ai`,
`core.maimax.com`).

Account ids and database ids live in `workers/core/wrangler.deploy.*.jsonc`
and `apps/web/wrangler.deploy.*.jsonc` (they guard against applying in the
wrong account). This is the same sequence the deploy workflow runs
(`.github/workflows/deploy.yml` applies 0028–0030 on the leads db and 0002
on the auth db per tenant — lines 55–57 aduplift, 167–169 maimax).

All blocks below are `sh` (the deploy workflow uses bash). On PowerShell,
either run them inside a bash shell or replace the `\` line continuation
with a backtick.

## Apply (aduplift)

```sh
CF=workers/core/wrangler.deploy.aduplift.jsonc
CA=apps/web/wrangler.deploy.aduplift.jsonc

bunx wrangler d1 migrations apply aduplift-leads   --remote --config "$CF"
# 0028, 0029, 0030
bunx wrangler d1 migrations apply aduplift-factory --remote --config "$CF"
# no-op, sanity check
bunx wrangler d1 migrations apply aduplift-auth    --remote --config "$CA"
# 0002
```

## Apply (maimax)

```sh
CF=workers/core/wrangler.deploy.maimax.jsonc
CA=apps/web/wrangler.deploy.maimax.jsonc

bunx wrangler d1 migrations apply maimax-leads   --remote --config "$CF"
# 0028, 0029, 0030
bunx wrangler d1 migrations apply maimax-factory --remote --config "$CF"
# no-op, sanity check
bunx wrangler d1 migrations apply maimax-auth    --remote --config "$CA"
# 0002
```

Each apply prints the applied migration list; the last line must be `0030`
on leads and `0002` on auth. A second run without changes prints
"No migrations to apply" — idempotent, safe to re-run.

After each tenant's leads and auth applies, deploy that tenant's core and
web (the new columns and tables are useless to an old Worker and harmless
to an existing one — additive, so deploy order is not urgent). Deploy is
owner-gated; see `docs/runbooks/gates/`.

## Verify after apply — aduplift

Expected state on a tenant that just picked up Wave 5 (traffic counters and
notification state start empty; `traffic_events` counts are whatever the
brand already had). V1–V4 are the labels the Expected-row table below
refers to.

```sh
CF=workers/core/wrangler.deploy.aduplift.jsonc
CA=apps/web/wrangler.deploy.aduplift.jsonc

# V1 applied-migration ledger: exactly the Wave 5 names must be listed.
# The query filters by name because a healthy leads DB already holds
# 30 rows (0001-0030) and auth 2 - an unfiltered SELECT returns all of
# them. (wrangler "d1 migrations list" shows only *pending* migrations,
#  so "no migrations to apply" is the correct *list* outcome)
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT name FROM d1_migrations WHERE name IN \
('0028_traffic_ua_country.sql','0029_alert_state.sql',\
'0030_notification_log.sql') ORDER BY name"
bunx wrangler d1 execute aduplift-auth --remote --config "$CA" \
  --command "SELECT name FROM d1_migrations WHERE name IN \
('0002_user_prefs.sql') ORDER BY name"

# V2 the three columns exist, nullable, no default
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT name, \"notnull\", dflt_value FROM \
pragma_table_info('traffic_events') WHERE name IN \
('user_agent_family','country','region')"

# V3 the new tables exist and start empty
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT (SELECT COUNT(*) FROM alert_state) AS alert_state, \
(SELECT COUNT(*) FROM notification_log) AS notification_log"
bunx wrangler d1 execute aduplift-auth --remote --config "$CA" \
  --command "SELECT COUNT(*) AS user_prefs FROM user_prefs"
```

Expected row counts and values:

| Query | Expected |
| --- | --- |
| V1 (leads) | 3 rows, the three names in the list below |
| V1 (auth) | 1 row, `0002_user_prefs.sql` |
| V2 | 3 rows, all `notnull = 0`, `dflt_value = NULL` |
| V3 | `alert_state` = 0, `notification_log` = 0, `user_prefs` = 0 |

V1 (leads) must list exactly these three ledger names:

- `0028_traffic_ua_country.sql`
- `0029_alert_state.sql`
- `0030_notification_log.sql`

The filtered query is what makes "3 rows" exact. An unfiltered
`SELECT name FROM d1_migrations` is not a 3-row check: a correctly
migrated leads database already holds **30** ledger rows (0001–0030) and
auth holds **2** (0001–0002). Compare the returned set, not the row count
of the whole table.

The ledger stores the **full filename, `.sql` included** — Wrangler inserts
the relative filename it read from `migrations_dir` and matches it exactly
when it computes pending migrations. Copy these strings verbatim into any
`d1_migrations` query; a name without `.sql` matches 0 rows and silently
leaves the ledger unchanged.

(V3 rows appear only after the first cron tick / a panel save.)

Repeat each query with `maimax-*` database names and the maimax configs.

## Rollback

Rollback is per tenant, per migration table, in reverse filename order,
with the reverse SQL as one `--command` string (statements separated by
`;` — wrangler takes a single string per `--command`). Do the steps in
this order:

1. **Stop the Wave 5 writers first.** A core/web deploy of this wave
   writes the new columns and tables; rolling the schema back underneath a
   live Wave 5 worker makes it error. Downgrade the tenant's core (and web
   where it writes `user_prefs`) to the pre-Wave-5 build, or otherwise
   stop the writes, before touching D1.
2. **Run the reverse SQL.** Full reverse SQL rounds the tenant's leads
   schema: 0030 → 0029 → 0028 (newest first). Auth is a separate database
   with its own config; it uses the same pattern for 0002.
3. **Erase the `d1_migrations` ledger rows in the same command.** Wrangler
   decides "pending" from the ledger, so a rolled-back migration whose
   ledger row survives would never be re-applied by
   `d1 migrations apply`. The ledger `name` is the **full migration
   filename including the `.sql` extension** — Wrangler inserts the
   relative filename it read from `migrations_dir` and compares it exactly
   when computing pending migrations. Get the exact strings from V1 and
   keep them verbatim.
4. **Verify the rollback: objects gone, ledger empty, no rows.** Run R1,
   R2 and R3 below. Do not re-run V3 here: it selects from the tables step 2
   just dropped, so it would fail with `no such table` instead of reporting
   a result.
5. **Re-apply when the tenant moves forward again** (the Apply commands
   above), then redeploy core and web.

Rollback (aduplift, leads then auth):

```sh
CF=workers/core/wrangler.deploy.aduplift.jsonc
CA=apps/web/wrangler.deploy.aduplift.jsonc

# leads: full reverse SQL of 0030, 0029, 0028 in one command
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "DROP INDEX IF EXISTS idx_notification_log_sent_at; \
DROP TABLE IF EXISTS notification_log; \
DROP TABLE IF EXISTS alert_state; \
DROP INDEX IF EXISTS idx_traffic_events_brand_created; \
ALTER TABLE traffic_events DROP COLUMN user_agent_family; \
ALTER TABLE traffic_events DROP COLUMN country; \
ALTER TABLE traffic_events DROP COLUMN region; \
DELETE FROM d1_migrations WHERE name IN \
('0030_notification_log.sql','0029_alert_state.sql', \
'0028_traffic_ua_country.sql');"

# auth: reverse SQL of 0002 (separate database)
bunx wrangler d1 execute aduplift-auth --remote --config "$CA" \
  --command "DROP TABLE IF EXISTS user_prefs; \
DELETE FROM d1_migrations WHERE name = '0002_user_prefs.sql';"
```

Rollback (maimax, same SQL, maimax database and configs):

```sh
CF=workers/core/wrangler.deploy.maimax.jsonc
CA=apps/web/wrangler.deploy.maimax.jsonc

bunx wrangler d1 execute maimax-leads --remote --config "$CF" \
  --command "DROP INDEX IF EXISTS idx_notification_log_sent_at; \
DROP TABLE IF EXISTS notification_log; \
DROP TABLE IF EXISTS alert_state; \
DROP INDEX IF EXISTS idx_traffic_events_brand_created; \
ALTER TABLE traffic_events DROP COLUMN user_agent_family; \
ALTER TABLE traffic_events DROP COLUMN country; \
ALTER TABLE traffic_events DROP COLUMN region; \
DELETE FROM d1_migrations WHERE name IN \
('0030_notification_log.sql','0029_alert_state.sql', \
'0028_traffic_ua_country.sql');"

bunx wrangler d1 execute maimax-auth --remote --config "$CA" \
  --command "DROP TABLE IF EXISTS user_prefs; \
DELETE FROM d1_migrations WHERE name = '0002_user_prefs.sql';"
```

Index names are the ones PR 198 actually creates
(`idx_notification_log_sent_at`, `idx_traffic_events_brand_created`);
copy them from the migration files if a later Wave 5 PR renames them.
`ALTER TABLE ... DROP COLUMN` is supported by D1 (SQLite ≥ 3.35); the
pre-existing `idx_traffic_events_created_step` stays untouched by design.

## Verify after rollback — aduplift

Run these instead of V2/V3. V2 still works (it reads `pragma_table_info`,
which simply returns no rows once the columns are gone), but V3 selects
from the tables that step 2 dropped, so it errors with `no such table`.
Check object existence through `sqlite_master` instead.

```sh
CF=workers/core/wrangler.deploy.aduplift.jsonc
CA=apps/web/wrangler.deploy.aduplift.jsonc

# R1 the Wave 5 objects are gone (expect an empty result on both)
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT type, name FROM sqlite_master WHERE \
name IN ('alert_state','notification_log', \
'idx_notification_log_sent_at','idx_traffic_events_brand_created')"
bunx wrangler d1 execute aduplift-auth --remote --config "$CA" \
  --command "SELECT type, name FROM sqlite_master WHERE name = 'user_prefs'"

# R2 the ledger no longer lists this set, and nothing else was lost
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT name FROM d1_migrations WHERE name IN \
('0028_traffic_ua_country.sql','0029_alert_state.sql', \
'0030_notification_log.sql')"
bunx wrangler d1 execute aduplift-auth --remote --config "$CA" \
  --command "SELECT name FROM d1_migrations WHERE name = '0002_user_prefs.sql'"

# R3 V2 again: the three columns are gone, so 0 rows
bunx wrangler d1 execute aduplift-leads --remote --config "$CF" \
  --command "SELECT name FROM pragma_table_info('traffic_events') \
WHERE name IN ('user_agent_family','country','region')"
```

Expected after a clean rollback:

| Query | Expected |
| --- | --- |
| R1 (leads) | empty result — 0 objects from the `IN` list |
| R1 (auth) | empty result — no `user_prefs` |
| R2 (leads) | empty result — 0 ledger rows for 0028–0030; earlier rows stay |
| R2 (auth) | empty result — 0 ledger rows for 0002; `0001_*` stays |
| R3 | 0 rows (was 3 rows after apply, V2) |

If R2 still returns a name, the `.sql` suffix in step 3 did not match the
ledger — copy the string from V1 verbatim and rerun step 3 only. If R1
still returns an object, the reverse SQL did not run in full; check the
command's `--command` string for a missing `;`.

Repeat with maimax database names and the maimax configs.

Rolling back tables that have already collected rows loses only state for
this feature: `alert_state` is re-derived from the current report on the
next cron tick (at worst one duplicate notification); `notification_log`
delivery history is gone — that is the only real loss; `user_prefs` rows
are recreated on the next save. `traffic_events.country` is derived at
insert, so past rows simply report "unknown" until the column is
re-applied.

## Notes

- Never run apply/rollback with two operators at once; serialize the
  operations per tenant.
- The W03 lane did not author the SQL and cannot run it: apply and
  rollback commands were reviewed here (runbook review only), and the
  acceptance for W01-2 remains "migrations apply on a fresh Miniflare D1
  in a test".
- The `factory` apply command is a deliberate no-op check that the config
  still points at the right account — it prints "No migrations to apply".
- After 0030 the panel's "ประวัติการส่ง" tab reads `notification_log` —
  see `docs/runbooks/notifications.md`.
