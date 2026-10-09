# Gate evidence: T10 / FUS-345

- Gate: T10 live — install, re-run, rollback, automatic rollback.
- Date and time (with offset): 2026-10-09T09:40:54+07:00 (local guard and evidence review; production events are dated separately below).
- Run by: Codex, unit U04. Production actions were performed before this session; the export does not identify their operators.
- Environment: AdUplift factory; `levellendings.com`; brand `brand_e210d8e7f5234dde`; account ID and deployed commit are NOT_CHECKED (not selected by the supplied queries).
- Reviewed code: base `1d12772`, branch `fus-345-t10-evidence`, plus the server guard and tests committed with this report.
- Result: **PASS** for all four criteria, using supplied production receipts plus local guard, replay and forced-failure tests. The new server guard has not been deployed or tested against production.
- Source: owner-supplied, read-only `H:/w/t12a/anjuna/longrun/input/U04.txt`.
- Source SHA-256: `34697dd570973d36302dd9f6010b6868f888723855d5ee50c29ad8e71d4a4544`.
- Provenance: three successful `aduplift-factory` query results: installs for this brand, joined install receipts, and brand state. Each reports `changed_db: false`, `rows_written: 0`. Query execution time is absent; event timestamps below are exact stored UTC values. Receipt primary keys and output payloads were not selected; receipts are identified by `(install_id, step)`.

## Steps

| Step | Command or action | Output (secrets removed) | Expected | Result |
|---|---|---|---|---|
| 1 | Read the designated install and its receipts from U04.txt | `ins_b28eeabc0302418cbf09`: `ready`, finished `2026-10-08T13:21:05.152Z`; 10 `ok` receipts listed below | Install reaches READY | PASS |
| 2 | Inspect panel/server guards and test replay with local D1 and intercepted provider calls | Same-ID workflow replay performs no new work. New API requests for live brands return 409 with no new row or dispatch for owner and employee. No live second-request experiment is in the export | Re-run creates no install, version or domain | PASS |
| 3 | Read the two latest non-compensation rollback installs and receipts | `ins_44a116f385e94a6f98b1` and `ins_720b4b9abcee4a2eb908`: `rolled_back`, all four receipts `ok` for each | Rollback completes | PASS |
| 4 | Read failed-step compensation evidence; run the forced-failure factory test | `ins_440f699d34384ba885a4`: failed `deploy`, successful compensation, final `rolled_back`; local test forces smoke failure and executes compensation | Failed install rolls back automatically | PASS |

### 1. READY

Install `ins_b28eeabc0302418cbf09`, kind `install`, started `2026-10-08T13:19:09.411Z`, finished `2026-10-08T13:21:05.152Z`, status `ready`, error `null`.

| Step | Status | Receipt created_at (UTC) |
|---|---|---|
| validate | ok | 2026-10-08T13:19:13.569Z |
| save_rollback | ok | 2026-10-08T13:19:13.634Z |
| render | ok | 2026-10-08T13:19:15.273Z |
| upload_assets | ok | 2026-10-08T13:19:17.697Z |
| upload_script | ok | 2026-10-08T13:19:20.859Z |
| provision_runtime | ok | 2026-10-08T13:19:21.028Z |
| deploy | ok | 2026-10-08T13:19:22.008Z |
| attach_domains | ok | 2026-10-08T13:19:24.363Z |
| smoke | ok | 2026-10-08T13:21:05.049Z |
| receipt | ok | 2026-10-08T13:21:05.129Z |

The exported brand row is `live`, current revision `brand_e210d8e7f5234dde_rev_1`, updated `2026-10-08T20:37:37.653Z`. It is later than the designated install. The export contains later successful installs, ending with `ins_4c4f17ad7acf475a9ebb` at that timestamp. This report does not attribute the latest brand state exclusively to `ins_b28eeabc0302418cbf09`.

### 2. Re-run creates nothing new

Source checks:

