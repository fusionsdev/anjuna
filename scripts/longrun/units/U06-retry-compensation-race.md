---
id: U06
title: fix(factory): close the retry and compensation race
branch: fus-345-retry-compensation-race
lane: factory
deps: U05
builder: codex
reviewers: deepseek
paths: workers/factory/ apps/web/src/server/ apps/web/test/
merge: owner
---
## Goal
Deferred P2 from PR #40: "Retry/compensation race and recovery ergonomics; pre-existing failed-receipt retry behavior." A Retry pressed while compensation is still running must not start a second workflow or skip compensation.

## Do
1. Read the retry path in `apps/web/src/server/lifecycle.ts` and `workers/factory/src/workflows/*`.
2. Make Retry refuse with 409 while the install's compensation is unfinished. Make a failed-receipt retry resume from the failed step only.
3. Add tests for both, including two concurrent Retry calls.

## Acceptance
- Retry during compensation returns 409 and creates nothing.
- A failed-receipt retry resumes at the failed step.
- `bun run typecheck` and `bun run test` green.
