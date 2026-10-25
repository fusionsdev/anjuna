# Panel polish (spec 7, FUS-382) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 approved gaps from the 2026-10-25 panel audit in 3 PRs: audit paging and search, Load more, raw ids, small items and mock bindings (PR 1); users admin and suppressions writes (PR 2); mobile cards, filter modal and brand row actions (PR 3).

**Architecture:** Panel-side changes in `apps/web` for most items. Two narrow contract and core changes: a `limit` on `ConversionsQuery` (PR 1) and the suppression add/remove endpoints plus one leads-db migration (PR 2). Users admin calls better-auth `auth.api.*` on the panel server. New server code lives in new modules; shared files get one call each.

**Tech Stack:** Bun workspaces, TypeScript strict, Zod contracts, Cloudflare Workers, React 19, better-auth 1.7.7, Vitest (`apps/web` projects `worker` for `test/**/*.test.ts`, `ui` for `test/**/*.ui.test.tsx`, `build` for `*.node.test.ts`; `workers/core` with `@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-10-25-panel-polish-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `wrangler deploy`, no `wrangler d1 ... --remote`, no real external call, no secret in a file.
- No change under `spike/`, `packages/brand-runtime/`, `apps/web/src/client/wizard/`, `apps/web/src/client/screens/BrandWizard.tsx` or `apps/web/src/client/screens/SettingsEditor.tsx` (FUS-381 owns them).
- Changes under `packages/` or `workers/` happen only in Tasks 2 and 11. The only new migration is `packages/leads-db/migrations/0016_suppressions_added_by.sql` (Task 11).
- New server code goes in its own module with a `// spec polish` comment. Shared files (`apps/web/src/server/index.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/api.ts`, `apps/web/src/server/panel-roles.ts`, `apps/web/src/server/mock-core.ts`, `packages/contracts/src/admin-api.ts`, `apps/web/src/client/styles.css`) get the smallest possible addition. Never reformat or reorder them.
- Every new `PANEL_ROLE_TABLE` key gets a one-line doc comment and an entry in the `api.test.ts` matrix test "panel-only actions follow the plan's matrix".
- UI copy is Thai first with English in parentheses, using the exact strings in the spec.
- No address, password or session token appears in an audit row, a log line or a URL.
- Reuse `DataTable`, `useConfirm`, `StatusBadge`, `Toast`, `EmptyState`, `BrandLabel`, `useBrandDomains`, `ApiError.thai`. No new dependency.
- Done per task: `bun run typecheck` at the repo root green plus `bun run --cwd <pkg> test` green for every package touched.

## Review Focus

1. **Audit page 2 across sources** (Task 4). Expected: with 3 core rows and 3 local `user.` rows interleaved by id and `limit=2`, three pages return all 6 ids once each in descending id order, and the last page has `next_cursor: null`.
2. **Load more racing a filter change** (Tasks 1, 3). Expected: a Load more response that lands after a filter change is dropped; the table shows only the new filter's rows at the start limit.
3. **Conversions limit bounds** (Task 2). Expected: `limit=0` and `limit=1001` answer 422; no `limit` behaves exactly as today (200 rows, `truncated`).
4. **Mock bindings never shadow real ones** (Task 8). Expected: a present `CORE_LIFECYCLE` binding is used even with `MOCK_CORE=1`; with `MOCK_CORE` `"0"` or unset the env object is returned unchanged.
5. **Self-protection on user admin** (Task 9). Expected: an owner banning, deleting or resetting the password of their own id gets 422 and no better-auth call; revoking their own sessions is allowed.
6. **Session ownership** (Task 9). Expected: `DELETE /api/users/A/sessions/<session of B>` answers 404 and B's session still works.
7. **Suppression audit rows hold no address** (Task 11). Expected: after add and remove, no `audit_log` row contains the address in `entity_id`, `before_json` or `after_json`.
8. **Listmonk sync keeps `added_by`** (Task 11). Expected: a manual row upserted again by `syncSuppressions` keeps its `added_by`.
9. **Row menu gating equals the detail panel** (Task 18). Expected: for each fixture brand state and role, the menu shows exactly the actions the detail panel shows.

---

# PR 1: `fus-382-panel-polish` (items 2, 3, 6, 8)

### Task 1: `LoadMore` component, Load more on Deploys and Timeline

**Files:**
- Create: `apps/web/src/client/components/LoadMore.tsx`
- Modify: `apps/web/src/client/screens/Deploys.tsx`
- Modify: `apps/web/src/client/screens/BrandTimeline.tsx`
- Test: `apps/web/test/load-more.ui.test.tsx`, `apps/web/test/deploys.ui.test.tsx`, `apps/web/test/brand-timeline.ui.test.tsx`

**Interfaces:**
- `export function LoadMore({ shown, hasMore, atMax, loading, onMore, narrowHint }: { shown: number; hasMore: boolean; atMax: boolean; loading: boolean; onMore: () => void; narrowHint: string }): JSX.Element | null` — spec D3.1 strings exactly.
- Deploys: request `limit` starts 50, step 50, max 200; Timeline: start 100, step 100, max 200. Both send `limit` explicitly. Any filter change resets the limit. A generation ref drops stale responses (ClientErrors.tsx:59 pattern).
- Deploys `narrowHint`: "กรุณากรองให้แคบลง (Narrow the filters)". Timeline `narrowHint`: "กรุณาเลือกช่วงวันที่ให้แคบลง (Narrow the date range)".

- [ ] **Step 1: Write the failing tests**
  - `load-more.ui.test.tsx`: "renders a Load more button when more rows exist below the max"; "shows the max note with the narrow hint at the max"; "renders nothing when there are no more rows"; "disables the button while loading".
  - `deploys.ui.test.tsx`: "Load more re-fetches deploys with limit 100 then 150"; "a filter change resets the deploys limit to 50"; "a stale Load more response is dropped after a filter change"; "at limit 200 with has_more the max note shows".
  - `brand-timeline.ui.test.tsx`: "Load more re-fetches the timeline with limit 200"; "a date range change resets the timeline limit to 100".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/load-more.ui.test.tsx test/deploys.ui.test.tsx test/brand-timeline.ui.test.tsx`.
- [ ] **Step 3: Implement.** Replace the old "แสดง N รายการล่าสุด" note in Deploys.tsx:256 and the narrow note at BrandTimeline.tsx:355 with `LoadMore`.
- [ ] **Step 4: Run, expect PASS**, plus the whole `ui` project.
- [ ] **Step 5: Commit** — `feat(web): load more on deploys and timeline (FUS-382)`

### Task 2: `ConversionsQuery.limit` (contracts, core, mock)


**Files:**
- Modify: `packages/contracts/src/admin-api.ts` (`ConversionsQuery` gains `limit`)
- Modify: `workers/core/src/admin/conversions-report.ts` (use `query.limit ?? CONVERSIONS_ROW_LIMIT`)
- Modify: `apps/web/src/server/mock-core.ts` (conversions case slices by `limit`, sets `truncated`)
- Test: `workers/core/test/conversions-report.test.ts`, `packages/contracts` test file that covers `ConversionsQuery` (create `packages/contracts/test/conversions-query.test.ts` if none), `apps/web/test/conversions-api.test.ts`

**Interfaces:**
- `ConversionsQuery.limit`: `z.coerce.number().int().min(1).max(1000).optional()`; exported `CONVERSIONS_MAX_LIMIT = 1000` next to `CONVERSIONS_ROW_LIMIT` in `packages/contracts/src/conversions.ts`.
- Core: `LIMIT limit + 1`, slice to `limit`, `truncated = rows.length > limit`. The panel proxy (index.ts:337-342) already forwards the search params; no change there.

- [ ] **Step 1: Write the failing tests** — contracts: "ConversionsQuery accepts limit 1 and 1000 and rejects 0 and 1001". Core: "conversionsReport honours limit and sets truncated"; "conversionsReport without limit returns at most 200 rows as before". Panel: "GET /api/conversions passes limit to core and answers 422 for limit=1001".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd packages/contracts test`, `bun run --cwd workers/core test -- test/conversions-report.test.ts`, `bun run --cwd apps/web test -- --project worker test/conversions-api.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(core): optional limit on the conversions report (FUS-382)`

### Task 3: Load more on Conversions

**Files:**
- Modify: `apps/web/src/client/api.ts` (`conversions` query gains `limit?: number`)
- Modify: `apps/web/src/client/screens/Conversions.tsx`
- Test: `apps/web/test/conversions.ui.test.tsx`

**Interfaces:** start 200, step 200, max 1000 (`CONVERSIONS_MAX_LIMIT`); more flag `truncated`; `narrowHint` "กรุณากรองให้แคบลง (Narrow the filters)". Period, status or brand change resets the limit. Stale responses dropped.

- [ ] **Step 1: Write the failing tests** — "Load more re-fetches conversions with limit 400"; "a period change resets the conversions limit to 200"; "at limit 1000 with truncated the max note shows".
- [ ] **Step 2–4:** fail, implement (replace the note at Conversions.tsx:158), pass.
- [ ] **Step 5: Commit** — `feat(web): load more on conversions (FUS-382)`

### Task 4: Audit route paging across all sources

**Files:**
- Create: `apps/web/src/server/audit-route.ts`
- Modify: `apps/web/src/server/audit.ts` (`listPanelAudit` and `listLifecycleAudit` gain `beforeId?: number`)
- Modify: `apps/web/src/server/index.ts` (replace the `/api/audit` block with one `handleAuditRoute` call, `// spec polish`)
- Modify: `apps/web/src/server/mock-core.ts` (`listAudit` honours `cursor`, `limit`, `actor_id`, `target_type`, `target_id`; real `next_cursor`)
- Test: `apps/web/test/audit-route-api.test.ts`

**Interfaces:**
- `export async function handleAuditRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | null>` — `GET /api/audit` only; behaviour as today plus spec D2.1.
- `export function encodeAuditCursor(id: number): string` and `export function decodeAuditCursor(cursor: string): number | null` — the core format (`btoa(String(id))` without `=`; decode accepts `-`/`_`).

- [ ] **Step 1: Write the failing tests** (seed local `user.` rows with `writePanelAudit` and use mock core rows; assert on ids)
  - "pages through core and panel rows with no gap and no duplicate" (Review Focus 1).
  - "page 2 still includes panel user rows".
  - "a bad cursor answers 422 invalid".
  - "an employee pages only their own rows".
  - "target_type brand skips panel rows on every page".
  - "the last page has next_cursor null".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project worker test/audit-route-api.test.ts`.
- [ ] **Step 3: Implement.** Keep the existing `api.test.ts` audit assertions green.
- [ ] **Step 4: Run, expect PASS**, plus the whole `worker` project.
- [ ] **Step 5: Commit** — `fix(web): audit paging includes every source on every page (FUS-382)`

### Task 5: Audit screen: Load more, filters, actor names

**Files:**
- Modify: `apps/web/src/client/api.ts` (`audit(query?: { cursor?: string; actor_id?: string; target_type?: string; target_id?: string })`, limit 50)
- Modify: `apps/web/src/client/screens/Audit.tsx`
- Test: `apps/web/test/audit.ui.test.tsx`

**Interfaces:** spec D2.2. Owner loads `api.users()` once for names and the actor select; an employee never calls it. Target type options: `brand`, `user`, `template`, `suppression`. Actor cell: `name (email)`, `ระบบ (system)`, or raw id in `<code>` with title "ผู้ใช้ที่ถูกลบ (Deleted user)". Brand targets render `BrandLabel`.

- [ ] **Step 1: Write the failing tests** — "shows the actor name and email for a known user"; "shows ระบบ (system) for a system row"; "shows the raw id with the deleted-user title for an unknown actor"; "an employee sees their own email and no filter bar and never calls /api/users"; "Load more appends the next page using next_cursor"; "changing the actor filter reloads from page 1 with actor_id"; "the brand target filter sends the brand id chosen by domain".
- [ ] **Step 2–4:** fail, implement, pass (the 4 existing audit UI tests stay green, updated only where the actor cell text changed).
- [ ] **Step 5: Commit** — `feat(web): audit load more, filters and actor names (FUS-382)`

### Task 6: Domain first, ConfigPanel loading title, A/B points to Settings

**Files:**
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (:487, :536, :603 only)
- Modify: `apps/web/src/client/screens/ConfigPanel.tsx` (:58 title; remove `AbSection`, add the summary line and link)
- Modify: `apps/web/src/client/screens/Settings.tsx` (open the editor for `?brand=<id>` once on load)
- Test: `apps/web/test/lifecycle.ui.test.tsx` or `brand-row.ui.test.tsx`, `apps/web/test/config-panel-ab.ui.test.tsx` (new), `apps/web/test/settings.ui.test.tsx`

**Interfaces:** spec D6.1, D6.2, D8.2. Link uses the router's `navigate("/settings?brand=" + encodeURIComponent(id))` (or the existing link helper in `router.ts`). The A/B summary reuses `formLabel` from `apps/web/src/client/settings-draft.ts`.

- [ ] **Step 1: Write the failing tests** — "a brand row shows the domain first and the name after it"; "the detail header shows the domain and no raw brand id"; "the ConfigPanel loading title is the domain, never the brand id"; "the ConfigPanel loading title falls back to กำลังโหลด… (Loading)"; "ConfigPanel shows the A/B summary and an Edit in Settings link for an owner"; "ConfigPanel has no A/B weight inputs"; "Settings opens the editor for ?brand=<id>"; "Settings ignores an unknown ?brand id".
- [ ] **Step 2–4:** fail, implement, pass; existing ConfigPanel tests that covered `AbSection` are removed or moved to the summary assertions, listed in the report.
- [ ] **Step 5: Commit** — `fix(web): domain first and A/B editing only in Settings (FUS-382)`

### Task 7: Template Approve confirm, remove the 501 delete stub

**Files:**
- Modify: `apps/web/src/client/screens/Templates.tsx`
- Modify: `apps/web/src/server/lifecycle.ts` (remove :576-579)
- Modify: `apps/web/src/server/panel-roles.ts` (remove `deleteBrand`)
- Modify: `apps/web/test/api.test.ts` (matrix without `deleteBrand`)
- Test: `apps/web/test/templates.ui.test.tsx`, `apps/web/test/lifecycle-api.test.ts`

**Interfaces:** spec D8.1, D8.3.

- [ ] **Step 1: Write the failing tests** — "Approve asks for confirmation before calling the API"; "cancelling the Approve confirm sends no request"; "the detail Approve button also confirms"; "DELETE /api/brands/:id no longer answers 501 and makes no core call".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `fix(web): confirm template approve, drop the brand delete stub (FUS-382)`

### Task 8: Mock bindings for local preview

**Files:**
- Create: `apps/web/src/server/mock-bindings.ts`
- Modify: `apps/web/src/server/index.ts` (apply `withMockBindings(env)` once at the top of the request handler, `// spec polish`)
- Test: `apps/web/test/mock-bindings.test.ts`

**Interfaces:**
- `export function withMockBindings(env: Env): Env` — spec D8.4. Each stand-in is `{ fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }` cast to `Fetcher`. Read every caller (`lifecycle.ts`, `deploys.ts`, `timeline.ts`, `templates.ts`, `wizard.ts`, `retry-install.ts`, factory dispatch helpers) and answer each path with the shape that caller parses; unknown paths answer 404 JSON.

- [ ] **Step 1: Write the failing tests** — "MOCK_CORE=1 with no bindings: GET /api/lifecycle/brands has no core_error"; "MOCK_CORE=1: GET /api/deploys has no unavailable source"; "MOCK_CORE=1: an install dispatch is accepted"; "MOCK_CORE=1: template import from URL succeeds"; "a present CORE_LIFECYCLE binding is used even with MOCK_CORE=1"; "MOCK_CORE=0 returns the same env object".
- [ ] **Step 2–4:** fail, implement, pass, plus the whole `apps/web` suite.
- [ ] **Step 5: Commit** — `feat(web): mock lifecycle, factory and template bindings for local preview (FUS-382)`

---

# PR 2: `fus-382b-users-suppressions` (items 1, 7, Users search)

### Task 9: Owner-only user admin routes

**Files:**
- Create: `apps/web/src/server/users-admin.ts`
- Modify: `apps/web/src/server/panel-roles.ts` (`banUser`, `deleteUser`, `resetUserPassword`, `manageUserSessions`, all `"owner"`)
- Modify: `apps/web/src/server/index.ts` (one `handleUsersAdminRoute` call before the users block, `// spec polish`)
- Modify: `apps/web/test/api.test.ts` (matrix)
- Test: `apps/web/test/users-admin-api.test.ts`

**Interfaces:**
- `export async function handleUsersAdminRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | null>` — the 7 routes in spec D1.1 with its bodies, status codes and audit actions. Uses `createAuth(env)` and `auth.api.*` with the request headers, as the role change does.
- `UserSession = { id: string; created_at: string; expires_at: string; ip_address: string | null; user_agent: string | null }` in the response.

- [ ] **Step 1: Write the failing tests** — "an employee gets 403 on every user admin route"; "ban blocks sign-in and ends the banned user's session"; "unban lets the user sign in again"; "ban, delete and password reset on yourself answer 422 with no change" (Review Focus 5); "password reset changes the password and revokes the user's sessions"; "delete removes the user and their sessions"; "sessions list never returns a token"; "revoking one session of another user answers 404" (Review Focus 6); "revoke all ends every session of the user"; "each write writes one audit row with the right action and no password"; "an unknown user id answers 404".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project worker test/users-admin-api.test.ts`.
- [ ] **Step 3–4:** implement, pass, plus `test/api.test.ts`.
- [ ] **Step 5: Commit** — `feat(web): owner-only ban, delete, password reset and sessions for users (FUS-382)`

### Task 10: Users screen actions and search

**Files:**
- Modify: `apps/web/src/client/api.ts` (`banUser`, `unbanUser`, `resetUserPassword`, `deleteUser`, `userSessions`, `revokeUserSessions`, `revokeUserSession`)
- Modify: `apps/web/src/client/screens/Users.tsx`
- Create: `apps/web/src/client/screens/UserSessions.tsx` (sessions drawer)
- Test: `apps/web/test/users.ui.test.tsx` (new)

**Interfaces:** spec D1.2, D1.6.

- [ ] **Step 1: Write the failing tests** — "shows Active and Banned badges"; "your own row has no action buttons"; "Ban confirms with an optional reason and posts it"; "cancelling Ban sends no request"; "Delete confirms with tone danger and the user's email"; "Reset password rejects a 7-character password before sending"; "the sessions drawer lists sessions and revokes one"; "Revoke all calls the revoke-all route"; "search filters rows by name or email, case-insensitive"; "a search with no match shows the empty state".
- [ ] **Step 2–4:** fail, implement, pass (the existing Users role-change test in `confirm-actions.ui.test.tsx` stays green).
- [ ] **Step 5: Commit** — `feat(web): users screen admin actions and search (FUS-382)`

### Task 11: Suppression add/remove and `added_by` (migration, contracts, core)

**Files:**
- Create: `packages/leads-db/migrations/0016_suppressions_added_by.sql`
- Modify: `packages/contracts/src/admin-api.ts` (`addSuppression`, `removeSuppression`, request/response schemas, `added_by` on rows and query, audit action names `suppression.add`, `suppression.remove`)
- Modify: `workers/core/src/admin/index.ts` (two handlers, `added_by` filter in `listSuppressions`, audit union)
- Test: `workers/core/test/admin.test.ts` (or a new `workers/core/test/suppressions-write.test.ts`), `packages/mailing` sync test for `added_by`

**Interfaces:** spec D7.1. Entity id helper `suppressionAuditId(email: string): Promise<string>` (first 16 hex chars of SHA-256 of the lowercased address, `crypto.subtle`).

- [ ] **Step 1: Write the failing tests** — "addSuppression inserts a manual row with added_by and answers 201"; "addSuppression on an existing address answers 409"; "removeSuppression deletes the row and answers 200"; "removeSuppression on an unknown address answers 404"; "an employee gets 403 on both writes"; "listSuppressions filters by added_by and by system"; "suppression audit rows hold no address" (Review Focus 7); "syncSuppressions keeps added_by on a manual row" (Review Focus 8).
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd workers/core test`, `bun run --cwd packages/mailing test`, `bun run --cwd packages/contracts test`.
- [ ] **Step 3–4:** implement, pass.
- [ ] **Step 5: Commit** — `feat(core): manual suppression add and remove with actor (FUS-382)`

### Task 12: Suppressions panel proxy and mock core

**Files:**
- Modify: `apps/web/src/server/suppressions.ts`
- Modify: `apps/web/src/server/mock-core.ts` (both endpoints, `added_by` filter, added to `MOCK_ENDPOINTS`)
- Test: `apps/web/test/suppressions-api.test.ts`

- [ ] **Step 1: Write the failing tests** — "an owner adds a suppression through the panel"; "an owner removes a suppression through the panel"; "an employee gets 403 on add and remove"; "an invalid email answers 422 before core is called"; "GET passes added_by to core". Replace "does not answer a method other than GET" with "answers only GET and the two POST routes".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): proxy suppression add and remove (FUS-382)`

### Task 13: Suppressions screen add, remove, actor filter

**Files:**
- Modify: `apps/web/src/client/api.ts` (`addSuppression`, `removeSuppression`, `added_by` in the filter)
- Modify: `apps/web/src/client/screens/Suppressions.tsx`
- Test: `apps/web/test/suppressions.ui.test.tsx`

- [ ] **Step 1: Write the failing tests** — "the add form posts the email and reason and reloads"; "Remove confirms with the listmonk resync note"; "cancelling Remove sends no request"; "the Added by column shows the user name or ระบบ (sync)"; "the actor filter sends added_by".
- [ ] **Step 2–4:** fail, implement, pass (11 existing tests stay green).
- [ ] **Step 5: Commit** — `feat(web): suppressions add, remove and actor filter (FUS-382)`

---

# PR 3: `fus-382c-mobile-row-actions` (items 4, 5)

### Task 14: DataTable cards under 768 px

**Files:**
- Modify: `apps/web/src/client/components/DataTable.tsx` (`Column.label?`, `data-label` on each `td`)
- Modify: `apps/web/src/client/styles.css` (one `@media (max-width: 767px)` block for `.data-table` cards)
- Modify: `apps/web/src/client/screens/Settings.css` (min widths only above 767 px)
- Modify: `apps/web/src/client/screens/Settings.tsx` (Edit column `label: ""`)
- Test: `apps/web/test/components.ui.test.tsx`, `apps/web/test/settings.ui.test.tsx`

- [ ] **Step 1: Write the failing tests** — "DataTable writes data-label from a string header"; "DataTable prefers Column.label over the header"; "a column with label empty string has an empty data-label"; "the Settings Edit column has an empty card label".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): data tables become cards on phones (FUS-382)`

