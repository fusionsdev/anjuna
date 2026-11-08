# Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Home and Brands flow where a brand goes from create to Google Ads conversion upload without leaving the panel, with correct money and AdKit wired in through a VPS job queue.

**Architecture:** Panel (React SPA plus Worker in `apps/web`) keeps its routes and gets regrouped navigation. Money becomes currency-aware in `ad_spend` and in the panel server. AdKit work flows panel D1 job, VPS executor, result ingest. Workers never call AdKit.

**Tech Stack:** Bun workspaces, Turborepo, TypeScript strict, React 19, Vitest (jsdom UI tests, Miniflare worker tests), D1 migrations.

**Spec:** `docs/superpowers/specs/2026-11-07-panel-redesign-design.md`

## Global Constraints

- One task = one branch = one PR. Branch from `main`. Name `panel-<task-slug>` unless a Linear issue exists. (AGENTS.md)
- Done means: task tests, `bun run typecheck`, `bun run test` green. PR body maps each acceptance line to a test name or command output.
- No deploy, no real LeadsGate or AdKit call, no drain contact in tests. AdKit tests run with an empty `PATH` and fixtures (pattern in `scripts/test/drain-spend-sync.test.ts`).
- No response may vary by user agent, IP, ASN, referrer, gclid or bot detection.
- Brand bytes stay clean: nothing a brand serves contains "anjuna", "aurum", a PostHog key or a Sentry DSN.
- Revenue, profit and cost in USD are owner only and are removed from the payload on the server for other roles, never only hidden in the UI.
- UI copy is Thai. No English in parentheses after Thai labels.
- Light theme tokens: page `#F6F6F4`, card `#FFFFFF`, border `#E0E0DC`, text `#111111`, secondary `#6B6B70`, accent `#F83808`, radius 16px.
- Merge only on green checks (`gh pr merge` gated with `&&`). Owner standing approval covers merge and deploy of green PRs.

## Review Focus

1. Baht and dollars mixed in one number: profit, CPL and any sum across brands (expected: every sum is in one currency, labelled).
2. Employee payload contains `revenue`, `profit_usd`, `cost_usd` or payout (expected: absent from JSON, not only hidden).
3. Double click or wrong-brand click on a Home action (expected: dialog names brand and domain, second click while pending does nothing).
4. Stale AdKit data (expected: "—", never a number from yesterday).
5. VPS retries an AdKit job (expected: same idempotency key, one conversion action or campaign).
6. Deleting a template a brand uses (expected: refused, offer archive).

---

### Task 0: ADR 0005 and brief amendment

**Files:**
- Create: `docs/adr/0005-adkit-via-vps-executor.md`
- Modify: `docs/PRODUCT-BRIEF.md:46`, `AGENTS.md` (line 3 sentence about the drain)

**Interfaces:**
- Produces: the written rule "panel writes jobs, VPS executes `adkit`, Workers hold no AdKit key; campaigns are drafts until an owner enables them".

- [ ] **Step 1: Write ADR** with context, decision (spec section "AdKit"), consequences, rejected option (Worker calls AdKit with an API key).
- [ ] **Step 2: Replace the non-goal** at `PRODUCT-BRIEF.md:46` with a pointer to ADR 0005.
- [ ] **Step 3: Commit** `docs(adr): AdKit via VPS executor`.

### Task 1: Currency-aware spend (PR 0)

**Files:**
- Create: `packages/leads-db/migrations/0019_ad_spend_currency.sql`, `apps/web/src/server/money.ts`, `apps/web/test/money.test.ts`
- Modify: `packages/contracts/src/spend.ts`, `workers/core/src/spend.ts`, `scripts/drain/spend-sync.mjs`, `apps/web/src/server/index.ts` (the `/api/spend` route), `apps/web/src/client/screens/Home.tsx`, `apps/web/src/client/home-metrics.ts`
- Test: `workers/core/test/spend.test.ts`, `scripts/test/drain-spend-sync.test.ts`, `apps/web/test/money.test.ts`, `apps/web/test/home.ui.test.tsx` (verify the existing Home test file name with `ls apps/web/test | grep -i home`)

