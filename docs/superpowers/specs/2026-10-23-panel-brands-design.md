# Panel brands design (spec C, FUS-377)

Source: ship order step 3 in `2026-10-23-panel-backlog-and-order.md` (backlog items 4, 7, 8, 9 and the debate addition "brand card shows the flow-gate label"). Tracking issue: FUS-377. Builds on spec 1 (FUS-374, merged as PR 142). Runs in parallel with spec B (leads) and spec A (FUS-375, home and conversions).

## Scope

In scope, from the FUS-377 description:

1. Brands list: filter chips (live, paused, failed install, no live domain), sort (issues-first, latest activity, A-Z), search by domain.
2. Deploy history across all brands: every factory install row, not only the latest; rollbacks; config audit rows; one timeline with `started_by`, `started_at`, `finished_at` and the install receipts.
3. Brand card: Copy Final URL with the keyword param, Open site.
4. Revision history per brand from `brand_revisions`, with the rollback target marked.

Out of scope: the Download menu (needs an artifact exposure audit), Duplicate (the button already exists and does not change here), Cloudflare profiles, conversion requeue, the Settings table (ship order step 4).

## Baseline (origin/main b6e307c)

- `apps/web/src/client/screens/BrandLifecycle.tsx` renders the brands table (`table.brand-table`, a main row plus a quiet stats row per brand) and the side panel `LifecycleDetail`. It is not a `DataTable`; FUS-374 did not convert it.
- Row order today: the owner always gets `sortWorstProfitFirst` (`BrandStatsRow.tsx:109`); an employee keeps API order, which is `brands.created_at DESC` (`lifecycle.ts:516`). There is no filter, sort control or search.
- The row already shows the flow-gate label (`flowGateLabel`, `labels.ts`) and Pause/Resume, both added by spec 1.
- `GET /api/brands/:id/installs` already exists (`lifecycle.ts:628`, newest 50 for one brand, `operation` derived by `installOperation`). It is read by `installHistory()` in `BrandLifecycle.tsx:19` only for the accepted-install recovery check, and it is not contract-typed. There is no cross-brand deploy feed and no revisions route.
- `GET /api/installs/:id` returns `InstallWithReceipts` (receipts, `runtime_sync_status`, `recovery_required`).
- Shared components available from spec 1: `DataTable`, `StatusBadge`, `ConfirmDialog` (`useConfirm`), `EmptyState`, `Spinner`, `Toast`, `BrandLabel` / `useBrandLabels`, `AppShell` with `pageTitle`, the `useRoute` / `navigate` router. There is no `FilterBar`.
- Factory D1 tables this spec reads: `brands` (`domain` is `NOT NULL UNIQUE`; `status` is one of draft, installing, live, paused, failed, retired), `brand_revisions` (`revision`, `template_version_id`, `form_artifact_id`, `worker_version_id`, `created_by`, `created_at`), `installs` (`kind` in install, rollback, upgrade; `status` in queued, running, ready, failed, rolled_back; `from_revision_id`, `to_revision_id`, `is_canary`, `started_by`, `started_role`, `started_at`, `finished_at`, `error`), `install_receipts`, `audit_log`.
- The brand Worker reads the keyword from `?keyword=` for both flow-gate modes (`packages/brand-runtime/src/worker.ts:30`), so the Final URL is the same string under `param` and `signed_cookie`.

## Decisions

### D1. "No domain" means "no live domain"

`brands.domain` is `NOT NULL UNIQUE` and `LifecycleBrandSummary.hostnames` is `min(1)`, so a brand with no domain string cannot exist. The chip therefore filters brands whose domain is not serving yet: `current_revision_id === null`, i.e. no install ever reached `ready`, so no Custom Domain is attached. Label: `ยังไม่มีโดเมนใช้งาน (No live domain)`.

### D2. Issues-first is the default sort; worst profit stays an owner option

FUS-377 asks for issues-first. Dropping `sortWorstProfitFirst` would regress the FUS-365 loss-first list the owner uses, so it becomes a fourth option, owner-only (an employee has no profit figure). Default for both roles: issues-first.

### D3. The list reads one new field, not a second request

`GET /api/lifecycle/brands` rows gain `latest_install`. Issues-first, the "failed install" chip and the "latest activity" sort all read it. One extra factory query per list load, no extra round trip from the browser.

### D4. The deploy timeline merges three sources and degrades per source

Factory installs and factory brand audit rows come from the panel's own `FACTORY` binding. Config changes to a live brand are audited by core, not by the factory (`audit.ts` header comment), so the timeline also calls core `listAudit` with `target_type=brand`. A core failure returns the factory rows plus `unavailable: ["core_audit"]` instead of failing the response, the same shape of partial answer as `core_error` on the brands list.

