# Drain routing helpers

Core serves the per-brand Google Ads route at `GET /api/conversions/routing` (drain token, header only). The owner edits it in the panel's money section (Google Ads account, conversion action, AdKit project). These helpers turn that response into the `BRAND_ROUTING_JSON` env that the unchanged `drain.mjs` already reads.

- `refresh-routing.mjs <out.json>` reads `FORM_BASE_URL` and `DRAIN_TOKEN`, validates the map, writes `<out.json>.tmp` and renames it. On failure it exits 1 and keeps the old file. Success prints `routing refreshed: N brand(s)`.
- `run.sh` is the cron wrapper for the maimax VPS.
- `scheduler.mjs` is the 10-minute loop for the hstgr Docker container.
- `routing-env.mjs <routing.json>` prints the map only when it has at least 1 brand; `run.sh` and `scheduler.mjs` use it.

- `conversion-sync.mjs [--dry-run]` creates the missing Google Ads conversion action per brand (FUS-384). It reads `GET /api/conversions/setup/pending`, lists the account's conversions with `adkit manage google conversions list --account <account> --limit 500 --json`, picks the stored name or a random `cv-` plus 16 hex name, claims it in core (`POST /api/conversions/setup/claim`), then adopts the listed conversion or runs `adkit manage google conversions create ... --publish --json`, and posts the id or error to `POST /api/conversions/setup/result` (drain token). `--dry-run` prints one `plan` line per brand and sends nothing. The create body is `{"conversions":[{...}]}`. It needs `@adkit/cli` 1.13.54 or newer (1.13.25 has no `conversions create` or `list`). `run.sh` and `scheduler.mjs` run it every tick after the routing refresh, then refresh routing again.
- `spend-sync.mjs [--dry-run]` copies each routed brand's Google Ads spend into core (FUS-368). It reads the same routing, runs `adkit manage google results --account <account> --breakdown hour --from <date> --to <date> --json [--project <project>]` per brand and per date (yesterday and today, UTC, one date per call so the hour breakdown never sums across days; hour rows carry no date, so the call's date is stamped on them; needs `@adkit/cli` 1.13.54 or newer), and POSTs the rows to `POST /api/spend/ingest` (drain token). Core upserts by brand, date, hour and source, so a rerun replaces values. `SPEND_BREAKDOWN=day` stores one whole-day row per day instead. `--dry-run` prints the mapped rows and sends nothing. `run.sh` and `scheduler.mjs` run it once an hour after the drain.
- `adkit-executor.mjs` runs the AdKit jobs the panel queues (panel redesign T9, ADR-0005). It reads `GET /api/adkit/jobs/pending`, claims each job with `POST /api/adkit/jobs/claim` (409 means another run holds it), runs it and posts the result or error to `POST /api/adkit/jobs/result` (drain token). Only `manage google` `accounts list`, `conversions list`, `results list`, the two `results campaigns` shapes below and `conversions create` can run; any other command is rejected before a process is spawned. `conversion_action.create` adopts the job's name when the account already has it, otherwise creates it with `--publish`, and adopts the existing id on a duplicate-name error. Not scheduled yet: the VPS install is an owner action (Wave 4).
- `adkit-directory-sync.mjs` copies AdKit projects, Google Ads accounts (with currency) and conversion actions into core with `POST /api/adkit/directory/ingest` (drain token). It runs `adkit manage google accounts list --json [--project <p>]` for each project in `ADKIT_PROJECTS` (comma list; else `GOOGLE_PROJECT` / `ADKIT_PROJECT`) and `conversions list` per account. Core serves a row for 2 hours after its last sync, so the job must run hourly. Not scheduled yet: owner action (Wave 4).

All of them need Node 20 or later and no npm packages. `drain.mjs` stays byte-for-byte the vendored V1 file (`packages/contracts/test/v1/drain.mjs`).

A brand appears in the map only when both account and conversion action are set. An empty map `{}` is written to `routing.json` but never exported: `drain.mjs` treats a set-but-empty `BRAND_ROUTING_JSON` as "routing active, 0 keys" and skips every gclid row. With no usable map the drain keeps whatever `.env` sets, including legacy single-account mode (`GOOGLE_ADS_ACCOUNT` + `GOOGLE_CONVERSION_ACTION`).

## maimax VPS (`/opt/drain`, cron)

1. Copy `refresh-routing.mjs`, `routing-env.mjs`, `conversion-sync.mjs`, `spend-sync.mjs` and `run.sh` next to `drain.mjs` and `.env` in `/opt/drain`.
2. `chmod +x /opt/drain/run.sh`.
3. `.env` keeps `FORM_BASE_URL` and `DRAIN_TOKEN`. Keep the old hand-edited `BRAND_ROUTING_JSON` until the first refresh succeeds; after that `routing.json` overrides it.
4. Replace the crontab line that ran `node drain.mjs` with:
   `*/10 * * * * /opt/drain/run.sh >> /opt/drain/drain.log 2>&1`
5. Check: `/opt/drain/run.sh` prints `routing refreshed: N brand(s)` and `[routing] per-brand routing active for N brand key(s)`.

Set `NODE=/path/to/node` in the crontab line when cron's `PATH` has no `node`.

## hstgr Docker (`/app`, `/data`)

1. Copy `refresh-routing.mjs`, `routing-env.mjs`, `conversion-sync.mjs`, `spend-sync.mjs` and `scheduler.mjs` into `/app` beside `drain.mjs`.
2. Mount a volume at `/data` so `routing.json` survives restarts.
3. Container command: `node /app/scheduler.mjs`. Health check: `/tmp/heartbeat` younger than 15 minutes.
4. Pass `FORM_BASE_URL` and `DRAIN_TOKEN` as container env, never baked into the image.