**Interfaces:**
- Produces: column `ad_spend.currency TEXT NOT NULL DEFAULT 'THB'` (legacy rows are baht). Contract field `currency: z.enum(["THB","USD"])` on each ingest row and each report brand row.
- Produces: `toUsd(amount: number, currency: "THB" | "USD", thbPerUsd: number): number` in `money.ts`. Throws on `thbPerUsd <= 0`.
- Produces: `/api/spend` response adds `cost_usd` per brand and `total_cost_usd`, owner only, and `fx: { thbPerUsd: number }`.
- Produces: settings key `fx_thb_per_usd`, default `35`, owner edit only. Reuse the settings store used by the click-loss setting in `apps/web/src/server/settings.ts` (check how existing keys are declared).

- [ ] **Step 1: Failing tests.** `money.test.ts`: `toUsd(12448, "THB", 35)` is `355.66` to 2 decimals; `toUsd(5, "USD", 35)` is `5`; `toUsd(1, "THB", 0)` throws. `spend.test.ts`: ingest a row with `currency: "THB"`, report returns it; a row without currency is stored as `THB`.
- [ ] **Step 2: Run** `cd workers/core && bunx vitest run test/spend.test.ts` and `cd apps/web && bunx vitest run test/money.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the migration and contract change.** Verify first which AdKit output carries currency: open `scripts/test/fixtures/adkit-results-hour.txt`. If the field is absent, `spend-sync.mjs` reads currency from `adkit manage google accounts list` and caches it per account.
- [ ] **Step 4: Implement `toUsd` and the `/api/spend` fields.** Owner check uses the existing role helper in `panel-roles.ts`.
- [ ] **Step 5: Home shows `฿` for spend and CPL, `$` for revenue, and profit in USD from the server.** Test: employee session JSON has no `cost_usd`.
- [ ] **Step 6: Run** `bun run typecheck && bun run test`. Expected: PASS.
- [ ] **Step 7: Commit** `fix(spend): store account currency and compute USD profit on the server`.

### Task 2: Navigation regroup to 7 items

**Files:**
- Create: `apps/web/src/client/components/SectionTabs.tsx`
- Modify: `apps/web/src/client/App.tsx:75-91` (nav array), `apps/web/src/client/components/SidebarNav.tsx`, `apps/web/src/client/router.ts` (no new routes; old paths stay valid)
- Test: `apps/web/test/app-shell.ui.test.tsx`, `apps/web/test/section-tabs.ui.test.tsx`

**Interfaces:**
- Produces: `SectionTabs({ tabs: { id: View; label: string }[]; active: View; onSelect: (id: View) => void })`.
- Produces: nav items `home`, `brands`, `templates`, `traffic`, `leads`, `alerts`, `settings`. Each item has `activeFor: View[]` (for example `traffic` is active for `traffic`, `funnel`, `errors`; `brands` for `brands`, `new-brand`, `deploys`, `brand-timeline`; `leads` for `leads`, `conversions`; `settings` for `settings`, `users`, `audit`, `mailing`, `suppressions`, `builder-keys`).

- [ ] **Step 1: Failing test.** Visible nav labels for an owner are exactly `["หน้าแรก","แบรนด์","เทมเพลต","ทราฟฟิก","ลีดและคอนเวอร์ชัน","การแจ้งเตือน","ตั้งค่า"]`. Visiting `/funnel` marks "ทราฟฟิก" active. An employee does not see owner-only tabs (users, suppressions).
- [ ] **Step 2: Run** `cd apps/web && bunx vitest run test/app-shell.ui.test.tsx test/section-tabs.ui.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement `SectionTabs` and render it at the top of the Traffic, Leads and Settings screens** (tab lists per `activeFor`).
- [ ] **Step 4: Run** the two files, then `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): group the 17 menu items into 7 with section tabs`.

### Task 3: Brands screen cleanup

**Files:**
- Modify: `apps/web/src/client/lifecycle-state.ts`, `apps/web/src/client/screens/BrandFilters.tsx`, `apps/web/src/client/screens/BrandLifecycle.tsx`, `apps/web/src/client/components/RowMenu.tsx`, `apps/web/src/client/screens/Brands.css`
- Test: `apps/web/test/brand-row-actions.ui.test.tsx`, `apps/web/test/brands-filter.ui.test.tsx`