### Task 15: Brand and Users tables as cards

**Files:**
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (`data-label` on brand table cells)
- Modify: `apps/web/src/client/screens/Brands.css` (card rules under 767 px)
- Modify: `apps/web/src/client/screens/Users.tsx` (`data-label` on cells; the table keeps its class)
- Test: `apps/web/test/brand-row.ui.test.tsx`, `apps/web/test/users.ui.test.tsx`

- [ ] **Step 1: Write the failing tests** — "brand table cells carry data-label"; "users table cells carry data-label".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): brand and users tables become cards on phones (FUS-382)`

### Task 16: `FilterBar` with a modal under 768 px; Leads, Conversions, Deploys

**Files:**
- Create: `apps/web/src/client/components/FilterBar.tsx` (`FilterBar`, `useNarrow`)
- Modify: `apps/web/src/client/screens/Leads.tsx`, `Conversions.tsx`, `Deploys.tsx`
- Test: `apps/web/test/filter-bar.ui.test.tsx`, plus one assertion each in `leads.ui.test.tsx`, `conversions.ui.test.tsx`, `deploys.ui.test.tsx`

**Interfaces:** `export function useNarrow(): boolean` (`matchMedia("(max-width: 767px)")`, listens for changes); `export function FilterBar({ label, activeCount, children }: { label: string; activeCount: number; children: ReactNode }): JSX.Element`.

- [ ] **Step 1: Write the failing tests** — "renders children inline when wide"; "renders a Filters button with the active count when narrow"; "the Filters button opens a modal with the controls and Done closes it"; "Escape closes the filter modal"; per screen: "on a narrow screen the filters sit behind the Filters button".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): filter bar moves into a modal on phones (FUS-382)`

