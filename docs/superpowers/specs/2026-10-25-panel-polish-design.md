# Panel polish design (spec 7, FUS-382)

Source: the 2026-10-25 audit of the panel backlog (`2026-10-23-panel-backlog-and-order.md`), 8 items the owner approved on 2026-10-25. Tracking issue: FUS-382. Builds on the merged panel specs: shell (PR 142), leads (143), brands (144), home and conversions (145), settings (146), timeline (147), traffic (148). Baseline: origin/main 8d63efb.

Parallel lane FUS-381 (brand colors) touches `brand-runtime`, the contracts theme fields, the wizard Template step, the `SettingsEditor` color fields and the template Approve mapping UI. This spec owns the Template Approve confirm (item 8). It does not touch `brand-runtime`, the wizard Template step or `SettingsEditor.tsx`.

## Scope and PR split

| PR | Branch | Items |
|---|---|---|
| 1 | `fus-382-panel-polish` | 2 (audit paging, audit search), 3 (load more), 6 (raw ids), 8 (small items, mock bindings) |
| 2 | `fus-382b-users-suppressions` | 1 (users admin), 7 (suppressions add/remove, actor filter), Users search from item 2 |
| 3 | `fus-382c-mobile-row-actions` | 4 (mobile 375 px), 5 (brand row actions) |

Each PR branches from fresh origin/main after the previous one merges. PR 3 does not depend on PR 2 and may start once PR 1 merges.

Out of scope (blocked list in the audit): LP wizard data, Download, the `aurum-14-step` rename, conversion requeue, passive bot logging, multi-network server post. Also out of scope: Mailing search (D2.4), a real brand delete (D8.3).

## Baseline facts

- `/api/audit` (`apps/web/src/server/index.ts:213-238`) merges core `listAudit` rows with the panel's own `listPanelAudit` and `listLifecycleAudit` rows (`apps/web/src/server/audit.ts:81,109`). Core and the panel share the factory `audit_log` table in production, so ids are one autoincrement sequence. When a cursor is set, the route skips the local rows (`skipLocal`, :229). It returns core's `next_cursor` as is. The client (`api.audit()`, `api.ts:164`) asks for `limit=100` once and drops `next_cursor`. `Audit.tsx:15` prints `actor_id`.
- Core cursors are `btoa(String(id))` without padding (`workers/core/src/admin/index.ts:1037`). Mock core `listAudit` always answers `next_cursor: null` (`mock-core.ts:343`).
- `AuditQuery` holds `limit`, `cursor`, `actor_id`, `target_type`, `target_id`. An employee is scoped to their own rows.
- Deploys: server default 50 rows (`server/deploys.ts:34`), query `limit` max 200, response `has_more`. Timeline: default 100 (`server/timeline.ts:28`), `limit` max 200 (`shared/timeline.ts:102`), `has_more`. Conversions: core `CONVERSIONS_ROW_LIMIT = 200` (`packages/contracts/src/conversions.ts:14`), `ConversionsQuery` has no limit, response `truncated`. ClientErrors.tsx:57-88 holds the only Load more today.
- Raw ids: `BrandLifecycle.tsx:487` and `:536` show `brand.name` before the domain; the detail header `:603` shows `brand.name` and `brand_id`. `ConfigPanel.tsx:58` titles the loading drawer with `brandId`.
- `Templates.tsx:39-52` approves with no confirm, from the card (:124) and the detail (:187).
- `ConfigPanel.tsx:218-257` (`AbSection`) edits A/B weights. `SettingsEditor.tsx:121-161` is the full A/B editor (spec 4).
- `DELETE /api/brands/:id` is a stub at `server/lifecycle.ts:576-579` answering 501. No client calls it. Core and the factory have no brand delete.
- `env.ts:8-16` declares optional bindings `CORE_LIFECYCLE`, `FACTORY_WORKER`, `TEMPLATE_MCP`. With `MOCK_CORE=1` and no bindings, `/brands` shows the core error banner (lifecycle.ts:491), `/deploys` reports `core_audit` unavailable or install dispatches fail with 502, and template import answers 502.
- Users: `GET/POST /api/users`, `PATCH /api/users/:id` (index.ts:241-295), audited with `writePanelAudit` (prefix `user.`). The auth DB (better-auth 1.7.7 with the admin plugin) has `user.banned`, `banReason`, `banExpires`, a `session` table and `account.password`. Only sign-in, sign-out and get-session pass `AUTH_ALLOWED` (index.ts:67); admin work calls `auth.api.*` on the server, as `setRole` does (:284). better-auth 1.7.7 exposes `banUser`, `unbanUser`, `removeUser`, `setUserPassword`, `listUserSessions`, `revokeUserSession`, `revokeUserSessions`.
- Suppressions: owner-only list through core `listSuppressions` (q, reason, source, cursor). Table `suppressions` in the LEADS D1 has no actor column. The only writer is the listmonk sync (`packages/mailing/src/index.ts:163`, upsert at :195). Core audit rows for suppressions never hold an address (comment at `workers/core/src/admin/index.ts:1019`).
- `DataTable` (`components/DataTable.tsx`) has no mobile mode. `.tw` scrolls sideways. The shell drawer breakpoint is `max-width: 767px` (styles.css:98). No shared filter component exists. Settings.tsx:205 puts Edit in the 11th column, off screen at 375 px.
- The brand row (`BrandLifecycle.tsx:536-542`) has only Pause/Resume. The detail panel (`LifecycleDetail`, :596-616) holds Install, Rollback, Redeploy, Redeploy with latest form, Recover, Duplicate, Timeline, Open site, Copy Final URL, Runtime config. All go through `dispatchOperation` (:310) gated by `lifecycleMutationAvailability`.

