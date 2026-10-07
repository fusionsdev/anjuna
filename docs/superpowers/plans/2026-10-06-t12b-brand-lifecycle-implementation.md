# T12b Brand Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Approved by the owner on 2026-10-06 for long-running autonomous execution. The owner grants standing authorization to open and merge the single PR after every acceptance check and final review passes. Do not pause for routine implementation choices; pause only for a material risk of data loss or secret exposure, a production/deployment action outside this plan, an architectural contradiction that changes the approved design, or a required verification that remains failing after focused repair attempts.

**Goal:** Make the control panel's create, install, rollback, upgrade-all, receipt, and checklist actions truthful end to end across the panel BFF, Factory D1/Workflows, and core runtime.

**Architecture:** Add a lifecycle contract alongside—not inside—the existing core `AdminApi`; extend Factory and leads D1 with additive lifecycle state; expose separate private core Service Binding entrypoints for factory runtime mutation and panel Test-sold verification. The panel owns orchestration UX and Factory D1 rows, factory Workflows own Cloudflare mutations and compensation, and core remains authoritative for live runtime and lead/postback evidence.

**Tech Stack:** Bun 1.3.13 workspaces, TypeScript strict, Zod, D1, Cloudflare Workers/Service Bindings/Workflows, React 19, Vitest, Miniflare / `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-06-t12b-brand-lifecycle-design.md`

## Global Constraints

- Keep V1 money-path behavior; do not add loss-prevention machinery.
- LeadsGate handoff remains browser-side prepop redirect only; no server-side LeadsGate post and no `LEADSGATE_ENDPOINT`.
- No response may vary by user agent, IP, ASN, referrer, click id, or bot detection.
- Brand-served bytes must contain no other brand identifier, `anjuna`, `aurum`, PostHog key, or Sentry DSN.
- D1 holds data; R2 holds only sealed artifacts/evidence; Workers and Workflows perform compute.
- Never commit tokens or secrets. `CORE_TOKEN` is a Worker secret; receipts, D1, R2, browser responses, logs, and source contain no plaintext copy.
- Do not edit `spike/`, `packages/leads-db/v1/`, vendored V1 fixtures, or the separate dirty checkout at `/mnt/h/w/t12a/anjuna`.
- Do not deploy, run remote migrations, call Cloudflare APIs, LeadsGate, or the VPS drain during this task. Factory tests use fakes and core tests deny external egress.
- T12c reporting/monitoring, tenant bootstrap, mailing, user management, and new analytics capture remain out of scope.
- Any Worker that fetches another Worker in the same zone keeps `compatibility_flags: ["global_fetch_strictly_public"]`.
- Use additive migrations; existing artifact rows remain unselectable until `payload_version` is explicitly verified and backfilled.
- Before changing Turbo configuration or root commands, install from the existing lock and read the installed Turbo `docs/README.md` and relevant bundled docs. Do not hand-edit `bun.lock`.

## Review Focus

1. A dispatch exception or missing binding must persist a failed install and return an error, never `queued`; Task 7 owns the non-2xx/throw/missing-binding tests.
2. A late install, duplicate retry, or concurrent rollback must not overwrite a newer core revision; Tasks 3 and 5 own compare-and-set/idempotence tests.
3. Compensation must have its own `installs` parent and may mark the original `rolled_back` only after runtime and Worker restoration succeed; Task 5 owns the failure matrix.
4. Bundle identity (`form@<git_sha>`) must stay distinct from lead payload version (`2026-01`); Tasks 1, 3, and 8 test unequal values through install, upgrade, rollback, and submit.
5. Brand-byte checks must scan every served HTML/JS/CSS byte and fail on platform names, another brand id, analytics key, or DSN; Task 4 owns the negative fixtures.

---

## File Map

### New files

- `packages/contracts/src/lifecycle.ts` — shared panel/factory/core lifecycle wire schemas.
- `packages/contracts/test/lifecycle.test.ts` — schema, role, and bundle-vs-payload contract tests.
- `packages/factory-db/migrations/0004_lifecycle.sql` — payload metadata, receipt-step rebuild, checklist, and actor-role persistence.
- `packages/leads-db/migrations/0008_lifecycle.sql` — core applied revision, last lifecycle install, and bundle version.
- `workers/core/src/lifecycle.ts` — private factory and panel lifecycle handlers/entrypoints.
- `workers/core/test/lifecycle.test.ts` — account, compare-and-set, idempotence, detach, and Test-sold verification.
- `workers/factory/src/core-lifecycle-client.ts` — authenticated private core binding client.
- `workers/factory/test/lifecycle.test.ts` — Workflow orchestration, compensation, rollback, upgrade, and fake Cloudflare tests.
- `docs/runbooks/form-artifact-payload-version.md` — owner-only registration/backfill procedure; never executed by this task.
- `apps/web/src/server/lifecycle.ts` — lifecycle BFF routes and Factory D1 repository helpers.
- `apps/web/src/client/lifecycle-state.ts` — polling/state reducer independent of React rendering.
- `apps/web/src/client/screens/BrandLifecycle.tsx` — create/install/rollback/receipts/checklist UI.
- `apps/web/test/lifecycle-api.test.ts` — BFF payload, authorization, joins, dispatch, receipts, and checklist tests.
- `apps/web/test/lifecycle-ui.node.test.tsx` — role visibility and state-transition rendering tests.

