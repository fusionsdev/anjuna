# Auto-create conversion action (FUS-384) implementation plan

Spec: `docs/superpowers/specs/2026-10-26-auto-conversion-design.md`. Branch `fus-384-auto-conversion`, one PR.

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `--remote`, no real AdKit, Google Ads or core call. Tests inject the AdKit runner and `fetch`.
- Workers never call AdKit. No AdKit key, token or CLI name appears under `workers/` or `apps/`.
- The drain endpoints read the token from the `Authorization` header only, through `drainAuthorized` in `workers/core/src/auth.ts`.
- The conversion name matches `^cv-[0-9a-f]{16}$` everywhere: contract, migration CHECK, drain generator.
- Shared files (`packages/contracts/src/index.ts`, `packages/contracts/src/admin-api.ts`, `workers/core/src/index.ts`, `workers/core/src/admin/index.ts`, `apps/web/src/server/index.ts`, `apps/web/src/client/api.ts`, `apps/web/src/server/mock-core.ts`) get the smallest addition. Never reformat or reorder them.
- Parallel lane FUS-383 owns `templates.ts`, `lifecycle.ts` and `SettingsEditor`. Do not touch them.
- `drain.mjs` and `packages/contracts/test/v1/drain.mjs` stay byte-identical.
- Thai-first UI copy with English in parentheses.

## Task 1: contracts and migration

Files: `packages/contracts/src/conversion-setup.ts` (new), `packages/contracts/src/index.ts` (one export line), `packages/contracts/src/admin-api.ts` (one endpoint entry `conversionSetup`), `packages/contracts/fixtures/admin/conversion-setup.response.json` (new, plus whatever fixture registry the contracts tests require), `packages/contracts/test/conversion-setup.test.ts` (new), `packages/leads-db/migrations/0018_conversion_setup.sql` (new), `packages/leads-db/src/index.ts` (append to `LEADS_DB_MIGRATIONS`), `packages/leads-db/test/leads-db.test.ts` (table lists).

Interfaces (zod, strict objects):
- `ConversionName = z.string().regex(/^cv-[0-9a-f]{16}$/)`.
- `ConversionSetupPendingResponse = { brands: Array<{ brand_id: BrandId, account: GoogleAdsAccount, project: AdkitProject.nullable(), name: ConversionName.nullable() }> }`.
- `ConversionSetupClaimRequest = { brand_id: BrandId, name: ConversionName }`.
- `ConversionSetupClaimResponse = { status: "claimed", claim_id: uuid string, name: ConversionName, account: GoogleAdsAccount, project: AdkitProject.nullable() }`.
- `ConversionSetupResultRequest` = union of `{ brand_id, claim_id, conversion_action_id: GoogleConversionAction }` and `{ brand_id, claim_id, error: z.string().min(1).max(500) }`. Exactly one of the two shapes.
- `ConversionSetupStatus = z.enum(["none", "pending", "created", "failed"])`.
- `ConversionSetupState = { status, error: string|null, name: ConversionName.nullable(), conversion_action_id: GoogleConversionAction.nullable(), attempts: int >= 0, updated_at: Timestamp.nullable() }`; `ConversionSetupStateResponse = { conversion_setup: ConversionSetupState }`.
- Constants: `CONVERSION_SETUP_LEASE_MS = 30 * 60 * 1000`, `CONVERSION_SETUP_MAX_ATTEMPTS = 5`, `conversionSetupBackoffMs(attempts)` = `min(2^(attempts-1) h, 24 h)`.
- `AdminApi.conversionSetup = { method: "GET", path: "/admin/brands/:id/conversion-setup", min_role: "owner", response: ConversionSetupStateResponse }`.

Migration 0018: the table in spec section 4 with CHECKs: `length(account) = 10 AND account NOT GLOB '*[^0-9]*'`; `name GLOB 'cv-[0-9a-f]...'` (16 hex classes) and `length(name) = 19`; `conversion_action_id IS NULL OR (length BETWEEN 1 AND 20 AND digits only)`; `length(last_error) <= 500` when not NULL. Header comment in the style of 0014.

Tests (`packages/contracts/test/conversion-setup.test.ts`):
- `ConversionName accepts cv- plus 16 hex and rejects uppercase, brand text and wrong length`.
- `claim request rejects unknown fields`.
- `result request accepts exactly one of conversion_action_id or error`.
- `result error longer than 500 characters is rejected`.
- `backoff doubles from 1 hour and caps at 24 hours` (attempts 1, 2, 5, 6 -> 1 h, 2 h, 16 h, 24 h).
- `conversionSetup endpoint is owner only` (ADMIN_ROLE_TABLE row).
- leads-db: `conversion_setup` in the table list and in `ANJUNA_TABLES`; new test `conversion_setup CHECKs reject a bad name, account and action id`.

Commit: `feat(contracts): conversion setup contract and migration (FUS-384)`.

Review Focus T1: name regex identical in zod and SQL; union really excludes both or neither field; no change to existing exports.

## Task 2: core endpoints and admin read

Files: `workers/core/src/conversion-setup.ts` (new), `workers/core/src/index.ts` (3 route lines + import), `workers/core/src/admin/index.ts` (route for `conversionSetup`, extend the `writeAudit` action union only if reused; prefer a local insert in conversion-setup.ts), `workers/core/test/conversion-setup.test.ts` (new). Use the test harness of `workers/core/test/drain.test.ts` and `spend.test.ts`.

