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

MAX_RETRIES=${SMOKE_DNS_RETRIES:-5}
RETRY_DELAY=${SMOKE_DNS_RETRY_DELAY:-15}
ATTEMPT=0
RESP=""
while true; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  CURL_RC=0
  # Do not follow redirects, including when a configured token is rejected.
  RESP=$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
    "${HEADERS[@]}" --output "$PAGE" --write-out '%{http_code} %{redirect_url}' "$URL") || CURL_RC=$?
  if [[ "$CURL_RC" -eq 6 ]]; then
    if [[ "$ATTEMPT" -ge "$MAX_RETRIES" ]]; then
      echo "web smoke failed: DNS resolution failed for $URL after $MAX_RETRIES attempts (curl exit 6)"
      exit 1
    fi
    echo "web smoke: DNS not ready for $URL (curl exit 6), retry $ATTEMPT/$MAX_RETRIES in ${RETRY_DELAY}s"
    sleep "$RETRY_DELAY"
    continue
  elif [[ "$CURL_RC" -ne 0 ]]; then
    echo "web smoke failed: curl error $CURL_RC for $URL"
    exit 1
  fi
  break
done
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