### Existing files with focused changes

- `packages/contracts/src/index.ts`; `packages/factory-db/src/index.ts`; `packages/leads-db/src/index.ts` — export/list the new contracts and migrations.
- `tenants/schema.ts`, `tenants/aduplift.config.ts`, `tenants/maimax.config.ts`, `scripts/test/tenant-config.test.ts` — validated per-installation defaults and `CORE_TOKEN` secret-name mapping.
- `workers/core/src/index.ts`, `workers/core/src/env.ts`, `workers/core/test/helpers.ts` — export private entrypoints and expose them only through test/service bindings.
- `workers/factory/src/env.ts`, `workers/factory/src/index.ts`, `workers/factory/src/cf-api.ts`, `workers/factory/src/render.ts`, `workers/factory/src/workflows/{install,rollback,upgrade-all}.ts`, `workers/factory/wrangler.jsonc` — truthful commands, bindings, clean render, synchronization, and compensation.
- `apps/web/src/server/{index,env,audit}.ts`, `apps/web/src/client/{api,App}.tsx`, `apps/web/src/client/screens/Brands.tsx`, `apps/web/vitest.config.ts`, `apps/web/wrangler*.jsonc` — lifecycle delegation, binding declarations, merged view, UI, and tests.
- `packages/brand-runtime/test/assets-routing.node.test.ts`, `packages/brand-runtime/test/core-client.test.ts` — generated-byte and default core-binding evidence.

## Execution Order

Tasks 1 and 2 may be implemented in parallel only if each agent owns its listed files. Task 3 consumes both. Tasks 4–6 are sequential because they share factory bindings and Workflow interfaces. Task 7 consumes Tasks 1–6. Task 8 is the acceptance gate and begins only after Task 7 is green.

### Task 1: Define Lifecycle Wire Contracts

