#!/usr/bin/env bash
# Anjuna long-run supervisor. Runs unit cards (scripts/longrun/units/*.md) one branch and one PR each.
# The owner starts it in their own terminal from the main clone:
#   bash scripts/longrun/longrun.sh [--parallel N] [--only U01,U02] [--dry-run]
# Agents run with Cloudflare, GitHub and git-push credentials blanked (agent_env).
# Only this script pushes, opens PRs, merges, and reads production D1 (through d1-read.sh).
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
HERE="$ROOT/scripts/longrun"
UNITS="$HERE/units"
LR="$ROOT/longrun"
STATE="$LR/state"
LOG="$LR/log.jsonl"
OWNER="$LR/OWNER_NEEDED.md"
WT_BASE=${LONGRUN_WT_BASE:-$(dirname "$ROOT")/anjuna-lr}
CODEX_MODEL=${LONGRUN_CODEX_MODEL:-gpt-6-astra}
BUILD_TIMEOUT=${LONGRUN_BUILD_TIMEOUT:-2400}
REVIEW_TIMEOUT=${LONGRUN_REVIEW_TIMEOUT:-900}
CI_TIMEOUT=${LONGRUN_CI_TIMEOUT:-1800}
MAX_ROUNDS=3
PARALLEL=1
ONLY=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --parallel) PARALLEL=$2; shift 2 ;;
    --only) ONLY=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$STATE" "$LR/input" "$LR/prompts" "$LR/out" "$WT_BASE"
touch "$LOG" "$OWNER"
# One supervisor at a time: a second start would reset the locks and claim the same units.
if [ -f "$LR/supervisor.pid" ] && kill -0 "$(cat "$LR/supervisor.pid")" 2>/dev/null; then
  echo "another supervisor is running (pid $(cat "$LR/supervisor.pid")); stop it first" >&2; exit 75
