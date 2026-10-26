#!/bin/sh
# Cron entry for the maimax VPS layout (/opt/drain holds .env, drain.mjs, refresh-routing.mjs):
#   */10 * * * * /opt/drain/run.sh >> /opt/drain/drain.log 2>&1
# Refreshes routing.json from core, then runs the unchanged drain.mjs with it as BRAND_ROUTING_JSON.
# A failed refresh keeps the previous routing.json. With no routing.json, or an empty map, the .env value applies.
# After the drain, spend-sync.mjs copies ad spend into core once an hour (FUS-368), when it is present.
set -u
cd "$(dirname "$0")" || exit 1

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

NODE="${NODE:-node}"
"$NODE" refresh-routing.mjs routing.json || echo "[run] routing refresh failed; keeping the previous routing.json" >&2

# conversion-sync.mjs (FUS-384) creates missing conversion actions; refresh again so routing sees them.
if [ -f conversion-sync.mjs ]; then
  if "$NODE" conversion-sync.mjs; then
    "$NODE" refresh-routing.mjs routing.json || echo "[run] routing refresh failed; keeping the previous routing.json" >&2
  else
    echo "[run] conversion sync failed" >&2
  fi
fi

# Export only a map with at least 1 key: an empty map would make drain.mjs skip every row.
if ROUTING="$("$NODE" routing-env.mjs routing.json)"; then
  BRAND_ROUTING_JSON="$ROUTING"
  export BRAND_ROUTING_JSON
fi

"$NODE" drain.mjs
DRAIN_EXIT=$?

# Hourly: run when spend-sync.stamp is missing or older than 55 minutes, so a */10 cron runs it once
# an hour. The stamp is touched first: a failed sync waits for the next hour instead of every tick.
if [ -f spend-sync.mjs ] && [ -z "$(find spend-sync.stamp -mmin -55 2>/dev/null)" ]; then
  touch spend-sync.stamp
  "$NODE" spend-sync.mjs || echo "[run] spend sync failed; next try in an hour" >&2
fi

exit "$DRAIN_EXIT"
