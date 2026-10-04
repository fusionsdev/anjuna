#!/usr/bin/env bash
set -euo pipefail

URL=${1:?Usage: bash scripts/smoke-web.sh URL ARTIFACT}
ARTIFACT=${2:?Expected release HTML artifact path}
test -f "$ARTIFACT" || { echo 'web smoke failed: release artifact missing'; exit 1; }

# Owner provisions both tenant-specific secrets and an Access Service Auth policy.
# Until then, anonymous mode proves only Access reachability on a 302.
HEADERS=()
MODE=anonymous-fallback
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  MODE=authenticated
  HEADERS=(--header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
           --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  echo 'web smoke mode: authenticated (Access service token)'
else
  echo 'web smoke mode: anonymous-fallback (Access token missing or incomplete; 302 does not verify release HTML)'
fi

PAGE=$(mktemp)
trap 'rm -f "$PAGE"' EXIT
# Do not follow redirects, including when a configured token is rejected.
RESP=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
  "${HEADERS[@]}" --output "$PAGE" --write-out '%{http_code} %{redirect_url}' "$URL")
STATUS=${RESP%% *}
LOCATION=${RESP#* }
if [[ "$STATUS" == 200 ]]; then
  cmp --silent "$ARTIFACT" "$PAGE" || {
    echo 'web smoke failed: response does not match the deployed SPA build'; exit 1;
  }
  echo "web smoke ok: $MODE, HTTP 200, release HTML matches"
elif [[ "$MODE" == anonymous-fallback && "$STATUS" == 302 &&
        "$LOCATION" =~ ^https://[a-zA-Z0-9-]+\.cloudflareaccess\.com/ ]]; then
  echo 'web smoke ok: anonymous-fallback, HTTP 302 to Cloudflare Access (release HTML unverified)'
else
  echo "web smoke failed: $MODE, HTTP $STATUS"
  exit 1
fi
