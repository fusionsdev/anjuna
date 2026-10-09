---
id: U01
title: feat(leads-db): seed zip_lookup with the V1 ZIP dataset
branch: fus-337-zip-lookup-seed
lane: leads-db
deps:
builder: codex
reviewers: deepseek
paths: packages/leads-db/
merge: auto
---
## Goal
Production `zip_lookup` was empty on 2026-10-08. Every lite_v1 lead got a blank state and was rejected to `/request/complete`. The owner seeded AdUplift by hand. Put the seed in the repo so every tenant (maimax, new tenants) gets it from the `deploy.yml` migrations.

## Do
1. Source file (read-only, outside the repo): `H:/DEV/projects/ppc_project/leads-form/fusion_formv_v1/db/zip_seed.corrected.sql` (42,632 ZIPs, 97003 fixed to Beaverton, OR).
2. Add it as the next migration after `0009_continuation_applicant.sql`, for example `packages/leads-db/migrations/0010_zip_lookup_seed.sql`. Every insert must be `INSERT OR IGNORE` so the already-seeded AdUplift DB is unchanged. Keep the 500-row batches.
3. Add a leads-db test: migrations apply on an empty D1, then 42411 resolves to KY Fredonia, 10001 to NY, 97003 to OR Beaverton, 90210 to CA. Apply the migrations once per test file so the suite stays fast on Windows.
4. Check that the column names match `zip_lookup` in `0001_v1_baseline.sql`.

## Acceptance
- The migration file exists, uses only `INSERT OR IGNORE INTO zip_lookup`, and holds 42,632 rows.
- The new test passes and covers 42411, 10001, 97003 and 90210.
- `bun run typecheck` and `bun run test` green.
