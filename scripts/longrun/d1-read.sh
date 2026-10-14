#!/usr/bin/env bash
# SELECT-only wrapper for production D1. Usage: d1-read.sh <database> "<SELECT ...>"
# Refuses anything that is not a single read statement or that names PII columns.
set -euo pipefail
db=${1:?database}
sql=${2:?sql}
norm=$(printf '%s' "$sql" | tr -s '[:space:]' ' ' | sed -E 's/^ +//; s/[; ]+$//')
upper=$(printf '%s' "$norm" | tr '[:lower:]' '[:upper:]')

die() { echo "d1-read refused: $1" >&2; exit 2; }
[[ "$upper" == SELECT\ * || "$upper" == WITH\ * ]] || die "not a SELECT"
[[ "$norm" == *";"* ]] && die "more than one statement"
for w in INSERT UPDATE DELETE DROP ALTER CREATE REPLACE PRAGMA ATTACH DETACH VACUUM REINDEX; do
  [[ " $upper " =~ [^A-Z_]${w}[^A-Z_] ]] && die "contains $w"
done
lower=$(printf '%s' "$norm" | tr '[:upper:]' '[:lower:]')
for c in email phone first_name last_name address street dob ssn user_agent; do
  [[ "$lower" == *"$c"* ]] && die "names PII column ($c)"
done
[[ "$lower" =~ (select|,)[[:space:]]*\*|\.\* ]] && die "SELECT * may return PII columns"

# wrangler 4.124.0 reads and refreshes the OAuth token file with no lock (wrangler-dist/cli.js, writeFileSync in the
# file storage write()), so a call can send no valid token and get "Authentication error [code: 10000]" once.
# The statement is a single SELECT, so one retry after a short delay is safe. Any other failure is returned as is.
out=$(mktemp) err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT
run() {
  CLOUDFLARE_ACCOUNT_ID=${ANJUNA_CF_ACCOUNT:-6cb8500c35210800451bd9a535482850} \
    bunx wrangler d1 execute "$db" --remote --json --command "$norm" >"$out" 2>"$err"
}
rc=0
run || rc=$?
if [[ $rc -ne 0 ]] && grep -q 'code: 10000' "$out" "$err"; then
  echo "d1-read: auth error 10000, retrying once in ${D1_READ_RETRY_DELAY:-3}s" >&2
  sleep "${D1_READ_RETRY_DELAY:-3}"
  rc=0
  run || rc=$?
fi
cat "$out"
cat "$err" >&2
exit "$rc"