## Decisions, PR 1

### D2.1 Audit paging is correct across all sources

`/api/audit` moves out of `index.ts` into `apps/web/src/server/audit-route.ts` (`// spec polish`); index.ts keeps one `handleAuditRoute` call in place of the block.

1. Decode `cursor` with the core format into `beforeId`. A bad cursor answers 422 `invalid`.
2. Core gets the same query (cursor included). Local `listPanelAudit` and `listLifecycleAudit` gain an optional `beforeId` and return rows with `id < beforeId`. They run on every page, not only page 1. The `target_type` skip rule stays.
3. Merge, dedupe by id, sort by `id` descending (one sequence), slice to `limit`.
4. `next_cursor` is the encoded id of the last returned row when more rows exist in any source (merged length > limit, or core `next_cursor` not null); else null.

Mock core `listAudit` honours `cursor`, `limit` and its filters and returns a real `next_cursor`, so the paging is testable.

### D2.2 Audit screen: Load more, filters, names

- Load more: a "โหลดเพิ่ม (Load more)" button under the table appends the next page while `next_cursor` is set (the shared `LoadMore`, D3.1).
- Filters (owner only): actor select (users from `api.users()`, plus "ระบบ (system)"), target type select (`brand`, `user`, `template`, `suppression`, the values core writes), target id text. For target type `brand`, a domain select from `useBrandDomains` fills `target_id` with the brand id. A filter change reloads from page 1. An employee sees no filter bar; their rows are already their own.
- Actor names: the actor cell shows the user's name and email when known (owner: from `api.users()`; employee: their own `me`), "ระบบ (system)" for `actor_role: "system"`, else the raw id in small monospace with the title "ผู้ใช้ที่ถูกลบ (Deleted user)".
- The target cell for a brand row uses `BrandLabel`.

### D2.3 Users search moves to PR 2

The Users screen changes in PR 2; its search box ships there (D1.6).

### D2.4 Mailing search is not built

The Mailing screen shows four counts and no list. `MailingStatusResponse` is documented as never holding an address. A search needs a new list of email addresses visible to employees. That is a new PII surface, so it waits for an owner decision (status.md, NEEDS OWNER). Suppressions already has search.

### D3.1 Load more on Deploys, Timeline and Conversions

