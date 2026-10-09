---
id: U08
title: feat(web): show upgrade-all outcome per brand
branch: fus-347-upgrade-outcome
lane: web
deps: U02
builder: codex
reviewers: deepseek
paths: apps/web/ packages/contracts/
merge: auto
---
## Goal
Deferred P2 from PR #40: "upgrade outcome visibility" and "silent core-list failures". Operators cannot see which brands an upgrade-all updated, skipped or failed.

## Do
1. Show each brand's outcome for the latest upgrade-all (canary, ready, failed, rolled back, skipped) from the existing install rows.
2. Show a core-list fetch failure as a visible error instead of an empty list.
3. Add UI and API tests.

## Acceptance
- The panel lists each brand's outcome for the latest upgrade-all.
- A core-list failure shows an error message.
- `bun run typecheck` and `bun run test` green.
