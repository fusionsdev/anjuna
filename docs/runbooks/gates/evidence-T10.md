# Gate evidence: T10 / FUS-345

- Gate: T10 live — install, re-run, rollback, automatic rollback.
- Date and time (with offset): 2026-10-09T08:07:52+07:00 (evidence review; production events are dated separately below).
- Run by: Codex, unit U04. Production actions were performed before this session; the export does not identify their operators.
- Environment: AdUplift factory; `levellendings.com`; brand `brand_e210d8e7f5234dde`; account ID and deployed commit are NOT_CHECKED (not selected by the supplied queries).
- Reviewed code: `fb5c09c9992b255deac7d9da0f0bbae2105e6d7c`, branch `fus-345-t10-evidence`, plus the U04 tests committed with this report.
- Result: **PARTIAL — T10 cannot close.** READY, rollback and automatic rollback have evidence. Same-install replay is protected, but a new Install request for a live brand is not rejected by the server.
- Source: owner-supplied, read-only `H:/w/t12a/anjuna/longrun/input/U04.txt`.
- Source SHA-256: `244daae8add5b5491b52066c8ad00b96adbf3952a6daf6705950fe04912059aa`.
- Provenance: three successful `aduplift-factory` query results: installs for this brand, joined install receipts, and brand state. Each reports `changed_db: false`, `rows_written: 0`. Query execution time is absent; event timestamps below are exact stored UTC values. Receipt primary keys and output payloads were not selected; receipts are identified by `(install_id, step)`.

## Steps

| Step | Command or action | Output (secrets removed) | Expected | Result |
|---|---|---|---|---|
| 1 | Read the designated install and its receipts from U04.txt | `ins_b28eeabc0302418cbf09`: `ready`, finished `2026-10-08T13:21:05.152Z`; 10 `ok` receipts listed below | Install reaches READY | PASS |
| 2 | Inspect panel/server guards and test replay with local D1 and intercepted provider calls | Same-ID workflow replay performs no new work. A fresh API request after a completed install creates a second install and dispatches it. No live second-request experiment is in the export | Re-run creates no install, version or domain | PARTIAL |
| 3 | Read the two latest operator rollback installs and receipts | `ins_44a116f385e94a6f98b1` and `ins_720b4b9abcee4a2eb908`: `rolled_back`, all four receipts `ok` for each | Rollback completes | PASS |
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
- [Server startInstall](../../../apps/web/src/server/lifecycle.ts), lines 133–156: reads brand status but never rejects `live`. Its atomic `INSERT ... WHERE NOT EXISTS` only guards active `queued`/`running` lifecycle operations. A prior `ready` install does not block a new row or dispatch.
- [Install workflow](../../../workers/factory/src/workflows/install.ts), lines 56–60: returns before any step if the **same install ID** is already `ready` or `rolled_back`.
- [Receipt idempotency](../../../workers/factory/src/receipt.ts), `withReceipt`, lines 216–225: reuses an `ok` receipt for `(install_id, step)`. This does not deduplicate a newly generated install ID.

Tests:

| Test file and exact test name | What it establishes |
|---|---|
| `workers/factory/test/workflows.test.ts` — `replays a READY install with a fresh step cache without new installs, versions, domains or receipts` | New U04 test. Installs once, verifies live/READY, then replays the same ID with an empty step cache. Install, revision and receipt rows stay identical. No additional intercepted network calls, script uploads, domain attachments or core mutations occur. |
| `workers/factory/test/receipt.test.ts` — `skips work on second call when ok receipt exists` | Work executes once across two calls sharing an install ID and step. |
| `apps/web/test/lifecycle-api.test.ts` — `rejects a second install or rollback while a lifecycle operation is active` | Existing concurrency guard returns 409 and retains one install while an operation is running. |
| `apps/web/test/lifecycle-api.test.ts` — `documents the missing live-brand guard: a second install creates another attempt` | New U04 defect characterization. First API install returns 201; local fixture then records its READY/live completion. Second request returns 201, leaves two distinct install rows and dispatches twice. It deliberately records current behavior; it is not a passing guard acceptance test. |