fi
echo $$ >"$LR/supervisor.pid"
trap 'rm -f "$LR/supervisor.pid"' EXIT
# A previous run that was killed leaves locks and "running" units behind.
rmdir "$STATE"/*.lock 2>/dev/null
for s in "$STATE"/*.status; do [ -f "$s" ] && grep -qx running "$s" && echo todo >"$s"; done

# ---------- helpers ----------

json_str() { printf '%s' "$1" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))'; }

log() { # unit event detail
  printf '{"ts":"%s","unit":"%s","event":"%s","detail":%s}\n' \
    "$(date -u +%FT%TZ)" "$1" "$2" "$(json_str "${3:-}")" >>"$LOG"
  printf '[%s] %-4s %-14s %s\n' "$(date +%T)" "$1" "$2" "${3:-}" | cut -c1-200
}

owner() { # unit reason
  printf -- '- [ ] %s %s: %s\n' "$(date '+%F %R')" "$1" "$2" >>"$OWNER"
}

card_file() { ls "$UNITS/$1"-*.md 2>/dev/null | head -1; }
card_get() { # unit key -> value from frontmatter
  awk -v k="$2" 'NR==1&&/^---/{f=1;next} f&&/^---/{exit} f{ i=index($0,":"); if(substr($0,1,i-1)==k){v=substr($0,i+1); sub(/^ +/,"",v); print v; exit} }' "$(card_file "$1")"
}
card_body() { awk 'NR==1&&/^---/{f=1;next} f==1&&/^---/{f=2;next} f==2' "$(card_file "$1")"; }

status_get() { cat "$STATE/$1.status" 2>/dev/null || echo todo; }
status_set() { echo "$2" >"$STATE/$1.status"; }

all_units() {
  for f in "$UNITS"/U*.md; do basename "$f" | cut -d- -f1; done | sort
}

# Agents never see working credentials.
agent_env() {
  env CLOUDFLARE_API_TOKEN=longrun-blocked CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 \
      GH_TOKEN=longrun-blocked GITHUB_TOKEN=longrun-blocked \
      GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
      JEV_API_KEY= "$@"
}

deps_merged() {
  local d s
  for d in $(card_get "$1" deps | tr ',' ' '); do
    s=$(status_get "$d")
    if [ "$s" = ready-for-owner ] && [ "$(gh pr view "$(card_get "$d" branch)" --json state -q .state 2>/dev/null)" = MERGED ]; then
      status_set "$d" merged; s=merged
    fi
    [ "$s" = merged ] || [ "$s" = reported ] || [ "$s" = dry ] || return 1
  done
}

claim() { # unit -> 0 if claimed
  local u=$1 lane
  lane=$(card_get "$u" lane)
  mkdir "$STATE/$u.lock" 2>/dev/null || return 1
  if ! mkdir "$STATE/lane-$lane.lock" 2>/dev/null; then rmdir "$STATE/$u.lock"; return 1; fi
  [ "$(status_get "$u")" = todo ] || { release "$u"; return 1; }
  status_set "$u" running
}
release() { rmdir "$STATE/$1.lock" "$STATE/lane-$(card_get "$1" lane).lock" 2>/dev/null; true; }

selected() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

# ---------- gates ----------

gate_a() { # wt unit -> 0 pass; reasons on stdout
  local wt=$1 u=$2 paths f p ok bad=0
  paths=$(card_get "$u" paths)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    ok=0
    for p in $paths; do [[ "$f" == "$p"* ]] && ok=1; done
    [ $ok = 1 ] || { echo "path not allowed by card: $f"; bad=1; }
    [[ "$f" == *.dev.vars* || "$f" == *.env ]] && { echo "secret file added: $f"; bad=1; }
  done < <(git -C "$wt" diff --name-only origin/main...HEAD)
  if git -C "$wt" diff origin/main...HEAD -U0 | grep -E '^\+' | grep -v '^+++' \
     | grep -Eiq 'LEADSGATE_ENDPOINT|jv_live_|(token|secret|api[_-]?key|password|bearer)["'"'"' :=]+[A-Za-z0-9_-]{32,}'; then
    echo "banned string or token-shaped value in added lines"; bad=1
  fi
  [ $bad = 0 ] || return 1
  ( cd "$wt" && bun run typecheck >"$LR/out/$u.typecheck.log" 2>&1 ) || { echo "typecheck failed"; tail -60 "$LR/out/$u.typecheck.log"; return 1; }
  ( cd "$wt" && bun run test >"$LR/out/$u.test.log" 2>&1 ) || { echo "tests failed"; tail -80 "$LR/out/$u.test.log"; return 1; }
}

review() { # unit wt -> sets REVIEW_FILE, returns 0 if every reviewer approves
  local u=$1 wt=$2 r out decision attempt
  REVIEW_TOOL_FAILED=0
  git -C "$wt" diff origin/main...HEAD >"$LR/out/$u.diff"
  REVIEW_FILE="$LR/out/$u.review.txt"; : >"$REVIEW_FILE"
  for r in $(card_get "$u" reviewers | tr ',' ' '); do
    [ "$r" = none ] && continue
    out="$LR/out/$u.review.$r.txt"
    # A review without a VERDICT line is a tool failure: retry once, then stop without burning builder rounds.
    for attempt in 1 2; do
      REVIEW_ERR="$out.err" timeout "$REVIEW_TIMEOUT" bash "$HERE/review.sh" "$r" "$LR/out/$u.diff" "$(card_file "$u")" "$wt" >"$out"
      grep -q 'VERDICT:' "$out" && break
    done
    if ! grep -q 'VERDICT:' "$out"; then
      log "$u" "review:$r" "no verdict (tool failure), see $out.err"
      REVIEW_TOOL_FAILED=1; return 1
    fi
    { echo "### reviewer: $r"; cat "$out"; echo; } >>"$REVIEW_FILE"
    decision=$(bun "$HERE/jev.mjs" review "$out")
    log "$u" "review:$r" "$decision"
    [[ "$decision" == approve* ]] || return 1
  done
  return 0
}

# ---------- builders ----------

build() { # unit wt round feedback_file
  local u=$1 wt=$2 round=$3 fb=$4 builder prompt
  builder=$(card_get "$u" builder)
  [ "$round" -ge 3 ] && builder=relay
  if [ "$round" = 2 ] && [ -s "$fb" ] && [ "$(bun "$HERE/jev.mjs" escalate "$fb")" = yes ]; then builder=relay; fi
  prompt="$LR/prompts/$u.r$round.md"
  {
    echo "No mannered prose. Answer first, short sentences, numbers and names, end on the result."
    echo
    echo "You are the builder for unit $u in the Anjuna repo. Work only inside this directory: $wt"
    echo "Read AGENTS.md first and follow its hard rules. Stay inside the allowed paths: $(card_get "$u" paths)"
    echo "Do not push, tag, deploy, merge or call Cloudflare, LeadsGate or any VPS. Credentials are disabled on purpose."
    echo "Stay on the current branch in this directory. Never run git worktree, git clean, git switch, git checkout of another branch, or create branches. Other units share this git repository."
    echo "Do not leave log files or scratch files in the repo."
    echo "Commit your work on the current branch with a conventional commit message. Run bun run typecheck and bun run test before you finish."
    [ -s "$LR/input/$u.txt" ] && echo "Production query results for this unit (read-only, already fetched): $LR/input/$u.txt"
    echo
    card_body "$u"
    if [ -s "$fb" ]; then echo; echo "## Fix round $round: address this feedback"; cat "$fb"; fi
  } >"$prompt"
  log "$u" "build:r$round" "$builder"
  case "$builder" in
    codex)
      agent_env timeout "$BUILD_TIMEOUT" codex exec -m "$CODEX_MODEL" -s danger-full-access --skip-git-repo-check -C "$wt" - \
        <"$prompt" >"$LR/out/$u.r$round.build.log" 2>&1 ;;
    relay)
      # Plain Opus in this worktree. The relay skill creates its own worktrees and branches, which broke the shared repo.
      ( cd "$wt" && agent_env timeout "$BUILD_TIMEOUT" claude -p "$(cat "$prompt")" --model opus \
        --permission-mode bypassPermissions >"$LR/out/$u.r$round.build.log" 2>&1 ) ;;
    *) echo "unknown builder $builder" >"$LR/out/$u.r$round.build.log"; return 1 ;;
  esac
}

# Oracle workflow: one verified learning per finished unit, one handoff per run.
# Claude Haiku calls the oracle-brain MCP; failures only log, they never stop the loop.
oracle() { # unit kind(learn|handoff) text
  [ "${LONGRUN_ORACLE:-1}" = 1 ] || return 0
  local p="$LR/prompts/oracle.$1.$2.md"
  {
    echo "No mannered prose. Answer first, short sentences, numbers and names, end on the result."
    echo "Follow the oracle-workflow skill (C:/Users/Barbara/.agents/skills/oracle-workflow/SKILL.md)."
    echo "Project: anjuna | github.com/fusionsdev/anjuna | branch main. ORACLE_PROJECT_TAG: github.com/fusionsdev/anjuna."
    if [ "$2" = learn ]; then
      echo "Search Oracle for this fact first (oracle_search, limit 5, offset 0, type learning, mode hybrid, retrieval compact-summary)."
      echo "If it is new, record it with oracle_learn (one fact, concepts include anjuna and $1). If an older record now conflicts, oracle_learn then oracle_supersede."
      echo "Never store tokens or secrets. Fact:"
    else
      echo "Run the /oracle-handoff contract from references/command-behavior.md and write the handoff with oracle_handoff, slug anjuna-longrun-$(date +%Y%m%d)."
      echo "Use only these facts; mark anything else UNKNOWN or NOT_CHECKED:"
    fi
    echo "$3"
  } >"$p"
  ( cd "$ROOT" && timeout 600 claude -p "$(cat "$p")" --model haiku --permission-mode bypassPermissions \
      >"$LR/out/oracle.$1.$2.log" 2>&1 ) || log "$1" oracle-fail "$2"
}

park() { # unit reason owner_note
  log "$1" park "$2"
  owner "$1" "${3:-$2}"
  status_set "$1" parked
  oracle "$1" learn "Anjuna long-run unit $1 ($(card_get "$1" title)) PARKED on $(date +%F): $2. Not merged."
  release "$1"
}

# ---------- one unit ----------

run_unit() {
  local u=$1 branch wt fb round q rc pr db sql line acct run
  branch=$(card_get "$u" branch)
  wt="$WT_BASE/$u"
  log "$u" start "$(card_get "$u" title)"
  if [ $DRY = 1 ]; then log "$u" dry-run "$branch builder=$(card_get "$u" builder) deps=$(card_get "$u" deps)"; status_set "$u" dry; release "$u"; return; fi

  # Production reads happen here, never inside an agent. Format per line: <database>[@<account_id>]|<SELECT ...>
  q="$UNITS/$u.sql"
  if [ -f "$q" ]; then
    : >"$LR/input/$u.txt"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      db=${line%%|*}; sql=${line#*|}
      acct=""; [[ "$db" == *@* ]] && { acct=${db#*@}; db=${db%@*}; }
      echo "## $db: $sql" >>"$LR/input/$u.txt"
      if ! ANJUNA_CF_ACCOUNT=${acct:-6cb8500c35210800451bd9a535482850} bash "$HERE/d1-read.sh" "$db" "$sql" >>"$LR/input/$u.txt" 2>&1; then
        echo "QUERY FAILED (see output above)" >>"$LR/input/$u.txt"
        log "$u" query-fail "$db"
        owner "$u" "production read failed on $db (wrangler login lacks access?), see longrun/input/$u.txt"
      fi
      echo >>"$LR/input/$u.txt"
    done < <(grep -v '^#' "$q")
  fi

  if [ "$(card_get "$u" builder)" = none ]; then
    owner "$u" "report ready: longrun/input/$u.txt"
    log "$u" reported "longrun/input/$u.txt"; status_set "$u" reported; release "$u"; return
  fi

  git -C "$ROOT" fetch -q origin main
  # A directory without a .git file is a broken worktree; rebuild it from the branch.
  if [ -d "$wt" ] && [ ! -e "$wt/.git" ]; then rm -rf "$wt"; git -C "$ROOT" worktree prune; fi
  if [ ! -d "$wt" ]; then
    # Reuse an existing branch so earlier rounds' commits survive a restart. -B would reset it to origin/main.
    if git -C "$ROOT" show-ref -q --verify "refs/heads/$branch"; then
      git -C "$ROOT" worktree add -q "$wt" "$branch" || { park "$u" "worktree add failed"; return; }
    else
      git -C "$ROOT" worktree add -q "$wt" -b "$branch" origin/main || { park "$u" "worktree add failed"; return; }
    fi
  fi
  ( cd "$wt" && bun install --frozen-lockfile >"$LR/out/$u.install.log" 2>&1 )

  fb="$LR/out/$u.feedback.txt"; : >"$fb"
  for round in $(seq 1 $MAX_ROUNDS); do
    build "$u" "$wt" "$round" "$fb"; rc=$?
    if [ $rc -ne 0 ]; then
      tail -80 "$LR/out/$u.r$round.build.log" >"$fb"
      case "$(bun "$HERE/jev.mjs" failure "$fb")" in
        rate_limit) log "$u" wait "rate limit, sleeping 600s"; sleep 600; continue ;;
        needs_owner) park "$u" "builder needs owner input" "builder needs owner input, see longrun/out/$u.r$round.build.log"; return ;;
      esac
    fi
    # Commit only the card's paths. Tool noise (turbo's AGENTS.md block, .serena, *.log) never lands.
    git -C "$wt" checkout -q -- AGENTS.md 2>/dev/null
    git -C "$wt" reset -q
    git -C "$wt" add -A -- $(card_get "$u" paths) ':(exclude,glob)**/*.log'
    git -C "$wt" diff --cached --quiet || git -C "$wt" commit -qm "$(card_get "$u" title)"
    if git -C "$wt" diff --quiet origin/main...HEAD; then echo "No changes were committed." >"$fb"; continue; fi
    if ! gate_a "$wt" "$u" >"$fb" 2>&1; then
      log "$u" gate-a-fail "$(head -1 "$fb")"
      if [ "$(bun "$HERE/jev.mjs" failure "$fb")" = flaky_test ] && gate_a "$wt" "$u" >"$fb" 2>&1; then
        : >"$fb"
      else
        continue
      fi
    fi
    if review "$u" "$wt"; then : >"$fb"; break; fi
    if [ "$REVIEW_TOOL_FAILED" = 1 ]; then
      park "$u" "review tool failed" "reviewer returned no verdict, see longrun/out/$u.review.*.err (code is committed in $wt)"
      return
    fi
    cp "$REVIEW_FILE" "$fb"
  done

  if [ -s "$fb" ]; then
    park "$u" "rounds exhausted: $(head -1 "$fb")" "parked after $MAX_ROUNDS rounds, see longrun/out/$u.feedback.txt (worktree $wt)"
    return
  fi

  git -C "$wt" push -q -u origin "$branch" --force-with-lease || { park "$u" "push failed"; return; }
  {
    echo "Long-run unit **$u**: $(card_get "$u" title)"
    echo
    card_body "$u" | awk '/^## Acceptance/{f=1;print;next} f&&/^## /{exit} f'
    echo
    echo "### Gates"
    echo "- typecheck and test green locally; allowed paths and banned strings checked"
    echo "- reviewers: $(card_get "$u" reviewers)"
    echo
    echo "<details><summary>Review output</summary>"
    echo
    head -150 "${REVIEW_FILE:-/dev/null}" 2>/dev/null
    echo
    echo "</details>"
    echo
    echo "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  } >"$LR/out/$u.pr.md"
  pr=$(gh pr view "$branch" --json number -q .number 2>/dev/null) \
    || pr=$(gh pr create --base main --head "$branch" --title "$(card_get "$u" title)" --body-file "$LR/out/$u.pr.md" | grep -oE '[0-9]+$')
  log "$u" pr "#$pr"
  sleep 30
  if ! timeout "$CI_TIMEOUT" gh pr checks "$pr" --watch --fail-fast >"$LR/out/$u.ci.log" 2>&1; then
    # apps/web lifecycle.ui.test.tsx is flaky on CI; rerun failed jobs once before parking.
    run=$(gh pr checks "$pr" --json link -q '.[].link' 2>/dev/null | grep -oE 'runs/[0-9]+' | head -1 | cut -d/ -f2)
    [ -n "$run" ] && gh run rerun "$run" --failed >/dev/null 2>&1 && sleep 30 && log "$u" ci-rerun "#$pr run $run"
  fi
  if ! timeout "$CI_TIMEOUT" gh pr checks "$pr" --watch --fail-fast >>"$LR/out/$u.ci.log" 2>&1; then
    park "$u" "CI not green on #$pr" "PR #$pr CI not green, see longrun/out/$u.ci.log"
    return
  fi
  if [ "$(card_get "$u" merge)" = owner ]; then
    owner "$u" "PR #$pr green and reviewed, owner merges"
    log "$u" ready "#$pr"; status_set "$u" ready-for-owner
    oracle "$u" learn "Anjuna long-run unit $u: PR #$pr green and reviewed on $(date +%F), waiting for owner merge (money path): $(card_get "$u" title)."
    release "$u"; return
  fi
  # --delete-branch would try to switch the main clone to main locally; delete the remote branch separately.
  gh pr merge "$pr" --squash >>"$LR/out/$u.ci.log" 2>&1
  [ "$(gh pr view "$pr" --json state -q .state)" = MERGED ] || { park "$u" "merge failed #$pr"; return; }
  git -C "$ROOT" push -q origin --delete "$branch" 2>/dev/null
  log "$u" merged "#$pr"
  status_set "$u" merged
  oracle "$u" learn "Anjuna long-run unit $u merged on $(date +%F) as PR #$pr: $(card_get "$u" title). Acceptance: $(card_body "$u" | awk '/^## Acceptance/{f=1;next} f' | tr '
' ' ')"
  git -C "$ROOT" worktree remove --force "$wt" 2>/dev/null
  release "$u"
}