**Amendment, after Task 2 (2026-10-23).** The two audit sources need two different action allowlists, because they write different action names. This version of D4 first gave both sources one list built from the factory's actions, which would have let the core source contribute nothing in production and defeated the reason core is read at all.

- Factory (`audit_log` through `env.FACTORY`): `brand.create`, `brand.duplicate`, `brand.draft_update`, `brand.profile.*`, `brand.asset.*`, `checklist.attest`.
- Core (`listAudit`): `brand.update`, `brand.pause`, `brand.resume`. Those are the only brand actions core writes (`workers/core/src/admin/index.ts:272`), and `brand.update` is exactly the live-brand config change this decision exists to show. Pause and resume join it because the brand card already treats Pause/Resume as brand state an operator tracks.

`install.start`, `install.failed`, `redeploy.*` and `upgrade.*` stay excluded from both: the install row already carries each of them, and including them would list every deploy twice.

### D4b. Timestamps on the wire are UTC

`Timestamp` in contracts is `z.iso.datetime()`, which rejects an offset such as `+07:00`. Every writer in the repo produces `new Date().toISOString()`, so stored rows are `Z` and the response parses. The deploy feed still orders by instant, not by text: `julianday(started_at)` in SQL so the `LIMIT` boundary keeps the newest rows, and `Date.parse` in the merge. Text order and instant order can disagree in both directions, and ordering by the raw column could drop a newer row at the `LIMIT` cut.

### D5. No cursor on the deploy feed

Merging three sources makes a keyset cursor wrong at the seam. Each source is queried with its own `LIMIT`, merged, sorted by `started_at DESC` and truncated to `limit`; the response carries `has_more`. The screen says `แสดง <n> รายการล่าสุด` when `has_more` is true. Pagination is listed as out-of-scope follow-up work in the PR.

### D6. Role scope on the timeline

Install rows: employee and owner both see every row. That is already true per brand (`authorizePanel("installBrand")` is `employee`), so a cross-brand view leaks nothing new. Audit rows: owner sees all, an employee sees only their own, matching `/api/audit` (`index.ts`, `ownOnly`) and `listLifecycleAudit`. No money field appears on the timeline, so no owner-only field gating is needed. This is panel role gating, not cloaking: AGENTS.md rule 3 governs brand Worker responses to visitors.

### D7. Copy Final URL is built in the client from the apex hostname

`https://<hostnames[0]>/?keyword={keyword}` with a literal `{keyword}`; Google Ads substitutes it. `Hostnames` in `packages/contracts/src/lifecycle.ts` refines apex-first, so `hostnames[0]` is the apex. The helper is a pure function so it is unit-tested without a DOM.

## Design

### Contracts (`packages/contracts/src/lifecycle.ts`, in one `// spec brands` block)

- Export the existing private `InstallStatus`.
- `DeploySource = z.enum(["install", "audit"])`.
- `DeployEvent` (strict): `source`, `event_id` (install id, or `audit-<id>`), `brand_id`, `operation` (`InstallOperation` or null for audit rows), `action` (audit action string, null for install rows), `status` (`queued | running | ready | failed | rolled_back | done`; audit rows are always `done`), `from_revision_id`, `to_revision_id` (both nullable), `is_canary`, `started_by`, `started_role` (`AuditActorRole`, because `installs.started_role` and `audit_log.actor_role` both allow `system`), `started_at`, `finished_at` (nullable), `error` (nullable).
- `DeployHistoryQuery` (strict, all optional): `brand`, `source`, `status`, `operation`, `limit` (1..200, default 50).
- `DeployHistoryResponse` (strict): `events`, `has_more`, `unavailable` (array of `"core_audit"`).
- `BrandRevision` (strict): `revision_id`, `revision` (int), `template_version_id`, `form_artifact_id`, `bundle_form_version` (nullable), `worker_version_id` (nullable), `created_by`, `created_at`, `is_current`.
- `BrandRevisionsResponse` (strict): `brand_id`, `current_revision_id` (nullable), `rollback_target_revision_id` (nullable), `revisions`.
- `LifecycleBrandSummary` gains optional `latest_install`: `{ install_id, operation, status, started_at, finished_at (nullable), started_by }` or null. Optional keeps every existing fixture and test valid.
- Fixture `packages/contracts/fixtures/admin/deploys.response.json` covers one install, one rollback, one failed install and one audit row.

### Panel server

`apps/web/src/server/deploys.ts` (new), reached from `index.ts` by one added line `const deploys = await handleDeployRoute(...)` next to the other handler calls, in a `// spec brands` block:

