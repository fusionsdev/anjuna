# Core test fixtures

## Cron batch limit

The `bounds one run to MAX_OUTBOX_BATCHES` test in `cron.test.ts` seeds
`MAX_OUTBOX_BATCHES * 50 + 10` leads and matching mailing outbox rows.
Keep these inserts in one `db.batch`: a multi-row lead insert followed by
an `INSERT ... SELECT` for the outbox. Per-row awaited statements incur
Miniflare proxy round trips and previously exceeded the timeout on Windows.

The fixture checks both insert counts before running the production cron.
The result must contain `MAX_OUTBOX_BATCHES * 50` sent rows and 10 pending rows.
Keep the configured 30-second test timeout unchanged.

Run from `workers/core` to check timing without Turborepo's result cache:

```sh
bun run test -- --reporter=verbose test/cron.test.ts
```

Run `bun run typecheck` and `bun run test` from the repository root for the
full acceptance checks. The core harness blocks external requests.
