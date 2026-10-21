#!/bin/sh
# Cron entry for the maimax VPS layout (/opt/drain holds .env, drain.mjs, refresh-routing.mjs):
#   */10 * * * * /opt/drain/run.sh >> /opt/drain/drain.log 2>&1
# Refreshes routing.json from core, then runs the unchanged drain.mjs with it as BRAND_ROUTING_JSON.
# A failed refresh keeps the previous routing.json. With no routing.json, or an empty map, the .env value applies.
set -u
cd "$(dirname "$0")" || exit 1

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

NODE="${NODE:-node}"
"$NODE" refresh-routing.mjs routing.json || echo "[run] routing refresh failed; keeping the previous routing.json" >&2

# Export only a map with at least 1 key: an empty map would make drain.mjs skip every row.
if ROUTING="$("$NODE" routing-env.mjs routing.json)"; then
  BRAND_ROUTING_JSON="$ROUTING"
  export BRAND_ROUTING_JSON
fi

exec "$NODE" drain.mjs
