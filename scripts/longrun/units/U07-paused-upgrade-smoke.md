---
id: U07
title: fix(factory): handle smoke checks for paused brands during upgrade
branch: fus-345-paused-upgrade-smoke
lane: factory
deps: U06
builder: codex
reviewers: deepseek
paths: workers/factory/
merge: auto
---
## Goal
Deferred P2 from PR #40: "paused-upgrade smoke handling". A paused brand serves the 503 pause page, so the normal smoke check fails during upgrade-all.

## Do
1. Read `workers/factory/src/workflows/upgrade-all.ts` and the smoke step.
2. For a paused brand, smoke expects the pause page (503, no "anjuna" or "aurum" bytes) and the brand stays paused after the upgrade.
3. Test: upgrade-all with one paused brand completes, the brand stays paused, and smoke passes.

## Acceptance
- Paused brands no longer fail upgrade smoke, and they stay paused.
- `bun run typecheck` and `bun run test` green.