- `GET /api/deploys` → `DeployHistoryResponse`. Gate `authorizePanel("installBrand")`. 422 on a bad `DeployHistoryQuery`.
  - Installs: `SELECT install_id, brand_id, kind, status, from_revision_id, to_revision_id, is_canary, started_by, started_role, started_at, finished_at, error FROM installs` with optional `brand_id = ?` and `status = ?`, `ORDER BY started_at DESC, install_id DESC LIMIT ?`. `operation` from the existing `installOperation(kind, brand_id, to_revision_id)`.
  - Factory audit: rows with `entity_type = 'brand'` and an action in `brand.create`, `brand.duplicate`, `brand.draft_update`, `brand.profile.*`, `brand.asset.*`, `checklist.attest`. `install.start`, `install.failed`, `redeploy.*` and `upgrade.*` are excluded because the install row already carries them. An employee adds `actor_id = <self>`.
  - Core audit: `callCore(..., { endpoint: "listAudit", query })` with `target_type=brand` and, for an employee, `actor_id=<self>`. Non-200 or an unparsable body adds `"core_audit"` to `unavailable` and is otherwise ignored.
  - Merge, sort by `started_at` descending then `event_id` descending, slice to `limit`, set `has_more` when any source returned more than it kept.
- `GET /api/brands/:id/revisions` → `BrandRevisionsResponse`. Gate `authorizePanel("installBrand")`. 400 on an undecodable segment, 404 when the brand row is absent. `revisions` newest first from `brand_revisions` joined to `form_artifacts` for `bundle_form_version`, `LIMIT 100`.
- `rollbackTargetRevisionId(db, brandId, currentRevisionId)` moves out of `rollback()` in `lifecycle.ts` into a shared exported helper and both callers use it, so the panel can never show a target the rollback would not pick.

`apps/web/src/server/lifecycle.ts`: `lifecycleBrandRows` gains one query for the newest install per brand and sets `latest_install` on each summary.

```sql
SELECT install_id, brand_id, kind, status, to_revision_id, started_by, started_at, finished_at FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY brand_id ORDER BY started_at DESC, install_id DESC) AS rn FROM installs
) WHERE rn = 1
```

A brand with no install row gets `latest_install: null`. An unmanaged (core-only) brand has no factory install row, so it is also null.

### Client

`apps/web/src/client/brand-health.ts` (new, pure):

- `BrandIssue = "install_failed" | "sync_error" | "install_running" | "no_domain" | "paused"`.
- `brandHealth(brand, runtime)` returns `{ issues: BrandIssue[], severity: number, activityAt: string | null }`.
  - `install_failed`: factory status `failed` or `rolled_back`, or `latest_install.status` is `failed` or `rolled_back`.
  - `sync_error`: `runtime_sync_status === "sync_error"` while the factory status is `live`.
  - `install_running`: factory status `installing`, or `latest_install.status` is `queued` or `running`.
  - `no_domain`: `current_revision_id === null` (D1).
  - `paused`: the core runtime row is paused, or the factory status is `paused`.
  - `severity` is the index of the first matching issue in that order, `99` when there is none.
  - `activityAt` is `latest_install.started_at`, else null.
- `BRAND_CHIPS`: `all`, `live` (no issue and factory status `live`), `paused`, `failed` (has `install_failed`), `no_domain`.
- `matchesBrandSearch(brand, query)`: case-insensitive substring over every hostname, `name` and `brand_id`. A blank query matches everything.
- `sortBrands(rows, mode, profitOf)` with modes `issues`, `activity`, `az`, `profit`. `issues` sorts by `severity`, then `activityAt` descending (null last), then domain A-Z. `activity` sorts by `activityAt` descending, null last, then domain A-Z. `az` sorts by `hostnames[0]`. `profit` delegates to the existing `sortWorstProfitFirst` and is offered to the owner only.

`apps/web/src/client/final-url.ts` (new, pure): `finalUrl(hostnames)` returns `https://<apex>/?keyword={keyword}`, or null when there is no hostname.

`apps/web/src/client/screens/BrandFilters.tsx` (new): chips as `role="group"` with `aria-pressed`, each chip showing its count; a `<select>` for the sort mode; a search `<input type="search">` labelled `ค้นหาโดเมน (Search domain)`. Local to this spec so it cannot collide with a `FilterBar` spec B may add.

`BrandLifecycle.tsx`:
- Renders `BrandFilters` above the table, keeps the period segment and the Refresh / New brand buttons.
- Applies search, then the chip, then the sort, replacing the unconditional `sortWorstProfitFirst` call.
- Filter state lives in `useState`, not the URL. `/brands/:id` stays the only deep link; a filter is a view preference, and putting it in the query string would fight the `:id` navigation spec 1 owns.
- Shows an `EmptyState` when a filter or search hides every brand, with a button that clears the filter. The existing "ยังไม่มีแบรนด์" row still covers the no-brands case.
- A selected brand hidden by a filter stays in the side panel; the side panel is driven by the route, not by the visible rows.