- [Panel availability](../../../apps/web/src/client/lifecycle-state.ts), `lifecycleMutationAvailability`, line 90: Install is available only for `draft` or `failed`. A live brand hides Install.
- [Server startInstall](../../../apps/web/src/server/lifecycle.ts), `startInstall`: rejects every status except `draft` and `failed` with HTTP 409 before creating an install or dispatching the factory. The atomic `INSERT ... SELECT` also requires that allowed brand status and no active `queued`/`running` lifecycle operation, preventing admission after the initial status read becomes stale.
- [Install workflow](../../../workers/factory/src/workflows/install.ts), lines 56–60: returns before any step if the **same install ID** is already `ready` or `rolled_back`.
- [Receipt idempotency](../../../workers/factory/src/receipt.ts), `withReceipt`, lines 216–225: reuses an `ok` receipt for `(install_id, step)`. This does not deduplicate a newly generated install ID.

Tests:

| Test file and exact test name | What it establishes |
|---|---|
| `workers/factory/test/workflows.test.ts` — `replays a READY install with a fresh step cache without new installs, versions, domains or receipts` | U04 test. Installs once, verifies live/READY, then replays the same ID with an empty step cache. Install, revision and receipt rows stay identical. No additional intercepted network calls, script uploads, domain attachments or core mutations occur. |
| `workers/factory/test/receipt.test.ts` — `skips work on second call when ok receipt exists` | Work executes once across two calls sharing an install ID and step. |
| `apps/web/test/lifecycle-api.test.ts` — `rejects a second install or rollback while a lifecycle operation is active` | Existing concurrency guard returns 409 and retains one install while an operation is running. |
| `apps/web/test/lifecycle-api.test.ts` — `rejects a second install of a live brand without new installs, Worker versions or domains (%s)` (owner and employee) | First API install returns 201; the local fixture records READY/live completion and an existing Worker version. Second request returns 409. Install, brand/domain, revision/Worker-version and original audit snapshots remain identical. Total dispatches stays one; the rejected request cannot reach factory uploads or domain attachment. |

The API tests use a stubbed factory dispatcher and local D1. Zero additional dispatches proves the rejected request cannot start factory resource creation; this is not a live provider inventory measurement. `admits Install only for draft or failed brands (status=%s)` also covers draft/failed admission and installing/paused/retired rejection. The workflow replay test separately verifies no additional intercepted uploads or domain attachments when replaying the same install ID.

### 3. Rollback works

Both installs below have kind `rollback`, status `rolled_back`, error `null`.

| Install ID | started_at (UTC) | finished_at (UTC) |
|---|---|---|
| ins_44a116f385e94a6f98b1 | 2026-10-08T18:40:15.573Z | 2026-10-08T18:40:21.409Z |
| ins_720b4b9abcee4a2eb908 | 2026-10-08T20:35:04.141Z | 2026-10-08T20:35:13.229Z |

| Install ID | Step | Status | Receipt created_at (UTC) |
|---|---|---|---|
| ins_44a116f385e94a6f98b1 | validate | ok | 2026-10-08T18:40:19.844Z |
| ins_44a116f385e94a6f98b1 | attach_domains | ok | 2026-10-08T18:40:21.183Z |
| ins_44a116f385e94a6f98b1 | sync_runtime | ok | 2026-10-08T18:40:21.358Z |
| ins_44a116f385e94a6f98b1 | receipt | ok | 2026-10-08T18:40:21.393Z |
| ins_720b4b9abcee4a2eb908 | validate | ok | 2026-10-08T20:35:10.876Z |
| ins_720b4b9abcee4a2eb908 | attach_domains | ok | 2026-10-08T20:35:13.060Z |
| ins_720b4b9abcee4a2eb908 | sync_runtime | ok | 2026-10-08T20:35:13.191Z |
| ins_720b4b9abcee4a2eb908 | receipt | ok | 2026-10-08T20:35:13.217Z |

Additional local coverage: `workers/factory/test/workflows.test.ts` — `runs a rollback with target bundle identity and preserves an operator pause`. It executes the production rollback method against local fixtures and verifies `rolled_back`, the target bundle identity, and retained pause state. Exported receipts do not include rollback targets or provider version IDs, so no specific restored version is claimed here.

### 4. Automatic rollback after a failed step