The API test uses a stubbed factory dispatcher. It proves a second install is created and dispatched; it does not claim a second provider version or domain was actually created. The workflow replay test proves no extra provider mutations for the same install ID only. No test can truthfully establish the requested new-request guard in this revision because that guard is absent.

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

Forced-failure test: `workers/factory/test/workflows.test.ts` — `compensates first-install failure after core provision using the actual core revision`. It sets `smokeFails = true`, runs the install, asserts exactly one compensation dispatch, executes `RollbackBrandWorkflow.run`, and verifies the original install becomes `rolled_back`, the core revision is cleared and paused, and the brand has no current revision. It then verifies a new recovery attempt reaches READY. All provider requests are intercepted locally.

The production export proves an actual failed step and completed compensation. It does not show that the production failure was deliberately injected. Deliberate failure is established by the local test.

## Local verification

Completed by `2026-10-09T08:13:25+07:00`. No skipped or expected-failure test was added to hide the missing guard. The API characterization passes because it reproduces the defect; this does not turn criterion 2 into PASS.

| Command / check | Result |
|---|---|
| `bun run typecheck` (repository root) | PASS, exit 0; 24/24 tasks successful, 22 cached. Changed web and factory packages ran uncached. |
| `bun run test` (repository root) | PASS, exit 0; 25/25 tasks successful, 23 cached; 2m3.692s. Web: 140 tests in 7 files. Factory: 133 tests in 6 files. Both changed packages ran uncached. |
| `bun run test -- test/lifecycle-api.test.ts` (apps/web) | PASS, exit 0; 28 tests. Started `2026-10-09T08:09:03+07:00`; duration 61.68s. |
| `bun run test -- test/workflows.test.ts` (workers/factory) | PASS, exit 0; 23 tests. Started `2026-10-09T08:09:03+07:00`; duration 54.45s. |
| Evidence cross-check against U04.txt | PASS: 8 cited install IDs, every production timestamp and 22 tabulated receipt rows match the export. All relative source links resolve. |

## Deviations and surprises

- **Blocking gap:** `startInstall` has no live-brand guard. This contradicts the assumed guard in the unit request. The panel hides the button, but a direct API request bypasses that UI restriction. T10 remains PARTIAL.
- The export contains **six** non-compensation rollback installs on 2026-10-08, plus three compensation installs. The two latest operator rollback records are cited above; the statement that rollback ran twice is not the full history.
- Historical compensation did not always succeed: `ins_73af80bdf7b140768998` has a failed smoke receipt at `2026-10-08T05:10:15.736Z`. Its compensation `compensate-ins_73af80bdf7b140768998` has `attach_domains: failed` at `2026-10-08T05:15:36.995Z` and finished `failed` at `2026-10-08T05:20:47.548Z`. The original finished `failed` at `2026-10-08T05:20:47.561Z` with `recovery_required: true`. This run is not counted as successful compensation.
- PASS for automatic rollback means the cited successful path and forced-failure test are evidenced. It does not assert that every historical failure recovered successfully.

### Proposed (out of scope)

Add a server-side live-brand admission guard in `apps/web/src/server/lifecycle.ts`, including the atomic admission condition. Replace the defect characterization with rejection/no-new-install assertions and verify no factory dispatch occurs. That source file is outside U04's allowed edit paths. Do not close FUS-345 until the new-request re-run criterion passes.

## Not checked

- NOT_RUN: live installs, live re-run, rollback, deployment, Cloudflare API, LeadsGate and VPS calls during U04. Credentials are intentionally disabled.
- NOT_CHECKED: current live HTTP/DNS state, account ID, deployed commit, provider resource inventories, and post-rollback version IDs. These fields are absent from the supplied queries.
- NOT_CHECKED: a production before/after inventory proving a new Install request creates no resources. The export is a history snapshot, not that experiment.

## Approval (T16 only)

- Not applicable. This is T10 evidence, not T16 owner approval.