`LifecycleDetail` (same file) adds to `.side-actions`:
- `เปิดเว็บไซต์ (Open site)` as an `<a href="https://<apex>" target="_blank" rel="noopener noreferrer">`.
- `คัดลอก Final URL (Copy Final URL)` calling `navigator.clipboard?.writeText(finalUrl(brand.hostnames))` and raising the existing Toast on success. When the clipboard is unavailable or rejects, the URL is shown in a read-only focused input next to the button and the Toast says to copy it by hand.
- A `ประวัติเวอร์ชัน (Revision history)` section: `revision`, `created_at`, `created_by`, `template_version_id`, `bundle_form_version`, `worker_version_id`; the current revision is marked `ใช้งานอยู่ (Current)` and the rollback target `เป้าหมายการย้อนกลับ (Rollback target)`. Loaded from `/api/brands/:id/revisions` when a brand is selected.
- The Rollback `ConfirmDialog` body names the target revision from the same response.

`apps/web/src/client/screens/Deploys.tsx` (new) at `/deploys`:
- `DataTable` columns: เวลา (`started_at`), แบรนด์ (`BrandLabel`), การทำงาน (`operation` label or the audit `action`), สถานะ (`StatusBadge`), ผู้เริ่ม (`started_by`, role), ใช้เวลา (`finished_at − started_at`, `—` while unfinished), revision (`from → to`, monospace).
- Filters: a brand `<select>` built from `/api/lifecycle/brands`, a source select, a status select.
- An install row expands to its receipts, fetched lazily from `GET /api/installs/:id` and rendered with the existing `InstallProgress` at `canRetry={false}`. An audit row expands to its `old` / `new` field diff.
- `EmptyState` when there are no events; a `hint` line when `has_more`; a line pointing at `/audit` for the full audit log.
- Router: `/deploys` added to `Route`, `STATIC` and `pageTitle`; nav label `ประวัติการติดตั้ง (Deploy history)` placed after `แบรนด์`.

### Not changed

Install, rollback, redeploy, recover, retry, the wizard, `ConfigPanel`, the upgrade-all card, core, the drain, `packages/contracts/src/admin-api.ts`, `workers/core/src/admin/index.ts`.

## Rules check

- Rule 1, V1 parity: the panel is new surface over existing factory rows; no loss-prevention machinery is added.
- Rule 2: no LeadsGate call. The Final URL is the brand's own landing page.
- Rule 3: no response varies by user agent, IP, referrer or gclid. Role gating in the panel is not cloaking.
- Rule 4: no brand bytes change. The copied URL holds only the brand's own domain.
- Rule 5: D1 only; all reads go to the factory D1 and to core over the admin contract.
- Rule 6: no secrets; no new config.
- Rule 7: no deploys, no real external calls.

## Tests

- Contracts: `DeployEvent` rejects an unknown key and an audit row with a non-null `operation`; `DeployHistoryQuery` coerces and bounds `limit`; the fixture parses; `LifecycleBrandSummary` still parses without `latest_install`.
- Server: `/api/deploys` merges install and audit rows newest first; `brand`, `status` and `source` filters; `limit` and `has_more`; a core failure returns factory rows with `unavailable: ["core_audit"]`; an employee sees every install row but only their own audit rows; 401 without a session.
- Server: `/api/brands/:id/revisions` returns revisions newest first with `is_current` and the rollback target; 404 for an unknown brand; the target equals what `POST /api/brands/:id/rollback` picks.
- Server: `/api/lifecycle/brands` carries `latest_install` for the newest install, null for a brand with none, and breaks a `started_at` tie by `install_id`.
- Client unit: every `brandHealth` issue branch; chip counts; `matchesBrandSearch`; each `sortBrands` mode including null `activityAt`; `finalUrl`.
- Client UI: a chip filters the rows; search filters by domain; each sort order; the profit option is owner-only; the empty-filter `EmptyState` clears; Copy Final URL writes `https://<apex>/?keyword={keyword}` to the clipboard and falls back to a read-only input when the clipboard throws; Open site has the apex href with `rel="noopener noreferrer"`; the revision list marks the current revision and the rollback target; the Rollback confirm names the target.
- Client UI: the deploys screen renders a merged timeline, filters by brand, expands an install row to its receipts, and shows the `has_more` hint.
- Routing: `/deploys` parses, deep links, and round-trips through `routePath`.
- Existing `apps/web/test/*.ui.test.tsx` stay green, including `brands-page.ui.test.tsx`, whose expected row order changes from worst-profit to issues-first.

## Verification

- `bun run typecheck` and `bun run test` at the repo root green.
- Muse reviews the markup of the brands list and the deploys screen once before the PR.
- `git fetch origin && git rebase origin/main`, then typecheck and test again.