**Files:**
- Create: `packages/contracts/src/lifecycle.ts`
- Create: `packages/contracts/test/lifecycle.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `BrandId`, `FormVersion`, `AdminRole`, `AmountBuckets`, and request-context helpers from `@anjuna/contracts`.
- Produces: `LifecycleStatus`, `RuntimeSyncStatus`, `RegisterFormArtifactRequest`, `BackfillPayloadVersionRequest`, `CreateBrandDraftRequest`, `InstallBrandCommand`, `RollbackBrandCommand`, `UpgradeAllCommand`, `ApplyRuntimeRequest`, `ApplyRuntimeResponse`, `RuntimeStateRequest`, `RuntimeStateResponse`, `VerifySoldLeadRequest`, `VerifySoldLeadResponse`, `ChecklistItemName`, `ChecklistEvidence`, `InstallWithReceipts`, and `LifecycleBrandSummary`.
- `ApplyRuntimeRequest` carries `install_id`, `brand_id`, `account`, normalized apex/www `hostnames`, `expected_revision_id`, `target_revision_id`, `actor_id`, `actor_role`, and `initial_runtime`; `target_revision_id: null` means detach/pause.
- `initial_runtime` is required only when no core row exists and contains tenant-owned `drain_key`, `aid`, `prepop_base`, `amount_buckets`, `form_route`, `keyword_default`, and bundle `form_version`. It never carries a postback token.
- `RuntimeStateRequest` carries `brand_id` and `account`; `RuntimeStateResponse` returns `state: "absent"` or the applied revision, last lifecycle install, pause state, bundle form version, and credential-account match. It contains no secrets or money-routing values.
- `UpgradeAllCommand` carries distinct `from_template_version_id`, `to_template_version_id`, `form_artifact_id`, `canary_brand_id`, `started_by`, and `started_role`; the schema rejects equal versions and any `started_role` other than `owner`.

- [ ] **Step 1: Write failing contract tests**

  Add named tests that accept all command/response goldens; require payload metadata at artifact registration; reject overwriting a set payload version; reject a missing revision; reject equal upgrade source/target or a non-Owner `started_role`; reject unknown checklist names; reject secret/token fields; and accept bundle `form_version: "form@8ba11d3"` alongside lead payload `form_version: "2026-01"`.

- [ ] **Step 2: Run the contract test and confirm RED**

  Run: `(cd packages/contracts && bun run test -- test/lifecycle.test.ts)`

  Expected: FAIL because `src/lifecycle.ts` and its exports do not exist.

- [ ] **Step 3: Implement the Zod schemas and inferred types**

  Keep lifecycle routes separate from `AdminApi`; preserve the existing test asserting that install/rollback/upgrade are not core admin endpoints.

- [ ] **Step 4: Run focused contract tests and typecheck**

  Run: `(cd packages/contracts && bun run test -- test/lifecycle.test.ts test/admin-api.test.ts && bun run typecheck)`

  Expected: PASS, including the existing `AdminApi` exclusion test.

- [ ] **Step 5: Commit the contract boundary**

  ```bash
  git add packages/contracts/src/lifecycle.ts packages/contracts/src/index.ts packages/contracts/test/lifecycle.test.ts
  git commit -m "feat(t12): define brand lifecycle contracts"
  ```

### Task 2: Add Lifecycle Schema and Tenant Defaults

**Files:**
- Create: `packages/factory-db/migrations/0004_lifecycle.sql`
- Create: `packages/leads-db/migrations/0008_lifecycle.sql`
- Modify: `packages/factory-db/src/index.ts`
- Modify: `packages/factory-db/test/factory-db.test.ts`
- Modify: `packages/leads-db/src/index.ts`
- Modify: `packages/leads-db/test/leads-db.test.ts`
- Modify: `tenants/schema.ts`
- Modify: `tenants/aduplift.config.ts`
- Modify: `tenants/maimax.config.ts`
- Modify: `scripts/test/tenant-config.test.ts`
- Create: `docs/runbooks/form-artifact-payload-version.md`

**Interfaces:**
- Consumes: Task 1 checklist/status names and the existing `FACTORY_DB_MIGRATIONS`, `LEADS_DB_MIGRATIONS`, `INSTALL_STEPS`, and `BrandRuntimeRow` exports.
- Produces: nullable immutable `form_artifacts.payload_version`; checklist evidence keyed by `(brand_id, item)`; install `started_role`; receipt steps `provision_runtime` and `sync_runtime`; core runtime `form_version`, `applied_revision_id`, and `last_lifecycle_install_id`.
- Produces validated tenant inputs `{ leadsGateAid, prepopBase, brandDefaults: { account, formRoute, amountBuckets, payloadVersion }, secrets.coreToken }`. `aid` and `prepop_base` come from the existing top-level tenant fields; values remain per-installation config and secret names, not browser input.

- [ ] **Step 1: Write failing empty-D1 and constraint tests**

  Extend the DB tests to assert migration ordering; receipt rows survive the table rebuild; indexes are recreated; new core-sync steps are accepted; unknown steps are rejected; registration without `payload_version` is rejected; overwriting a non-null `payload_version` aborts; `payload_version` may be null only for legacy rows; checklist replay is unique; and runtime lifecycle columns round-trip.

- [ ] **Step 2: Write failing tenant-config tests**

  Assert valid `leadsGateAid`, HTTPS `prepopBase`, sorted unique amount buckets, one absolute form route, a valid payload version, distinct tenant account/defaults, and an uppercase secret-name reference for `coreToken`; assert no secret value is committed.

- [ ] **Step 3: Run the schema tests and confirm RED**

  Run: `(cd packages/factory-db && bun run test) && (cd packages/leads-db && bun run test) && (cd scripts && bun run test -- test/tenant-config.test.ts)`

  Expected: FAIL on missing migration files/columns/defaults.

- [ ] **Step 4: Implement additive migrations and exports**

  Rebuild `install_receipts` inside the migration with `PRAGMA defer_foreign_keys = on`, copy all existing rows, and recreate its indexes to extend the `step` CHECK. Add an immutability trigger that rejects any update of a non-null `form_artifacts.payload_version`. Do not infer payload metadata from `git_sha`; selection must reject null until owner-verified metadata is supplied later.

- [ ] **Step 5: Document the one-shot legacy metadata operation**

  Document the Owner-only BFF backfill operation implemented in Task 7, including the required artifact id and verified payload version, its set-once behavior, dry-run/local-test evidence, and the prohibition on executing it remotely during T12b implementation.

- [ ] **Step 6: Run DB and tenant tests**

  Run: `(cd packages/factory-db && bun run test && bun run typecheck) && (cd packages/leads-db && bun run test && bun run typecheck) && (cd scripts && bun run test -- test/tenant-config.test.ts && bun run typecheck)`

  Expected: PASS on empty D1, re-apply, preservation, and tenant-isolation tests.

- [ ] **Step 7: Commit schema and deployment defaults**

  ```bash
  git add packages/factory-db packages/leads-db tenants scripts/test/tenant-config.test.ts docs/runbooks/form-artifact-payload-version.md
  git commit -m "feat(t12): add lifecycle persistence"
  ```

### Task 3: Add Private Core Lifecycle Services

**Files:**
- Create: `workers/core/src/lifecycle.ts`
- Create: `workers/core/test/lifecycle.test.ts`
- Modify: `workers/core/src/index.ts`
- Modify: `workers/core/src/env.ts`
- Modify: `workers/core/test/helpers.ts`

**Interfaces:**
- Consumes: `ApplyRuntimeRequest`, `VerifySoldLeadRequest`, `authenticateAccount()`, `ownsBrand()`, and Task 2 runtime columns.
- Produces: `handleFactoryLifecycleRequest(request, env)`, `FactoryLifecycleService extends WorkerEntrypoint<Env>`, `handlePanelLifecycleRequest(request, env)`, and `PanelLifecycleService extends WorkerEntrypoint<Env>`.
- `FactoryLifecycleService` requires the bearer `CORE_TOKEN`, maps it through `account_credentials`, and rejects a request whose `account` differs from the credential account.
- `FactoryLifecycleService` serves both compare-and-set runtime mutation and a read-only runtime-state/preflight operation under the same bearer/account check.
- Core appends lifecycle audit through its existing `FACTORY` D1 binding; do not add a new leads-D1 path or return audit responsibility to the browser.
- `PanelLifecycleService` requires existing admin context headers and permits both Employee and Owner to verify a `soldLead` event without returning applicant PII.

- [ ] **Step 1: Write failing lifecycle service tests**

  Cover first provision, same-install retry no-op, stale expected revision 409, wrong account 403, existing-row preservation of aid/prepop/buckets/flow/A-B/keyword, detach pause, exactly one core audit row per state change and none on a no-op retry, runtime-state after apply/detach, credential preflight wrong account 403, explicit `absent` for a missing row, and public `/admin`/lifecycle paths remaining 404.

- [ ] **Step 2: Write failing Test-sold verification tests**

  Cover matching brand/event success, wrong brand, missing event, non-`soldLead`, Employee access, idempotent replay, and a response with event id/timestamp but no PII.

- [ ] **Step 3: Run the core lifecycle tests and confirm RED**

  Run: `(cd workers/core && bun run test -- test/lifecycle.test.ts test/admin.test.ts)`

  Expected: FAIL because the private handlers/entrypoints are absent.

- [ ] **Step 4: Implement compare-and-set runtime mutation**

  Insert initial tenant defaults only when the row is absent. On later switches update only hostnames, bundle `form_version`, `applied_revision_id`, `last_lifecycle_install_id`, pause state, and timestamps; preserve core-owned hot/money-routing fields. Treat the same `install_id` as a no-op and every other expected-revision mismatch as stale. Append the core-side lifecycle audit entry to Factory D1 using `actor_id`/`actor_role` from the validated request.

- [ ] **Step 5: Implement private sold-event lookup and named entrypoints**

  Export the two named entrypoints from `workers/core/src/index.ts`; include the factory runtime-state/preflight operation; do not route any lifecycle operation through the default public `fetch` handler.

- [ ] **Step 6: Run focused core verification**

  Run: `(cd workers/core && bun run test -- test/lifecycle.test.ts test/admin.test.ts test/rpc.test.ts && bun run typecheck)`

  Expected: PASS; existing money-path, account-boundary, and public-404 tests remain green.

- [ ] **Step 7: Commit the private core boundary**

  ```bash
  git add workers/core/src workers/core/test/helpers.ts workers/core/test/lifecycle.test.ts
  git commit -m "feat(t12): add private core lifecycle services"
  ```

### Task 4: Add Factory Core Client, Correct Bindings, and Clean Rendered Bytes

**Files:**
- Create: `workers/factory/src/core-lifecycle-client.ts`
- Modify: `workers/factory/src/env.ts`
- Modify: `workers/factory/src/cf-api.ts`
- Modify: `workers/factory/src/render.ts`
- Modify: `workers/factory/test/render.test.ts`
- Modify: `workers/factory/wrangler.jsonc`
- Modify: `packages/brand-runtime/test/assets-routing.node.test.ts`
- Modify: `packages/brand-runtime/test/core-client.test.ts`

**Interfaces:**
- Consumes: Task 1 core lifecycle schemas and Task 2 tenant defaults.
- Produces: `CoreLifecycleClient.applyRuntime(request)` and `CoreLifecycleClient.runtimeState({ brand_id, account })` over the private service binding with bearer auth; `verifyRuntime(brandId, account, revisionId, installId)` calls `runtimeState` and asserts its applied revision and last install.
- Factory `Env` gains `CORE_LIFECYCLE`, secret `CORE_TOKEN`, and nonsecret tenant default vars. `workers/factory/wrangler.jsonc` binds `CORE_LIFECYCLE` with `entrypoint: "FactoryLifecycleService"`. Brand script upload binds `CORE` to the core default fetch handler and injects `CORE_TOKEN` as `secret_text` without storing it elsewhere. The existing `packages/brand-runtime/example/worker.ts` already consumes both; production runtime source changes are allowed only if a failing test proves they are necessary.

- [ ] **Step 1: Write failing client and binding tests**

  Assert bearer forwarding, schema validation, bounded errors, factory service binding pinned to `FactoryLifecycleService`, generated brand binding pinned to core's default handler with no nonexistent `LeadsRpc` entrypoint, and `CORE_TOKEN` emitted only as a secret binding.

- [ ] **Step 2: Replace the platform-name salt marker test**

  Change `workers/factory/test/render.test.ts` from expecting `@anjuna-salt` to scanning every rendered HTML/JS/CSS file for `anjuna`, `aurum`, another brand id, a PostHog key, and a Sentry DSN while retaining opaque deterministic chunk names.

- [ ] **Step 3: Run focused tests and confirm RED**

  Run: `(cd workers/factory && bun run test -- test/render.test.ts) && (cd packages/brand-runtime && bun run test -- test/assets-routing.node.test.ts test/core-client.test.ts)`

  Expected: FAIL on the current salt comment and incorrect service entrypoint.

- [ ] **Step 4: Implement the private client, env declarations, and upload bindings**

  Keep secrets out of receipt output and thrown error text. Preserve `global_fetch_strictly_public` in the factory and generated brand Worker configuration.

- [ ] **Step 5: Remove platform text from rendered output**

  Keep the existing deterministic per-brand/per-revision hash behavior without embedding a readable marker or raw brand id.

- [ ] **Step 6: Run factory render/client and brand-runtime tests**

  Run: `(cd workers/factory && bun run test -- test/render.test.ts && bun run typecheck) && (cd packages/brand-runtime && bun run test && bun run typecheck)`

  Expected: PASS with byte scans over HTML, JS, and CSS.

- [ ] **Step 7: Commit binding and byte-cleanliness fixes**

  ```bash
  git add workers/factory packages/brand-runtime/test
  git commit -m "fix(t12): bind core securely in brand workers"
  ```

### Task 5: Make Install, Compensation, and Rollback Truthful

**Files:**
- Create: `workers/factory/test/lifecycle.test.ts`
- Modify: `workers/factory/src/index.ts`
- Modify: `workers/factory/src/workflows/install.ts`
- Modify: `workers/factory/src/workflows/rollback.ts`
- Modify: `workers/factory/src/receipt.ts`

**Interfaces:**
- Consumes: `InstallBrandCommand`, `RollbackBrandCommand`, `CoreLifecycleClient`, Task 2 receipt steps, and existing fakeable Cloudflare helpers.
- Produces: `/install` and `/rollback` responses that acknowledge only successfully created Workflow instances; revision ownership/payload/default preflight; core provision/sync receipts; real compensation rows; and synchronized detach/rollback outcomes.
- Factory status transition uses a conditional D1 write so one brand cannot run overlapping install/rollback mutations.
- The factory maps `leadsGateAid` and `prepopBase` plus `brandDefaults` into `initial_runtime`, derives `drain_key` deterministically from the opaque `brand_id`, and never accepts any of those values from Employee/BFF input.

- [ ] **Step 1: Write failing install/preflight tests**

  Cover revision ownership, sealed template, artifact presence, null/mismatched payload metadata, tenant AID/prepop/defaults, deterministic opaque-brand drain key, credential/runtime-state preflight, concurrent mutation rejection, no Employee/BFF money-routing override, and no Cloudflare call before every preflight passes.

- [ ] **Step 2: Write failing order/readiness tests**

  Assert first install provisions core before domain attach; existing install switches core after smoke; requests during the new-Worker/old-core interval remain compatible; and `ready/live` is impossible until smoke plus core verification receipts are both `ok`.

- [ ] **Step 3: Write failing compensation/rollback tests**

  Cover failure before mutation preserving prior state; first-install mutation failure creating a compensation `installs` row, detaching domains, pausing core, and leaving factory `failed`; existing-brand failure restoring Worker and core revision; compensation failure leaving both rows failed with recovery evidence; explicit previous-revision rollback; and null-target live first-install detach returning factory `draft`.

- [ ] **Step 4: Run the Workflow tests and confirm RED**

  Run: `(cd workers/factory && bun run test -- test/lifecycle.test.ts test/receipt.test.ts)`

  Expected: FAIL against the current eager `rolled_back`, orphan compensation, and missing core-sync behavior.

- [ ] **Step 5: Implement install/preflight/runtime synchronization**

  Keep the proven validate → save rollback → render → upload assets → upload script → deploy → attach → smoke sequence; add `provision_runtime` before first attach and `sync_runtime` after existing-brand smoke; verify the final core revision before setting READY.

- [ ] **Step 6: Implement compensation and rollback state machines**

  Insert the compensation install/audit row before starting rollback, wait for its terminal state, and update the original only after compensation succeeds. Validate every non-null target belongs to the brand and has a deployed Worker version.

- [ ] **Step 7: Run focused factory verification**

  Run: `(cd workers/factory && bun run test -- test/lifecycle.test.ts test/receipt.test.ts test/render.test.ts && bun run typecheck)`

  Expected: PASS with no outbound network access.

- [ ] **Step 8: Commit install and rollback repairs**

  ```bash
  git add workers/factory/src workers/factory/test/lifecycle.test.ts
  git commit -m "fix(t12): make lifecycle workflows truthful"
  ```

### Task 6: Make Upgrade-All Canary-First with Distinct Versions

**Files:**
- Modify: `workers/factory/src/index.ts`
- Modify: `workers/factory/src/workflows/upgrade-all.ts`
- Modify: `workers/factory/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `UpgradeAllCommand` and the corrected install Workflow from Task 5.
- Produces: one `/upgrade-all` Workflow whose input is `{ from_template_version_id, to_template_version_id, form_artifact_id, canary_brand_id, started_by, started_role }` and whose per-brand rows retain inspectable outcomes.