## Campaign spend for shared accounts (T13 task 2)

Only accounts used by more than one brand in `/api/conversions/routing` use the campaign path. Each account/date is fetched once, irrespective of brand count. Single-brand accounts retain the account command, mapping and `/api/spend/ingest` endpoint above.

AdKit CLI 1.13.54 has no `--level` flag. The exact campaign commands are:

```text
adkit manage google results campaigns --account <a> --from <D> --to <D> --limit 500 --json [--project <p>]
adkit manage google results campaigns --account <a> --campaign <id> --breakdown hour --fields cost,clicks,impressions --from <D> --to <D> --limit 500 --json [--project <p>]
```

The daily response supplies `id`, `name`, `status`, `cost`, `clicks` and `impressions`. Only campaigns with cost greater than zero get an hourly call, including paused campaigns. Hourly rows have no campaign id or date: these come from the request. `hour` is in the Ads account timezone. The explicit `--fields` avoids AdKit's incompatible `search_click_share` default. Empty hourly results use the daily metrics with `hour: null`. CLI errors, malformed metrics and `warnings[].code = row_limit_reached` fail that campaign/date, log an error and send none of its rows; truncated daily lists fail the account/date. Any failure makes the process exit 1; other campaigns/dates continue.

POST `/api/spend/campaign-ingest` uses the drain bearer token and `{ account, currency, utc_offset_minutes, rows }`, with up to 5000 rows per request. Each row has `{ campaign_id, date, hour, cost, clicks, impressions }`; cost retains the CLI's decimal precision. Currency comes from `accounts list`. A missing or unsupported currency fails the shared account rather than guessing.

Configure `ADKIT_UTC_OFFSET_MINUTES` (default `420`, Bangkok). Optional `ADKIT_UTC_OFFSET_BY_ACCOUNT='{"5381163935":420}'` overrides individual accounts. Values must be integer minutes between -720 and 840; the entire configuration is validated before any HTTP or CLI call. Use the offset appropriate for the requested dates; a fixed offset does not infer daylight-saving changes.

By default the existing UTC yesterday/today window is retained. `--from YYYY-MM-DD [--to YYYY-MM-DD]` supplies an inclusive backfill range (`--to` defaults to today UTC). Each CLI call still covers only one date. `--dry-run` prints mapped rows, account, currency and offset, with zero POSTs. It still reads core and AdKit in normal operation, so run it only with owner authorization. Offline verification injects fixture runners and an empty PATH:

```text
cd scripts
bunx vitest run test/drain-spend-sync.test.ts test/adkit-executor.test.ts
```

After merge, deploy **core, then panel, then this script**. An old core returns 404 on the campaign route. Backfill and VPS installation remain owner actions; reruns rely on core's idempotent upserts. No VPS or AdKit invocation was used to build these changes; fixtures were supplied in the task brief.

When installing this version, copy `adkit-executor.mjs` and `conversion-sync.mjs` beside `spend-sync.mjs`: the campaign path imports the shared argument guard, whose module imports the conversion helpers. Importing these modules does not run their CLI entry points. The default UTC date window can lag the next local day by 7 hours for UTC+7 accounts; choose explicit dates for a backfill.

## Deploy 0025 (adkit_jobs claim_seq and result_seq, T13-4d)

Migration `0025_adkit_jobs_claim_seq.sql` adds the job event counter. The old core does not set it, so any claim or result the old core records after the migration keeps `claim_seq` or `result_seq` NULL. The new core reads NULL as 0: a NULL done enable sorts before every backfilled pause and the campaign stops counting toward the caps, and a NULL check claim drops the check's ENABLED evidence. Only `adkit-executor.mjs` triggers claims, results and the lease-expiry sweep (`GET /api/adkit/jobs/pending`), so the executor must not run between the migration and the core deploy.

Run these steps once per deployment, for the aduplift core (`wrangler.deploy.aduplift.jsonc`, D1 `aduplift-leads`) and for the maimax core (`wrangler.deploy.maimax.jsonc`, D1 `maimax-leads`):

1. Stop the adkit executor on both VPS. maimax: comment out the crontab line that runs `adkit-executor.mjs` (or `run.sh`, if it calls the executor) and check that `pgrep -f adkit-executor.mjs` prints nothing. hstgr: stop the executor step in `scheduler.mjs` (or `docker stop` the drain container) and check the same. Skip a VPS where the executor is not installed yet.
2. Apply the migration: `cd workers/core && bunx wrangler d1 migrations apply <db> --remote -c <deploy config>`.
3. Deploy core: `bunx wrangler deploy -c <deploy config>`.
4. Check for NULL rows and require 0:
   `bunx wrangler d1 execute <db> --remote -c <deploy config> --command "SELECT COUNT(*) FROM adkit_jobs WHERE (claimed_at IS NOT NULL AND status = 'claimed' AND claim_seq IS NULL) OR (status IN ('done','failed','unknown') AND result_seq IS NULL)"`.
   A non-zero count means the old core recorded a claim or result after step 2. Keep the executor stopped: give those rows numbers above the current maximum of both columns, one row at a time in updated_at order (claim before result), then repeat step 4.
5. Start the executor again on both VPS (restore the crontab line, restart the container or scheduler step).

The steps are idempotent. A run with nothing claimed or finished during the gap returns 0 at step 4.