One shared component `components/LoadMore.tsx`:

```ts
LoadMore({ shown, hasMore, atMax, loading, onMore, narrowHint }: { shown: number; hasMore: boolean; atMax: boolean; loading: boolean; onMore: () => void; narrowHint: string })
```

- `hasMore && !atMax`: a button "โหลดเพิ่ม (Load more)", disabled with "กำลังโหลด…" while loading.
- `hasMore && atMax`: the text "แสดง {shown} รายการ ซึ่งเป็นจำนวนสูงสุด {narrowHint}".
- `!hasMore`: nothing.

The three screens grow the request `limit` and re-fetch; the merged sources keep their order and no row is skipped or duplicated:

| Screen | Start | Step | Max | More flag |
|---|---|---|---|---|
| Deploys | 50 | 50 | 200 | `has_more` |
| Timeline | 100 | 100 | 200 | `has_more` |
| Conversions | 200 | 200 | 1000 | `truncated` |

A filter change resets the limit to the start value. A response that arrives after a newer request is dropped (generation counter, as ClientErrors.tsx:59 does). The existing "แสดง N รายการล่าสุด" notes are replaced by `LoadMore`.

Conversions needs a contract and core change: `ConversionsQuery` gains `limit` (integer 1 to 1000, default `CONVERSIONS_ROW_LIMIT`). Core `conversions-report.ts` uses it in place of the constant (`LIMIT limit+1`, slice, `truncated`). The panel proxy passes it through. Mock core slices its fixture by `limit` and sets `truncated`.

### D6.1 Domain first on brand rows and the detail header

- Row (:487, :536): bold `hostnames[0]` (fallback `brand.name`, then `brand_id`), then `brand.name` in small muted text when set and different.
- Detail header (:603): h2 is `hostnames[0]`; the subtitle is `brand.name` when set. The raw `brand_id` leaves the header; it stays in `BrandLabel`'s small monospace code.

### D6.2 ConfigPanel loading title

While the brand loads, the drawer title is the domain from `useBrandDomains()` when known, else "กำลังโหลด… (Loading)". Never the `brand_id`.

### D8.1 Template Approve asks first

`Templates.tsx` `approve(id)` calls `useConfirm` before `api.approveTemplate`: title "อนุมัติเทมเพลต (Approve template)?", body the template name and version, confirm label "อนุมัติ (Approve)", tone default. Cancel sends no request. Both the card and the detail button go through it.

### D8.2 ConfigPanel A/B points to Settings

`AbSection` and its weight editor are removed from `ConfigPanel.tsx`. In its place, for a user who passes `can(me, "ab_weights")`, a read-only line shows the A/B summary ("ปิด (Off)" or experiment id and arms with weights) and a link "แก้ไขใน Settings (Edit in Settings)" to `/settings?brand=<brand_id>`. `Settings.tsx` reads `brand` from the query once on load and opens that brand's editor drawer when the row loaded. `SettingsEditor.tsx` does not change.

### D8.3 The 501 brand delete stub is removed

A real delete needs a factory teardown workflow (route, Worker, D1 rows), so it is its own spec. This PR removes the stub at `lifecycle.ts:576-579` and the `deleteBrand` key from `PANEL_ROLE_TABLE` (and from the `api.test.ts` matrix). `DELETE /api/brands/:id` then answers the same as any unmatched method on that path (no 501, no core call). The PR body lists "brand delete spec" under Proposed (out of scope).

### D8.4 Mock bindings for local preview

New module `apps/web/src/server/mock-bindings.ts`. When `env.MOCK_CORE === "1"`, `withMockBindings(env)` returns an env where each missing `CORE_LIFECYCLE`, `FACTORY_WORKER` and `TEMPLATE_MCP` is an in-memory `Fetcher` stand-in. A binding that is present is never replaced. With `MOCK_CORE` unset or `"0"`, the env is returned unchanged. index.ts applies it once at the top of the request handler.

