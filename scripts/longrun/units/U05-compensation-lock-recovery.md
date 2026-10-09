---
id: U05
title: fix(factory): let an owner recover a lock retained after failed compensation
branch: fus-345-compensation-lock-recovery
lane: factory
deps: U04
builder: codex
reviewers: deepseek,grok
paths: workers/factory/ apps/web/ packages/contracts/ packages/factory-db/
merge: owner
---
## Goal
PR #63 proposed "product support for explicitly recovering a retained lock after failed compensation; current retry cannot claim it." On 2026-10-08 levellendings.com needed manual recovery after a failed compensation. Employees must not get stuck like that.

## Do
1. Read `workers/factory/src/workflows/install.ts`, `rollback.ts` and the lock or claim logic. Read the commits of PR #63 with `git log --grep "detach"`.
2. Add an Owner-only Recover action. It checks that the install failed with compensation failed, re-runs compensation idempotently (detach domains, restore the previous version), then releases the lock and records receipts and audit.
3. Tests: a retained lock is recovered, the brand is back to its previous state, the lock is free and a new Install can claim it; an Employee is refused; a second Recover is a no-op.

## Acceptance
- An Owner can recover a retained lock from the panel. An Employee cannot.
- The tests above pass. `bun run typecheck` and `bun run test` green.