**Interfaces:**
- Produces: `nextAction(row: LifecycleRow, role: Role): { kind: "install" | "retry" | "approve-template" | "set-route" | "test-sold" | "open" | "resume"; label: string }`.
- Produces: four filter chips with ids `needs-fix`, `live`, `unfinished`, `paused`, plus the existing all view. Demo brands (name matches `^demo\d+`) hidden unless the checkbox "แสดงแบรนด์ทดลอง" is on.

- [ ] **Step 1: Failing tests.** `nextAction` table: failed install gives `retry`, no drain route gives `set-route`, live and healthy gives `open`, paused gives `resume`. Row renders one primary button, the rest inside `RowMenu`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove English in parentheses from the chip and header labels. Cards under 768 px for rows (CSS only).
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): one next-step button per brand row and four filter chips`.

### Task 4: Home v2

**Files:**
- Modify: `apps/web/src/client/screens/Home.tsx`, `apps/web/src/client/screens/Home.css`, `apps/web/src/client/home-metrics.ts`
- Create: `apps/web/src/client/screens/home/IncidentBanner.tsx`, `NeedsFixList.tsx`, `HumanTasks.tsx`, `BrandRows.tsx`
- Test: `apps/web/test/home.ui.test.tsx`

**Interfaces:**
- Consumes: `nextAction` (Task 3), `/api/spend` with `currency` and `cost_usd` (Task 1), `api.alerts`, `api.lifecycleBrands`, `api.funnel`.
- Produces: `isStale(updatedAt: string, now: Date, maxHours = 2): boolean` in `home-metrics.ts`. `clickLossWarning(paidClicks: number, reachedSite: number): boolean` true when `reachedSite / paidClicks < 0.05` and `paidClicks >= 20`.
- Default range `today`, compared with `yesterday` (`previousRange()` already exists).

- [ ] **Step 1: Failing tests.** `isStale("...T10:00:00Z", 12:30Z)` is true. `clickLossWarning(170, 141)` false, `clickLossWarning(170, 4)` true, `clickLossWarning(10, 0)` false. Home order in DOM: banner, needs-fix, human tasks, KPIs, brand rows. Stale brand row shows "—" in spend, leads cost.
- [ ] **Step 2: Run** `cd apps/web && bunx vitest run test/home.ui.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the four sub-components. A missing value renders "—". Batch the per-brand checklist reads into one panel endpoint `GET /api/brands/checklists` (Home calls N today) in `apps/web/src/server/index.ts`.
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): home as a work queue with brand rows`.

### Task 5: Actions on Home through one dialog

**Files:**
- Create: `apps/web/src/client/useBrandActions.ts`
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (extract handlers), `apps/web/src/client/screens/home/HumanTasks.tsx`, `NeedsFixList.tsx`
- Test: `apps/web/test/brand-actions.ui.test.tsx`

**Interfaces:**
- Produces: `useBrandActions(): { run(action: "test-sold" | "retry-install" | "approve-template" | "set-route", brand: { id: string; name: string; domain: string }): Promise<void>; pending: ReadonlySet<string> }`. Opens `ConfirmDialog` whose text contains `brand.name` and `brand.domain`. Role gating stays on the server (`panel-roles.ts`).

- [ ] **Step 1: Failing tests.** Dialog text contains name and domain. Second `run` for the same brand and action while pending sends one request. An employee `approve-template` is disabled with the server's 403 shown as a toast.
- [ ] **Step 2: Run** `bunx vitest run test/brand-actions.ui.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Extract and implement.** Batch confirm for "Test sold" accepts a list and sends one request per brand sequentially, stopping on the first failure.
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): home actions with named confirm dialog`.

### Task 6: Brand detail checklist and ad numbers

**Files:**
- Modify: `apps/web/src/client/screens/ConfigPanel.tsx`, `apps/web/src/client/screens/BrandLifecycle.tsx`, `apps/web/src/server/drain-route-checklist.ts`
- Test: `apps/web/test/config-panel-conversion.ui.test.tsx`, `apps/web/test/drain-route-checklist.test.ts` (verify name)

**Interfaces:**
- Produces: checklist rows `final_url`, `leadsgate_postbacks`, `test_sold`, `drain_route` each `{ done: boolean; evidence: string | null }`. If `leadsgate_postbacks` or `test_sold` have no computed row today, add them to the lifecycle checklist response.

- [ ] **Step 1: Failing test.** Failing step shows its fix button inside the step. AdKit block shows "—" when stale.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement the right panel** from the Brands mock page.
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): brand step checklist panel`.