- `CORE_LIFECYCLE`: answers every path the panel calls (runtime list, runtime state, test-sold, ads routing, mailing list) with schema-valid data derived from the mock core brands, so `/brands` loads with no core error banner.
- `FACTORY_WORKER`: accepts every workflow dispatch the panel sends (install, rollback, redeploy, recover, upgrade-all, zone check, seal/approve) with the success shape each caller parses, and a deterministic instance id. It does not simulate progress.
- `TEMPLATE_MCP`: answers import from zip and from URL with a schema-valid imported template, so the Templates import flow completes.

No mock makes a network call. Production config keeps `MOCK_CORE: "0"`; the mocks never run there.

## Decisions, PR 2

### D1.1 Owner-only user admin routes

New module `apps/web/src/server/users-admin.ts` (`// spec polish`), one `handleUsersAdminRoute` call in index.ts. New `PANEL_ROLE_TABLE` keys, all `"owner"`: `banUser`, `deleteUser`, `resetUserPassword`, `manageUserSessions`.

| Route | Body | better-auth call | Audit action |
|---|---|---|---|
| `POST /api/users/:id/ban` | `{ reason?: string (1..200, trimmed) }` | `banUser` (no expiry) | `user.ban`, after `{ reason }` |
| `POST /api/users/:id/unban` | none | `unbanUser` | `user.unban` |
| `POST /api/users/:id/password` | `{ password: string (8..128) }` | `setUserPassword`, then `revokeUserSessions` | `user.reset_password`, no password in before or after |
| `DELETE /api/users/:id` | none | `removeUser` | `user.delete`, before `{ email, role }` |
| `GET /api/users/:id/sessions` | none | `listUserSessions` | none |
| `DELETE /api/users/:id/sessions` | none | `revokeUserSessions` | `user.revoke_sessions` |
| `DELETE /api/users/:id/sessions/:sid` | none | `revokeUserSession` after checking the session belongs to `:id` | `user.revoke_session`, after `{ session_id }` |

Rules:
- An employee gets 403 `forbidden_role` on every route.
- Ban, delete and password reset on yourself answer 422 `invalid` (same as role change, index.ts). Revoking your own sessions is allowed.
- An unknown user id answers 404; a session id of another user answers 404.
- The sessions list returns `{ sessions: [{ id, created_at, expires_at, ip_address, user_agent }] }`. It never returns a token.
- `GET /api/users` keeps returning `banned`.
- A banned user cannot sign in, and their existing session stops working (better-auth revokes sessions on ban).
- Every write goes through `writePanelAudit`, actor and role from the request context.

### D1.2 Users screen

- Table gains a status badge ("ใช้งาน (Active)" / "ถูกระงับ (Banned)") and an actions cell per row other than yourself: Ban or Unban, Reset password, Sessions, Delete.
- Ban opens `useConfirm` with an optional reason input. Delete uses `useConfirm` with tone danger and the user's email in the body. Reset password opens a small form (new password, 8 to 128 chars) and confirms. Sessions opens a drawer listing sessions with "เพิกถอน (Revoke)" per row and "เพิกถอนทั้งหมด (Revoke all)".
- A `Toast` reports each result; errors use `ApiError.thai`.

### D1.6 Users search

A text box above the table filters rows on name or email, case-insensitive, client-side. An empty result shows `EmptyState`.

### D7.1 Suppressions add and remove

- Migration `packages/leads-db/migrations/0016_suppressions_added_by.sql`: `ALTER TABLE suppressions ADD COLUMN added_by TEXT` (nullable). The listmonk sync upsert never writes `added_by`, so a manual row keeps its actor when the sync later touches it.
- Contracts: two `AdminApi` endpoints, min role owner:
  - `addSuppression` `POST /admin/suppressions` body `{ email (lowercased, trimmed, email format), reason?: SuppressionReason (default "manual") }`. Answers 201 with the row; an address already suppressed answers 409 `conflict`. Writes `source: "manual"`, `added_by: actor_id`.
  - `removeSuppression` `POST /admin/suppressions/remove` body `{ email }`. Answers 200 `{ removed: true }`; an unknown address answers 404. The address travels in the body so it never appears in a URL or access log.
