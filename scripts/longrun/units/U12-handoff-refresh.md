---
id: U12
title: docs: refresh HANDOFF to the state after the long run
branch: docs/handoff-5
lane: docs
deps: U01,U03,U04
builder: codex
reviewers: none
paths: docs/HANDOFF.md docs/TASKS.md
merge: auto
---
## Goal
`docs/HANDOFF.md` is dated 2026-10-02 and says T10 is not needed. PR #42 tried to refresh it and is stale itself. Cloud sessions cannot reach Oracle, so this file is their only source.

## Do
1. Rewrite `docs/HANDOFF.md` from `git log origin/main`, `docs/runbooks/gates/evidence-*.md` and `H:/w/t12a/anjuna/longrun/log.jsonl` (read-only).
2. Include the live systems and versions, each T-task's status with evidence links, the open owner items (G2 drain, G3 account B, token rotation, T16 approval, release tag), and how to run `scripts/longrun/longrun.sh`.
3. Add a status note to `docs/TASKS.md` only if it stays short.

## Acceptance
- HANDOFF matches main and the evidence files. Every claim has a link.
- HANDOFF says PR #42 is superseded.
