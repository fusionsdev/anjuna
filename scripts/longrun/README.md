# Long-run supervisor

Runs the unit cards in `units/` unattended. Each card is one branch, one PR. The loop never waits for a human. A unit that needs the owner is parked in `longrun/OWNER_NEEDED.md`, and the loop moves on.

## Start

From the main clone, in Git Bash, with `JEV_API_KEY` set (optional) and wrangler and gh logged in:

```bash
bash scripts/longrun/longrun.sh --dry-run
bash scripts/longrun/longrun.sh --parallel 2
bash scripts/longrun/longrun.sh --only U01,U03
```

New session afterwards: run `/oracle-resume`, then read `longrun/OWNER_NEEDED.md` and `longrun/log.jsonl`.

## Loop per unit

1. Supervisor runs the unit's `Uxx.sql` reads through `d1-read.sh` and saves them in `longrun/input/` (outside every worktree).
2. A worktree is created from `origin/main` under `../anjuna-lr/<unit>`.
3. Builder: Codex `gpt-6-astra`. Round 2 may escalate to Claude relay (Opus) when Jev says the fix needs design judgment. Round 3 always uses relay.
4. Gate A (script): allowed paths, no secret files, no token-shaped strings or `LEADSGATE_ENDPOINT`, `bun run typecheck`, `bun run test`.
5. Review: opencode DeepSeek V4 Pro (read-only plan agent). Money-path cards add Grok in plan mode. Approval needs the reviewer's `VERDICT: APPROVE` line and Jev's `approve` with severity ≤ 1.
6. Push, PR, wait for CI. `merge: auto` cards are squash-merged. `merge: owner` cards wait for the owner.
7. Oracle: each merged, parked or owner-ready unit records one learning. The run ends with an Oracle handoff.

## Guardrails

- Agents run with `CLOUDFLARE_API_TOKEN`, `GH_TOKEN` and the git credential helper blanked. They cannot deploy, push, open PRs or read production.
- `d1-read.sh` accepts one SELECT or WITH statement. It refuses writes, `SELECT *` and PII columns.
- Nothing in the loop tags a release, runs `wrangler deploy`, or touches the panel's Rollback, Delete, Upgrade-all or Test sold.
- Deploys stay an owner action: push a `v*` tag after reviewing merged units.

## Card format

```
---
id: U01
title: <conventional commit title>
branch: <branch>
lane: <units in one lane run one at a time>
deps: U02,U03          (must be merged or reported first)
builder: codex | relay | none
reviewers: deepseek | deepseek,grok | none
paths: <allowed path prefixes, space separated>
merge: auto | owner
---
## Goal / ## Do / ## Acceptance
```

`Uxx.sql`: one `<database>[@<account_id>]|<SELECT>` per line.