- `SuppressionsResponse` rows gain `added_by: string | null`. `SuppressionsQuery` gains `added_by?: string` (a user id) or the literal `"system"` (rows with `added_by IS NULL`).
- Core audit: actions `suppression.add` and `suppression.remove`, entity type `suppression`, entity id the first 16 hex chars of SHA-256 of the lowercased address. before/after hold `{ reason, source }` only, never the address (same rule as `pii.suppression_search`).
- Mock core implements both endpoints and the filter.
- Panel: `server/suppressions.ts` proxies both writes with `authorize`, and the 5-test file's "does not answer a method other than GET" test changes to cover the new methods.
- Screen: "เพิ่มอีเมล (Add)" form (email, reason select); "ลบ (Remove)" per row with `useConfirm` tone danger. The confirm body says that a listmonk row comes back on the next sync if listmonk still blocks the address. A new column "เพิ่มโดย (Added by)" shows the user name or "ระบบ (sync)". An actor select filters by `added_by`.

## Decisions, PR 3

### D4.1 Rows become cards under 768 px

- `Column<T>` gains `label?: string`, the plain text for the card label (default: `header` when it is a string). `DataTable` writes `data-label` on each `td`.
- CSS under `@media (max-width: 767px)` turns `.data-table table, tbody, tr, td` into blocks: each row is a card with a border and padding; each cell is a line "label: value" from `td::before { content: attr(data-label) }`; the header row is hidden visually (kept for screen readers); a cell whose column sets `label: ""` (the action cell) renders without a label, full width.
- The raw tables that list records get the same card CSS by class: the brand table (`BrandLifecycle.tsx:519`) and the Users table. Funnel, BuilderKeys and UpgradeOutcomes keep horizontal scroll inside their wrapper.
- Settings at 375 px: the Edit button is visible without sideways scroll. `Settings.css` min widths apply only above 767 px.
- The page never scrolls sideways at 375 px on Home, Brands, Leads, Conversions, Deploys, Settings, Audit, Suppressions, Users, Traffic.

### D4.2 Filters move into a modal under 768 px

New `components/FilterBar.tsx`: `FilterBar({ label, activeCount, children })`. At 768 px and wider it renders the children inline in a flex row. Under 768 px it renders a button "ตัวกรอง (Filters)" with the active count, which opens a modal holding the same children and a "เสร็จ (Done)" button. The width check uses one `useNarrow()` hook on `matchMedia("(max-width: 767px)")`. Filter state stays in the screen; the modal only moves the controls. Applied to Leads, Conversions, Deploys, Suppressions, ClientErrors, BrandTimeline, Audit and the Brands filters. Period segment buttons stay outside the modal.

### D5.1 Brand row actions

- The brand row gets a "จัดการ (Actions)" menu button next to Pause/Resume, built on a new `components/RowMenu.tsx` (button with `aria-haspopup="menu"`, a `role="menu"` list, Escape and outside click close it, arrow keys move focus, `stopPropagation` so the row is not selected).
- Menu items, each shown only when the detail panel would show it, with the same gating (`lifecycleMutationAvailability`, role, status) and the same confirm dialogs:
  - Deploy group: Install, Redeploy, Redeploy with latest form, Rollback, Recover.
  - Other: Duplicate, Copy Final URL, Open site, Timeline, Runtime config.
- A menu item calls the same handler as the detail button (`dispatchOperation`, `copyFinalUrl`, the duplicate dialog, ConfigPanel open). No new server route.

## Testing

Every decision has at least one named test in the plan. Worker tests use `call`, `sessions`, `setupDatabases`, `resetState` from `apps/web/test/helpers.ts`. UI tests use the `*.ui.test.tsx` pattern with mocked fetch. Core changes get Miniflare tests in `workers/core`. PR 3 adds a 375 px screenshot of Settings, Brands and Leads from the local preview to the PR body.