# ---------- scheduler ----------

next_ready() {
  local u
  for u in $(all_units); do
    selected "$u" || continue
    [ "$(status_get "$u")" = todo ] || continue
    deps_merged "$u" || continue
    claim "$u" && { echo "$u"; return 0; }
  done
  return 1
}

any_running() { ls "$STATE"/*.lock >/dev/null 2>&1; }

worker() {
  local u
  while true; do
    if u=$(next_ready); then run_unit "$u"; continue; fi
    any_running || return 0
    sleep 60
  done
}

log - start "parallel=$PARALLEL only=${ONLY:-all} dry=$DRY"
for i in $(seq 1 "$PARALLEL"); do worker & sleep 5; done
wait
SUMMARY=$(for u in $(all_units); do printf '%s=%s ' "$u" "$(status_get "$u")"; done)
[ $DRY = 1 ] || oracle run handoff "Long run finished $(date '+%F %R'). Unit status: $SUMMARY. Owner queue: $(grep -c '^- \[ \]' "$OWNER") open items in longrun/OWNER_NEEDED.md. Log: longrun/log.jsonl. NEXT session starts with /oracle-resume, then reads longrun/OWNER_NEEDED.md."
log - finish "$(for u in $(all_units); do printf '%s=%s ' "$u" "$(status_get "$u")"; done)"
