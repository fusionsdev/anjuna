#!/usr/bin/env bash
# Read-only code review by a second vendor. Usage: review.sh <deepseek|grok> <diff> <card> <worktree>
# Prints the review. First line is "VERDICT: APPROVE", "VERDICT: REQUEST_CHANGES" or "VERDICT: BLOCKER".
set -uo pipefail
who=$1 diff=$2 card=$3 wt=$4
DEEPSEEK_MODEL=${LONGRUN_DEEPSEEK_MODEL:-siliconflow/deepseek-ai/DeepSeek-V4-Pro-0813}

brief=$(mktemp)
cat >"$brief" <<EOF
No mannered prose. Answer first, short sentences, numbers and names, end on the result.

You review one pull request in the Anjuna repo (Cloudflare lead-gen platform). You are read-only.
Inputs: the unit card (goal and acceptance) at $card, the diff at $diff, and the repo at $wt.
Repo hard rules (AGENTS.md): V1 parity, LeadsGate prepop redirect only (no server post, no LEADSGATE_ENDPOINT),
no cloaking (nothing varies by UA, IP, referrer, gclid), brand bytes never contain "anjuna", "aurum", a PostHog key or a Sentry DSN,
D1 for data, no secrets in git, no deploys.

Check: does the diff meet every acceptance line of the card? Correctness bugs, money-path bugs (lead submit, postback,
conversion upload, install/rollback), security, rule violations, tests that do not test the claim.
Ignore style nits unless they hide a bug.

Output format, exactly:
Line 1: VERDICT: APPROVE | VERDICT: REQUEST_CHANGES | VERDICT: BLOCKER
Then one finding per line: <file>:<line> <severity nit|bug|blocker> <what is wrong and the fix>.
APPROVE only when no bug or blocker remains.
EOF

case "$who" in
  deepseek)
    # opencode refuses reads outside its working directory, so it runs inside the worktree.
    ( cd "$wt" && opencode run -m "$DEEPSEEK_MODEL" --agent plan -f "$brief" -f "$card" -f "$diff" -- \
      "Follow the instructions in the first attached file exactly and reply only with the review." ) \
      2>"${REVIEW_ERR:-/dev/null}" | sed 's/\x1b\[[0-9;]*m//g' ;;
  grok)
    grok -p "$(cat "$brief")" --cwd "$wt" --permission-mode plan 2>"${REVIEW_ERR:-/dev/null}" | sed 's/\x1b\[[0-9;]*m//g' ;;
  *) echo "VERDICT: REQUEST_CHANGES"; echo "review.sh: unknown reviewer $who" ;;
esac
rm -f "$brief"