Behavior: spec sections 3, 4 and 5 exactly.
- Claim is one statement: `INSERT INTO conversion_setup (...) SELECT ... FROM brand_runtime WHERE brand_id = ?1 AND google_ads_account IS NOT NULL AND google_conversion_action IS NULL ON CONFLICT (brand_id) DO UPDATE SET ... WHERE <eligibility on the existing row> RETURNING ...`. Name rule inside the statement: keep the stored name when `conversion_setup.account = excluded.account`, else take the proposed name and reset attempts to 0.
- Result id path: one `env.LEADS.batch` that updates `conversion_setup` (guarded by `claim_id` and `status = 'claimed'`) and `brand_runtime` (guarded by `google_conversion_action IS NULL AND google_ads_account = <claimed account>`). Then the Factory audit insert. Decide the response from the two change counts.
- Admin `GET /admin/brands/:id/conversion-setup`: 404 for an unknown brand, state per spec section 6.

Tests (names):
- `setup endpoints answer 401 without the drain token and ignore ?token=` (all three).
- `pending lists brands with an account and no conversion action, ordered, with stored name`.
- `pending skips a live claim, a brand with an action and a failed row before next_attempt_at`.
- `claim stores the name and a second claim answers 409 busy`.
- `claim of a stale claimed row (31 minutes) succeeds and keeps the stored name`.
- `claim after the account changed resets attempts and takes the proposed name`.
- `claim of an unknown brand answers 404 and a bad name 400`.
- `result with an id sets google_conversion_action, bumps updated_at, writes one audit row`.
- `repeating the same id result answers already true and writes no second audit row`.
- `result with a wrong claim_id answers 409 stale and writes nothing`.
- `result with an id after the action was set by hand answers 409 stale and keeps the hand-set value`.
- `failed result increments attempts, sets backoff and an audit row; the 5th failure stops further claims`.
- `routing includes the brand after a created result`.
- `admin conversion-setup returns none, pending, created and failed states; employee gets 403`.

Commit: `feat(core): drain endpoints to auto-create conversion actions (FUS-384)`.

Review Focus T2: claim atomicity (one statement, no SELECT then UPDATE), no duplicate audit on repeats, the brand_runtime write guarded by NULL and account, 413 body limit, no `?token=`.

## Task 3: drain script

Files: `scripts/drain/conversion-sync.mjs` (new), `scripts/test/drain-conversion-sync.test.ts` (new), `scripts/test/fixtures/adkit-conversions-list.txt` and `adkit-conversion-create.txt` (new), `scripts/drain/scheduler.mjs`, `scripts/drain/run.sh`, `scripts/drain/README.md`.

Behavior: spec sections 2, 3 and 7. Mirror `spend-sync.mjs` structure (doc comment, `exec` via `execFile`, injectable `runAdkit` and `fetchImpl`, `main()` guarded by `import.meta.url`). Exports exactly as spec section 7. `generateName(randomBytes = crypto.randomBytes)` takes an injectable byte source.

Wiring: `scheduler.mjs` runs `conversion-sync.mjs` after the routing refresh when `existsSync(join(APP_DIR, "conversion-sync.mjs"))`; it logs the exit code. `run.sh` runs `"$NODE" conversion-sync.mjs` after refresh when the file exists, with `|| echo "[run] conversion sync failed" >&2`. Both then re-read routing as they do today, so the order is refresh, conversion-sync, refresh again only when conversion-sync printed a `created` or `adopted` line (scheduler: exit code 0 and stdout match; run.sh: rerun refresh unconditionally after a successful conversion-sync, it is cheap).

Tests (names):
- `generateName returns cv- plus 16 hex and never contains brand or host text` (fixed bytes).
- `pickUniqueName regenerates on a collision and throws after 5 collisions`.
- `conversionCreateArgs builds manage google conversions create with --data settings, --publish and --json, plus --project`.
- `conversionListArgs builds the list call with --limit 500 and --json`.
- `createdConversionId reads platformId, nested id and a resource name, and rejects non-digits`.
- `syncConversions creates, then records the id with the claim id`.
- `syncConversions adopts an existing conversion with the stored name and runs no create`.
- `syncConversions on a duplicate-name create error lists again and adopts`.
- `syncConversions records a failure and continues with the next brand; exit count 1`.
- `syncConversions skips a busy claim without calling create`.
- `--dry-run prints the planned creates and sends no claim, create or result`.
- `no test spawns adkit`: every test passes `runAdkit`; assert the default runner is never reached by mocking `node:child_process` or by injection only.

Commit: `feat(drain): conversion-sync creates missing conversion actions via AdKit (FUS-384)`.

Review Focus T3: name stored before create, adopt path, duplicate-name recovery, flags in one builder, JSON-tail parse, dry-run writes nothing, scheduler and run.sh keep running when the file is missing or fails.

## Task 4: panel status

Files: `apps/web/src/server/index.ts` (one route), `apps/web/src/client/api.ts` (one function), `apps/web/src/server/mock-core.ts` (fixture route), `apps/web/src/client/screens/ConfigPanel.tsx` (`MoneySection` status line), tests in `apps/web/test/` (`conversion-setup-api.test.ts` new, plus a UI test file next to the existing ConfigPanel UI tests).

Behavior: spec section 6. Owner only through `authorize("conversionSetup", ...)`. The status line loads once when `MoneySection` mounts and again after a money save. A load error shows nothing and logs nothing to the user.

Tests (names):
- `GET /api/brands/:id/conversion-setup forwards to core for the owner and answers 403 for an employee`.
- `money section shows pending, created with name, and failed with error and attempts`.
- `money section shows no status line for none`.

Commit: `feat(web): conversion action status in the money section (FUS-384)`.

Review Focus T4: owner-only path, no secret or AdKit text in the panel, the money form still saves when the status call fails.

## Order

T1 and T3 run first, in parallel. T2 and T4 start after T1 is committed. Each task gets a Codex review. The whole branch gets Claude Opus and Codex reviews before the PR.
