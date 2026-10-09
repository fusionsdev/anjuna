---
id: U04
title: docs(gates): close T10 with install, re-run, rollback and compensation evidence
branch: fus-345-t10-evidence
lane: factory
deps:
builder: codex
reviewers: deepseek
paths: docs/runbooks/gates/ workers/factory/ apps/web/
merge: auto
---
## Goal
Close T10 (FUS-345). Acceptance in `docs/TASKS.md`: install on the test domain reaches READY; a re-run creates nothing new; rollback works; a deliberately failing step rolls back automatically. Live brand: levellendings.com, `brand_e210d8e7f5234dde`, install `ins_b28eeabc0302418cbf09`.

## Do
1. Read the production query results file named in the prompt header. It holds the installs and receipts for the brand.
2. READY: cite the ok receipts of `ins_b28eeabc0302418cbf09`.
3. Re-run creates nothing new. The panel hides Install for a live brand (`apps/web/src/client/lifecycle-state.ts:90`). Find the server-side guard in `apps/web/src/server/lifecycle.ts` `startInstall` and the idempotency in `workers/factory/src/workflows/install.ts`. Cite the tests. Review on 2026-10-09 found that `startInstall` accepts a second install of a live brand (201, a second dispatch). Add the guard: the server refuses Install unless the brand is `draft` or `failed` (409, no row, no dispatch), matching `lifecycleMutationAvailability`. Add a test that a second install of a live brand creates no install row, Worker version or domain.
4. Rollback works: cite rollback installs and receipts from the query results. Rollback ran twice on 2026-10-08.
5. Auto-rollback: cite a failed install whose compensation receipts ran, and the factory test that forces a step failure.
6. Write `docs/runbooks/gates/evidence-T10.md` from `evidence-template.md`. Mark each criterion PASS, PARTIAL or NOT_RUN with ids and timestamps. Never invent receipts.

## Acceptance
- The evidence file covers all 4 criteria with real ids from the query results.
- A test proves the re-run guard, either cited or new.
- `bun run typecheck` and `bun run test` green.
