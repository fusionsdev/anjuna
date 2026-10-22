# Drain routing helpers

Core serves the per-brand Google Ads route at `GET /api/conversions/routing` (drain token, header only). The owner edits it in the panel's money section (Google Ads account, conversion action, AdKit project). These helpers turn that response into the `BRAND_ROUTING_JSON` env that the unchanged `drain.mjs` already reads.

- `refresh-routing.mjs <out.json>` reads `FORM_BASE_URL` and `DRAIN_TOKEN`, validates the map, writes `<out.json>.tmp` and renames it. On failure it exits 1 and keeps the old file. Success prints `routing refreshed: N brand(s)`.
- `run.sh` is the cron wrapper for the maimax VPS.
- `scheduler.mjs` is the 10-minute loop for the hstgr Docker container.
- `routing-env.mjs <routing.json>` prints the map only when it has at least 1 brand; `run.sh` and `scheduler.mjs` use it.

- `spend-sync.mjs [--dry-run]` copies each routed brand's Google Ads spend into core (FUS-368). It reads the same routing, runs `adkit manage google results list --account <account> --level account --breakdown hour --json [--project <project>]` per brand, and POSTs the rows to `POST /api/spend/ingest` (drain token). Core upserts by brand, date, hour and source, so a rerun replaces values. `SPEND_BREAKDOWN=day` stores one whole-day row per day instead. `--dry-run` prints the mapped rows and sends nothing. `run.sh` and `scheduler.mjs` run it once an hour after the drain.

All of them need Node 20 or later and no npm packages. `drain.mjs` stays byte-for-byte the vendored V1 file (`packages/contracts/test/v1/drain.mjs`).

A brand appears in the map only when both account and conversion action are set. An empty map `{}` is written to `routing.json` but never exported: `drain.mjs` treats a set-but-empty `BRAND_ROUTING_JSON` as "routing active, 0 keys" and skips every gclid row. With no usable map the drain keeps whatever `.env` sets, including legacy single-account mode (`GOOGLE_ADS_ACCOUNT` + `GOOGLE_CONVERSION_ACTION`).

## maimax VPS (`/opt/drain`, cron)

1. Copy `refresh-routing.mjs`, `routing-env.mjs`, `spend-sync.mjs` and `run.sh` next to `drain.mjs` and `.env` in `/opt/drain`.
2. `chmod +x /opt/drain/run.sh`.
3. `.env` keeps `FORM_BASE_URL` and `DRAIN_TOKEN`. Keep the old hand-edited `BRAND_ROUTING_JSON` until the first refresh succeeds; after that `routing.json` overrides it.
4. Replace the crontab line that ran `node drain.mjs` with:
   `*/10 * * * * /opt/drain/run.sh >> /opt/drain/drain.log 2>&1`
5. Check: `/opt/drain/run.sh` prints `routing refreshed: N brand(s)` and `[routing] per-brand routing active for N brand key(s)`.

Set `NODE=/path/to/node` in the crontab line when cron's `PATH` has no `node`.

## hstgr Docker (`/app`, `/data`)

1. Copy `refresh-routing.mjs`, `routing-env.mjs`, `spend-sync.mjs` and `scheduler.mjs` into `/app` beside `drain.mjs`.
2. Mount a volume at `/data` so `routing.json` survives restarts.
3. Container command: `node /app/scheduler.mjs`. Health check: `/tmp/heartbeat` younger than 15 minutes.
4. Pass `FORM_BASE_URL` and `DRAIN_TOKEN` as container env, never baked into the image.