### Task 7: Upgrade-all picker in Settings

**Files:**
- Create: `apps/web/src/client/screens/UpgradeWizard.tsx`
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx:767` (remove the card), `apps/web/src/client/screens/Settings.tsx`
- Test: `apps/web/test/upgrade-wizard.ui.test.tsx`

**Interfaces:**
- Consumes: existing `api.upgradeAll(body)` and `api.templates()`. Request body unchanged.

- [ ] **Step 1: Failing test.** The wizard sends the same body as the old card using selected versions. Owner only.
- [ ] **Step 2: Run, implement, run.** Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): upgrade-all picker moves to settings`.

### Task 8: Spend deltas and daily series

**Files:**
- Modify: `packages/contracts/src/spend.ts`, `workers/core/src/spend.ts`, `workers/core/test/spend.test.ts`, `apps/web/src/client/screens/Home.tsx`

**Interfaces:**
- Produces: `SpendQuery` accepts `period: "today" | "yesterday" | "7d" | "30d"`. Report adds `daily: { date: string; cost: number; currency: "THB" | "USD" }[]`.

- [ ] **Step 1: Failing core tests** for `yesterday` and `daily[]` ordering ascending.
- [ ] **Step 2: Implement, run, commit** `feat(core): spend yesterday period and daily series`. Home shows sparklines from `daily`.

### Task 9: AdKit directory sync and job queue

**Files:**
- Create: `packages/leads-db/migrations/0020_adkit_directory_jobs.sql`, `scripts/drain/adkit-directory-sync.mjs`, `scripts/drain/adkit-executor.mjs`, `workers/core/src/adkit.ts`, `packages/contracts/src/adkit.ts`
- Test: `workers/core/test/adkit.test.ts`, `scripts/test/adkit-executor.test.ts`

**Interfaces:**
- Tables: `adkit_directory(kind TEXT CHECK (kind IN ('project','account','conversion_action')), id TEXT, parent_id TEXT, name TEXT, currency TEXT, updated_at TEXT, PRIMARY KEY (kind, id))` and `adkit_jobs(id TEXT PRIMARY KEY, kind TEXT, payload TEXT, status TEXT CHECK (status IN ('queued','claimed','done','failed')), result TEXT, attempts INTEGER, idempotency_key TEXT UNIQUE, requested_by TEXT, created_at TEXT, updated_at TEXT)`.
- Core routes, drain-token auth, header only: `POST /api/adkit/directory/ingest`, `GET /api/adkit/jobs/pending`, `POST /api/adkit/jobs/claim`, `POST /api/adkit/jobs/result`. Admin routes: `GET /admin/adkit/projects`, `GET /admin/adkit/projects/:p/accounts`, `GET /admin/adkit/accounts/:a/conversion-actions`, `POST /admin/adkit/jobs` (`{ kind: "conversion_action.create", brand_draft_id }`, owner or scoped key).
- Executor allowlist: `accounts list`, `conversions list`, `results list`, `conversions create`. Anything else is rejected before spawning.

- [ ] **Step 1: Failing tests.** Same `idempotency_key` posted twice yields one row. Claim is atomic (two claims, one wins). Executor rejects `campaigns update`. Fixture-driven `conversions create` result becomes `done` with `result.conversion_action_id`.
- [ ] **Step 2: Run** `cd workers/core && bunx vitest run test/adkit.test.ts` and the executor test. Expected: FAIL.
- [ ] **Step 3: Implement** following the pending/claim/result pattern in `workers/core/src/conversion-setup.ts`.
- [ ] **Step 4: Run** `bun run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): AdKit directory and job queue`. No VPS deploy in this PR. Executor install is owner-run (Wave 4 gate).

### Task 10: Wizard step 4 from AdKit, API v1