Original install `ins_440f699d34384ba885a4` started `2026-10-08T04:02:13.261Z`. Its `deploy` receipt failed at `2026-10-08T04:02:35.638Z`. Its `rollback` receipt is `ok` at `2026-10-08T04:07:46.804Z`. The original install finished `rolled_back` at `2026-10-08T04:07:53.719Z`; its final error field is `null`. The failed receipt, rather than the final status, is the failure evidence.

Compensation install `compensate-ins_440f699d34384ba885a4`, kind `rollback`, started `2026-10-08T04:07:45.794Z`, finished `2026-10-08T04:07:53.668Z`, status `rolled_back`, error `null`.

| Compensation step | Status | Receipt created_at (UTC) |
|---|---|---|
| validate | ok | 2026-10-08T04:07:52.254Z |
| attach_domains | ok | 2026-10-08T04:07:53.237Z |
| sync_runtime | ok | 2026-10-08T04:07:53.483Z |
| receipt | ok | 2026-10-08T04:07:53.607Z |

Forced-failure test: `workers/factory/test/workflows.test.ts` — `compensates first-install failure after core provision using the actual core revision`. It sets `smokeFails = true`, runs the install, asserts a failed smoke receipt and failed original install, asserts exactly one compensation dispatch linked to that original install, executes `RollbackBrandWorkflow.run`, and verifies the original install becomes `rolled_back`, the core revision is cleared and paused, and the brand has no current revision. It also asserts the compensation install is `rolled_back`, all four compensation receipts are `ok`, and the original rollback receipt is `ok`. It then verifies a new recovery attempt reaches READY. All provider requests are intercepted locally.

The production export proves an actual failed step and completed compensation. It does not show that the production failure was deliberately injected. Deliberate failure is established by the local test.

## Local verification

Verification completed 2026-10-09T09:43:54+07:00. No checks were skipped or weakened for this change.

| Command / check | Result |
|---|---|
| `bun run typecheck` (repository root) | PASS, exit 0; 24/24 tasks successful, 23 cached; 5.003s. Web ran uncached. |
| `bun run test` (repository root) | PASS, exit 0; 25/25 tasks successful, 24 cached; 2m14.325s. Web ran uncached: 146 tests in 7 files, including 34 lifecycle API tests. Factory reused its passing cache: 133 tests in 6 files. |
| Evidence cross-check against U04.txt | PASS: all cited install IDs and production timestamps, 22 exact receipt tuples, source SHA-256 and all source links verified. |
| `git diff --check` | PASS; no whitespace errors. |

## Deviations and surprises

- The 2026-10-09 review found the missing server guard. This change adds the guard and replaces the defect characterization with rejection/no-mutation assertions for both roles. Source edits are authorized by the current U04 scope.
- The export contains **six** non-compensation rollback installs on 2026-10-08, plus three compensation installs. The two latest non-compensation rollback records are cited above; the statement that rollback ran twice is not the full history.
- Historical compensation did not always succeed: `ins_73af80bdf7b140768998` has a failed smoke receipt at `2026-10-08T05:10:15.736Z`. Its compensation `compensate-ins_73af80bdf7b140768998` has `attach_domains: failed` at `2026-10-08T05:15:36.995Z` and finished `failed` at `2026-10-08T05:20:47.548Z`. The original finished `failed` at `2026-10-08T05:20:47.561Z` with `recovery_required: true`. This run is not counted as successful compensation.
- PASS for automatic rollback means the cited successful path and forced-failure test are evidenced. It does not assert that every historical failure recovered successfully.

## Not checked

- NOT_RUN: live installs, live re-run, rollback, deployment, Cloudflare API, LeadsGate and VPS calls during U04. Credentials are intentionally disabled.
- NOT_CHECKED: current live HTTP/DNS state, account ID, deployed commit, provider resource inventories, and post-rollback version IDs. These fields are absent from the supplied queries.
- NOT_CHECKED: a production before/after inventory proving a new Install request creates no resources. The export is a history snapshot, not that experiment.

## Approval (T16 only)

- Not applicable. This is T10 evidence, not T16 owner approval.