- [ ] **Step 1: Write failing upgrade tests**

  Cover equal source/target rejection; target sealed and same template family; compatible payload metadata; eligible live-brand selection from the source version; canary membership; exactly one canary install; no fan-out after canary failure; only not-already-target remaining brands launched after READY; and the same conditional per-brand lock used by install/rollback so an Employee rollback cannot overlap fan-out.

- [ ] **Step 2: Run the upgrade tests and confirm RED**

  Run: `(cd workers/factory && bun run test -- test/lifecycle.test.ts -t "upgrade-all")`

  Expected: FAIL because the current Workflow uses one `template_version_id` for both source and target.

- [ ] **Step 3: Implement distinct source/target revision creation**

  Copy each brand's current config snapshot, create one new revision with the target template/form, then use the corrected install Workflow; do not invent a per-brand `/upgrade` route.

- [ ] **Step 4: Implement the canary gate and per-brand evidence**

  Require the canary install to reach READY including core sync before fan-out. Preserve failed canary and later per-brand install rows/receipts for the panel.

- [ ] **Step 5: Run factory verification**

  Run: `(cd workers/factory && bun run test && bun run typecheck)`

  Expected: PASS for install, rollback, receipt, render, and upgrade-all coverage.

- [ ] **Step 6: Commit upgrade-all**

  ```bash
  git add workers/factory/src/index.ts workers/factory/src/workflows/upgrade-all.ts workers/factory/test/lifecycle.test.ts
  git commit -m "fix(t12): gate upgrades on a ready canary"
  ```