**Files:**
- Modify: `apps/web/src/client/wizard/StepPanels.tsx`, `apps/web/src/client/wizard/steps.ts`, `apps/web/src/client/wizard/messages.ts`, `apps/web/src/server/lifecycle.ts`, `apps/web/src/server/index.ts`, `apps/web/src/server/panel-roles.ts`
- Create: `apps/web/src/server/api-v1.ts`, `apps/web/test/api-v1.test.ts`
- Test: `apps/web/test/wizard-step4.ui.test.tsx`

**Interfaces:**
- Consumes: Task 9 admin routes.
- Produces: `POST /api/v1/brands/drafts`, `PATCH /api/v1/brands/:id/draft`, `GET /api/v1/adkit/projects`, `GET /api/v1/adkit/projects/:p/accounts`, `POST /api/v1/adkit/conversion-actions`, `POST /api/v1/brands/:id/generate`. Auth: bearer key, same hashing as builder keys (`BuilderKeys` in `workers/template-mcp`), scopes `brand:draft`, `adkit:read`, `adkit:conversion`, `brand:generate`. Microsoft account field removed from the wizard.

- [ ] **Step 1: Failing tests.** Key without `brand:generate` gets 403 on generate. Draft created with a key has every wizard field set. Step 4 renders selects from the directory and no text input for account or project.
- [ ] **Step 2: Run, implement, run, commit** `feat(web): wizard step 4 from AdKit and /api/v1`.

### Task 11: Template manager

**Files:**
- Create: `packages/factory-db/migrations/00NN_template_categories.sql` (next number in that folder), `apps/web/src/client/screens/TemplateCategories.tsx`
- Modify: `apps/web/src/client/screens/Templates.tsx`, `apps/web/src/server/index.ts`
- Test: `apps/web/test/templates-manage.ui.test.tsx`, `apps/web/test/templates-manage-api.test.ts`

**Interfaces:**
- Tables: `template_categories(id TEXT PRIMARY KEY, name TEXT UNIQUE, sort INTEGER)`, `template_category_map(template_id TEXT PRIMARY KEY, category_id TEXT)`. Sealed template rows are not altered.
- Routes: `POST /api/templates/categories`, `PATCH /api/templates/:id/category`, `POST /api/templates/:id/archive`, `DELETE /api/templates/:id` (409 when any brand references it or it was ever approved).

- [ ] **Step 1: Failing tests.** Delete of a used template is 409. Delete of a never-approved unused draft is 204. Archive hides from the brand picker, brands keep working.
- [ ] **Step 2: Run, implement, run, commit** `feat(web): template categories, archive and guarded delete`.

### Task 12: Googlebot counting and alert

**Files:**
- Modify: `packages/brand-runtime/src/` (request logging hook, find the Worker entry), `workers/core/src/` (new rpc `bot-hit`), `workers/core/src/admin/alerts.ts` (verify), `apps/web/src/client/screens/Traffic.tsx`
- Test: `packages/brand-runtime/test/bot-log.test.ts`, `workers/core/test/bot-hit.test.ts`

**Interfaces:**
- Produces: `classifyUserAgent(ua: string | null): "human" | "googlebot" | "adsbot" | "other-bot"` (pure). Matches `Googlebot`, `AdsBot-Google`, `Mediapartners-Google`, `Google-InspectionTool`.

- [ ] **Step 1: Failing tests.** Same HTML bytes for a Googlebot request and a human request (cloaking guard). Hit with `adsbot` creates an alert row once per brand per hour.
- [ ] **Step 2: Implement** the log as fire-and-forget (`ctx.waitUntil`). Brand bytes stay clean.
- [ ] **Step 3: Run, commit** `feat: count Googlebot and AdsBot hits server side`.

### Task 13: V2 (separate plan)

Campaigns screen, AdKit Terminal and campaign draft jobs reuse Task 9 queue. Written as its own spec after Tasks 0 to 10 ship.

---

## Self-review

- Spec coverage: menu (T2), Home (T4, T5), money (T1, T8), AdKit queue (T0, T9), wizard and API (T10), templates (T11), Googlebot (T12). Campaigns and Terminal deferred by spec.
- Open check before T1: where currency comes from in AdKit output. Marked in T1 step 3.
- Unverified names (marked "verify"): `home.ui.test.tsx`, `drain-route-checklist.test.ts`, `Settings.tsx`, `Traffic.tsx`, `alerts.ts`, factory-db migration number.