### Task 17: `FilterBar` on Suppressions, ClientErrors, BrandTimeline, Audit, Brands

**Files:**
- Modify: `apps/web/src/client/screens/Suppressions.tsx`, `ClientErrors.tsx`, `BrandTimeline.tsx`, `Audit.tsx`, `BrandFilters.tsx`
- Test: one narrow-screen assertion each in the matching `*.ui.test.tsx`

- [ ] **Step 1–4:** tests "on a narrow screen the filters sit behind the Filters button" per screen; fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): filter modal on the remaining list screens (FUS-382)`

### Task 18: `RowMenu` and brand row actions

**Files:**
- Create: `apps/web/src/client/components/RowMenu.tsx`
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (row menu; reuse the detail handlers)
- Test: `apps/web/test/row-menu.ui.test.tsx`, `apps/web/test/brand-row-actions.ui.test.tsx`

**Interfaces:** `export type RowMenuItem = { key: string; label: string; onSelect: () => void; group?: string; tone?: "danger" }`; `export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }): JSX.Element | null` (renders nothing for an empty list). Spec D5.1.

- [ ] **Step 1: Write the failing tests** — "opens on click and closes on Escape and outside click"; "arrow keys move focus between items"; "selecting an item calls it and closes the menu"; "opening the menu does not select the row"; "the row menu shows exactly the detail panel actions for each fixture state and role" (Review Focus 9); "Redeploy from the row asks the same confirm and calls api.redeploy"; "Copy Final URL from the row copies the same URL as the detail button".
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(web): brand row actions menu (FUS-382)`

PR 3 verification: local preview (`panel-preview`, `MOCK_CORE=1`, http://localhost:8799) at 375 px; screenshots of Settings, Brands and Leads paths go in the PR body.