### Task 7: Implement Truthful Panel Lifecycle APIs

**Files:**
- Create: `apps/web/src/server/lifecycle.ts`
- Create: `apps/web/test/lifecycle-api.test.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `apps/web/src/server/env.ts`
- Modify: `apps/web/src/server/audit.ts`
- Modify: `apps/web/src/server/panel-roles.ts`
- Modify: `apps/web/test/helpers.ts`
- Modify: `apps/web/test/api.test.ts`
- Modify: `apps/web/wrangler.jsonc`
- Modify: `apps/web/wrangler.deploy.aduplift.jsonc`
- Modify: `apps/web/wrangler.deploy.maimax.jsonc`

**Interfaces:**
- Consumes: all Task 1 lifecycle schemas, Factory D1 from Task 2, `FACTORY_WORKER`, existing core `AdminService`, and private `PanelLifecycleService`.
- Produces: `handleLifecycleRoute(request, env, url, path, ctx): Promise<Response | undefined>` and routes for Owner-only form-artifact registration/set-once legacy payload backfill, sealed-template selection, brand draft create/list/get, install, failed-dispatch retry, rollback, installs/receipts, checklist, and one owner-only upgrade-all command. A source scan found no existing production `form_artifacts` registration path, so this BFF route is the single audited path.
- A dispatch failure returns `502 factory_dispatch_failed` with the persisted failed `install_id`; `POST /api/installs/:install_id/retry` reuses that id and immutable command payload.

- [ ] **Step 1: Write failing draft/list tests**

  Assert Employee input is only domain, keyword, and sealed template; the BFF derives name/account/defaults, selects the latest compatible form artifact, and batches brand + revision 1 + audit. Test invalid/duplicate domains, missing/unsealed template, missing/null/mismatched form metadata, visible draft/failed rows, core-only `unmanaged`, and factory-live/core-missing `sync_error`.

- [ ] **Step 2: Write failing dispatch/receipt tests**

  Assert exact install `{install_id, brand_id, revision_id}` and rollback `{install_id, brand_id, to_revision_id}` payloads; previous deployed—not merely previous numbered—revision resolution; null detach; missing binding/non-2xx/throw persistence; same-id retry; install receipts in reads; and no false queued response. Synchronous preflight 4xx responses also persist the install as `failed` while preserving their actionable code/message; only transport/missing-binding/5xx failures become `502 factory_dispatch_failed`.

- [ ] **Step 3: Write failing authorization/upgrade tests**

  Assert Employee and Owner install/rollback succeed; Employee upgrade-all is 403 before D1/binding access; Owner sends exactly one `/upgrade-all` command with distinct versions, one canary, form artifact, actor, and role; no `/upgrade` request occurs.

- [ ] **Step 4: Write failing checklist/audit tests**

  Assert Owner-only artifact registration requires `payload_version`; set-once legacy backfill conflicts after the first write and is audited. Assert manual drain/postback/final-URL attestations store actor/time only; Test-sold requires the private core event; wrong-brand/missing/non-sold events fail; event replay is idempotent; lifecycle failure/compensation audit entries are visible to Owner and scoped to Employee; API errors are never logged as success.

- [ ] **Step 5: Run panel lifecycle tests and confirm RED**

  Run: `(cd apps/web && bun run test -- --project worker test/lifecycle-api.test.ts test/api.test.ts)`

  Expected: FAIL against the current core-only list, missing revision payloads, swallowed dispatch failures, and per-brand `/upgrade` loop.

- [ ] **Step 6: Implement the lifecycle repository/router**

  Move lifecycle SQL and dispatch logic out of `route()` into `lifecycle.ts`; keep auth/session creation and existing admin/core routes in `index.ts`. Use D1 batches for draft and audit writes; use conditional state updates for action locks.

- [ ] **Step 7: Wire private bindings and fail closed**

  Add `FACTORY_WORKER` plus `CORE_LIFECYCLE` with `entrypoint: "PanelLifecycleService"` to committed panel configs without deploying. Add a config test proving no panel config references `FactoryLifecycleService`. Missing bindings remain operator-visible errors; do not restore the queued fallback.

- [ ] **Step 8: Run panel API verification**

  Run: `(cd apps/web && bun run test -- --project worker && bun run typecheck)`

  Expected: PASS for existing auth/config APIs plus the lifecycle matrix.

- [ ] **Step 9: Commit the lifecycle BFF**

  ```bash
  git add apps/web/src/server apps/web/test apps/web/wrangler*.jsonc
  git commit -m "feat(t12): expose truthful lifecycle APIs"
  ```

### Task 8: Add Lifecycle UI and Cross-Package Acceptance Evidence

**Files:**
- Create: `apps/web/src/client/lifecycle-state.ts`
- Create: `apps/web/src/client/screens/BrandLifecycle.tsx`
- Create: `apps/web/test/lifecycle-ui.node.test.tsx`
- Modify: `apps/web/src/client/api.ts`
- Modify: `apps/web/src/client/App.tsx`
- Modify: `apps/web/src/client/screens/Brands.tsx`
- Modify: `apps/web/src/client/styles.css`
- Modify: `apps/web/vitest.config.ts`
- Modify: `workers/core/test/lifecycle.test.ts`
- Modify: `workers/core/test/helpers.ts`

**Interfaces:**
- Consumes: Task 7 lifecycle endpoints and statuses.
- Produces: `reduceLifecycleState(state, event)`, typed client methods, Thai UI labels with English technical terms, domain/keyword/template draft creation, polling receipts, rollback/retry, four checklist items, and Owner-only upgrade-all.
- UI renders lifecycle and runtime status separately and never labels a brand READY when smoke/core synchronization is incomplete.

- [ ] **Step 1: Write failing UI state/role tests**

  Use `react-dom/server` plus pure reducer tests; add `.node.test.tsx` discovery without introducing a new browser-test dependency. Cover draft → queued → running → ready, failed → retry, failed compensation, rolled-back/detached, `unmanaged`, `sync_error`, Employee hidden upgrade-all, and Owner visible upgrade-all.

- [ ] **Step 2: Write failing fake end-to-end core tests**

  Extend the Miniflare harness with private lifecycle bindings. Apply first install, upgrade, and rollback revisions with bundle ids different from payload `2026-01`; submit the existing V1 form fixture after each; assert success during the permitted new-Worker/old-core interval and after synchronization; assert wrong-account failure and zero external requests.

- [ ] **Step 3: Run UI and core tests and confirm RED**

  Run: `(cd apps/web && bun run test -- --project build test/lifecycle-ui.node.test.tsx) && (cd workers/core && bun run test -- test/lifecycle.test.ts)`

  Expected: FAIL on missing state reducer/components and lifecycle harness bindings.

- [ ] **Step 4: Implement typed client/state/UI**

  Poll only while an install is queued/running; stop on ready/failed/rolled-back. Display receipt names/errors and actionable missing-binding/artifact/credential messages without secrets. Keep the visible working set focused on one selected brand.

- [ ] **Step 5: Implement cross-package lifecycle acceptance coverage**

  Reuse existing form fixtures, core validation, and brand Worker test harness. Do not call real Cloudflare, LeadsGate, or drain services.

- [ ] **Step 6: Run focused package verification**

  Run: `(cd apps/web && bun run build && bun run test && bun run typecheck) && (cd workers/core && bun run test && bun run typecheck) && (cd workers/factory && bun run test && bun run typecheck)`

  Expected: PASS; the web build test may write `apps/web/dist/client`, so do not run it concurrently with another web build/test.

- [ ] **Step 7: Run repository acceptance verification**

  First resolve/install Bun 1.3.13 and dependencies from the existing lock without changing it. Then read installed Turbo guidance and run:

  ```bash
  bun install --frozen-lockfile
  bun run build
  bun run typecheck
  bun run test
  git diff --check
  git status --short
  ```

  Expected: all commands succeed; only intended source/docs/lock-consistent changes remain; no deployment or remote call occurs.

- [ ] **Step 8: Commit UI and acceptance evidence**

  ```bash
  git add apps/web workers/core/test
  git commit -m "feat(t12): complete lifecycle control panel"
  ```

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 cover ownership, private core boundaries, runtime compare-and-set, credential/account validation, payload compatibility, and Test-sold evidence. Tasks 4–6 cover binding correction, clean bytes, install/rollback/compensation, receipts, and canary-first upgrades. Tasks 7–8 cover drafts, truthful dispatch/listing, roles/audit/checklist, UI, fake lead submit, and complete verification.
- **Step scan:** Every test, implementation, verification, and commit is a separate checkable action; no task asks an implementer to invent an unnamed interface.
- **Type consistency:** `InstallBrandCommand`, `RollbackBrandCommand`, `UpgradeAllCommand` (including `started_role`), `ApplyRuntimeRequest`, `RuntimeStateRequest`, and lifecycle status names are defined once in Task 1 and consumed thereafter.
- **Review focus:** Each of the five failure classes is pinned to named tests in Tasks 3–5, 7, or 8.
- **Proportion:** The plan specifies boundaries, signatures, assertions, and commands; it leaves function bodies and ordinary framework wiring to implementers.

## Execution Method

All tasks land as commits on `fus-347-t12b-brand-lifecycle`, opened as **one** PR against `main`. No task opens its own PR. The owner has granted standing authorization for the agent to merge the final PR after Task 8 Step 7 is green, Claude completes a read-only whole-branch final review with no unresolved P0/P1, required CI checks pass, and the PR description maps spec acceptance items 1–7 to named tests or command output. Do not bypass branch protection, force-push shared history, or merge with required checks failing. Any P0/P1 sends the work back to its owning task. Mark every unexecuted command `NOT_RUN` and list discovered work outside T12b under `Proposed (out of scope)`. Use one fresh implementation agent per task plus a different read-only reviewer before the next dependent task starts. Only Tasks 1 and 2 may run in parallel, with disjoint file ownership. Tasks 3–8 remain sequential because they share lifecycle schemas, D1 migrations, Worker bindings, and generated build outputs.

The toolchain blocker is resolved: Bun 1.3.13 is installed at `/home/barbara/.local/bin/bun`, `bun install --frozen-lockfile` installed the workspace dependencies, and `bun.lock` remained unchanged. Run the root typecheck and test commands as the implementation baseline before the first source edit; do not present any unexecuted command as passing evidence.

For long-running execution, treat context rotation as an operational checkpoint. When context becomes large, repetitive, or reasoning quality begins to drop, finish and verify the smallest safe atomic unit, run `$oracle-handoff`, and start a fresh Codex session whose first instruction is `$oracle-resume`. The resumed session must report the Oracle HOT context and live Git continuity before continuing `NEXT_TASK`. Routine choices, passing task transitions, PR creation, and the authorized merge do not require another owner prompt. Pause only for the material blockers listed in the approved status above.
