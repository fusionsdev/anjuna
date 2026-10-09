---
id: U10
title: test(core): make the cron test fast on Windows
branch: fus-341-cron-test-speed
lane: core-test
deps:
builder: codex
reviewers: deepseek
paths: workers/core/test/
merge: auto
---
## Goal
`workers/core/test/cron.test.ts:110` times out on Windows. D1 statements run one by one through the Miniflare proxy: 521 seed statements take 63 seconds. Production code is fine.

## Do
1. Batch the fixture inserts (`db.batch` or multi-row INSERT) in the test only.
2. Do not change production code under `workers/core/src`.

## Acceptance
- `cron.test.ts` finishes under the default timeout on Windows.
- No change outside `workers/core/test/`.
- `bun run test` green.
