# Panel brand timeline (spec 6, FUS-380, phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-brand `/brands/:id/timeline` screen that merges stored change history with manual Google Ads account events, with manual entry (owner and employee), Owner-only delete, type and date filters, and "change, then event" markers.

**Architecture:** One factory-db migration adds `ads_account_events`. One panel server module (`timeline.ts`) serves the merged read and the two event writes; the read reuses the three change sources in `deploys.ts` with an optional date range. Panel-only Zod schemas live in `apps/web/src/shared/timeline.ts`. One pure client module holds labels, filter-URL logic, day grouping and the since-last-change marker; one screen file renders it. No core change, no contracts change, no new dependency.

**Tech Stack:** Bun workspaces, TypeScript strict, Zod, Cloudflare Workers + D1, React 19, Vitest (`apps/web` projects `worker` for `test/**/*.test.ts`, `ui` for `test/**/*.ui.test.tsx`; `packages/factory-db` worker pool).

**Spec:** `docs/superpowers/specs/2026-10-25-panel-timeline-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `wrangler deploy`, no `wrangler d1 migrations apply --remote`, no real external call, no secret in a file.
- No change under `packages/brand-runtime`, `packages/contracts`, `packages/leads-db`, `workers/`, `spike/`. The only migration is `packages/factory-db/migrations/0009_ads_account_events.sql` (Task 1).
- Event types are exactly the six ids in spec D2; change categories exactly the four in spec D5.
- Roles: `viewBrandTimeline: "employee"`, `createAdsEvent: "employee"`, `deleteAdsEvent: "owner"` (spec D3). Audit-sourced change rows for an employee are only their own (same as `/api/deploys`).
- Every create and delete writes its audit row in the same `env.FACTORY.batch` as the data change.
- `/api/deploys` behavior must not change: `apps/web/test/deploys-api.test.ts` passes without edits.
- UI copy is Thai first with English in parentheses, using the exact strings in the spec.
- New server code goes in its own module with a `// spec timeline` comment. Shared files (`apps/web/src/server/index.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/router.ts`, `apps/web/src/client/api.ts`, `apps/web/src/server/panel-roles.ts`, `apps/web/src/client/screens/BrandLifecycle.tsx`) get the smallest possible addition. Never reformat or reorder them.
- Done per task: `bun run typecheck` at the repo root green plus the test suite of every package touched green.

## Review Focus

1. **Date range across offsets.** A stored `2026-10-21T07:00:00+07:00` row (00:00Z) with `from=2026-10-21T00:00:00.000Z` is inside the range; text comparison would differ. Expected: SQL uses `julianday()`. Test in Task 4.
2. **Deploys unchanged.** `installEvents` / `factoryAuditEvents` / `coreAuditEvents` with no range produce the same SQL and rows as before. Expected: `deploys-api.test.ts` green, unmodified. Task 4.
3. **Atomic audit.** A create whose audit insert fails leaves no event row (one batch). Test in Task 3.
4. **Employee delete.** The button is hidden and the route answers 403 with no row removed and no audit row. Tests in Tasks 3 and 7.
5. **Unmanaged brand.** A brand known only to core (no factory row) can open the timeline and take an event; an id known to neither gives 404. Tests in Tasks 3 and 4.
6. **Since-last-change.** Uses the newest change at or before the event, never a later one; absent when no change is loaded. Test in Task 5.

---

### Task 1: Migration 0009 `ads_account_events`

**Files:**
- Create: `packages/factory-db/migrations/0009_ads_account_events.sql` (exact SQL in spec D1, with a header comment in the style of 0008)
- Modify: `packages/factory-db/src/index.ts` (append `"0009_ads_account_events.sql"` to `FACTORY_DB_MIGRATIONS`)
- Modify: `packages/factory-db/test/factory-db.test.ts`

**Tests (in `factory-db.test.ts`):**
- "apply cleanly to an empty D1": the expected table list gains `"ads_account_events"`.
- New `it("checks ads account event type, role and note length")`: an insert with type `ad_disapproved`, role `employee`, note `""` succeeds; type `bogus` rejects with `/CHECK/`; role `system` rejects; a 501-character note rejects; a 500-character note succeeds.
- New `it("has no foreign key on ads account event brand ids")`: an insert with `brand_id` `'core-only'` (no `brands` row) succeeds.

- [ ] Write the tests, run `bun run --cwd packages/factory-db test`, see them fail.
- [ ] Add the migration and the list entry, run again, see them pass.
- [ ] Commit: `feat(factory-db): ads_account_events table for manual Ads account marks (FUS-380)`

---

### Task 2: Panel-only timeline schemas

**Files:**
- Create: `apps/web/src/shared/timeline.ts`
- Test: `apps/web/test/timeline-schema.test.ts`

**Interfaces (exports, as in spec D5):** `AdsEventType`, `ADS_EVENT_TYPES` (the tuple), `ChangeCategory`, `CHANGE_CATEGORIES`, `TimelineType`, `AdsAccountEvent`, `RevisionRef`, `TimelineItem`, `TimelineResponse`, `CreateAdsEventRequest` (`{ type, occurred_at, note }`, strict, `note` `z.string().max(2000)` here; the 500 limit is checked after trim in the route), `TimelineQuery` (strict; `from`, `to` optional `Timestamp`; `types` optional string parsed by `.transform` into a deduplicated `TimelineType[]`, an unknown item is an issue; `limit` `z.coerce.number().int().min(1).max(200).optional()`; a `.superRefine` adds an issue on `from` when `from` is after `to`), and a `changeCategory(event: DeployEvent): ChangeCategory` function (spec D5 table: install source is `deploy`; `brand.update` is `config`; `brand.pause`/`brand.resume` are `pause_resume`; any other audit action is `factory_edit`). Each schema has its `type` export. Import `BrandId`, `Timestamp`, `ActorId`, `Id`, `FormVersion`, `DeployEvent`, `DeployUnavailableSource` from `@anjuna/contracts` (check each name exists; if one is not exported, use the same base schema `DeployEvent` uses and record it as a deviation).

**Tests:**
- "TimelineQuery parses types, limit and range": `{ types: "config,ad_disapproved,config", limit: "50", from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" }` gives `types: ["config", "ad_disapproved"]`, `limit: 50`.
- "TimelineQuery rejects an unknown type, limit 201 and from after to" (three `safeParse(...).success === false`).
- "TimelineItem accepts a change item and an ads_event item and rejects an extra key".
- "changeCategory maps install, brand.update, brand.pause, brand.resume and brand.create".
- "CreateAdsEventRequest rejects an unknown type and a missing note".

- [ ] Tests first, fail, implement, pass (`bun run --cwd apps/web test -- --project worker timeline-schema`).
- [ ] Commit: `feat(web): panel-only brand timeline schemas (FUS-380)`

---

### Task 3: Ads event write routes (POST, DELETE) and roles

**Files:**
- Create: `apps/web/src/server/timeline.ts` (`// spec timeline`; this task adds `brandExists`, the POST and DELETE handlers and `handleTimelineRoute` dispatch for those two; Task 4 adds GET)
- Modify: `apps/web/src/server/panel-roles.ts` (three entries after `viewSettings`, each with a one-line doc comment)
- Modify: `apps/web/src/server/audit.ts` (`"ads_event"` in `FACTORY_AUDIT_PREFIXES`; export `factoryAuditStatement(db, a)`; `writeFactoryAudit` runs it)
- Modify: `apps/web/src/server/index.ts` (import + one `handleTimelineRoute(request, env, url, path, ctx)` call right after the `handleDeployRoute` block, with `// spec timeline (FUS-380)`)
- Modify: `apps/web/test/api.test.ts` (add the three entries to the `toEqual` in "panel-only actions follow the plan's matrix")
- Test: `apps/web/test/ads-events-api.test.ts`

**Interfaces:**
- `export async function brandExists(env: Env, ctx: AdminRequestContext, brandId: string): Promise<"yes" | "no" | "core_error">`: factory `SELECT 1 FROM brands WHERE brand_id = ?1`; else `callCore(env, ctx, { endpoint: "getBrand", params: { id: brandId } })`: 200 is `"yes"`, 404 is `"no"`, anything else `"core_error"` (answer 502 `{ error: "bad_gateway" }`).
- `export async function handleTimelineRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined>` matching `^/api/brands/([^/]+)/ads-events$` (POST) and `^/api/brands/([^/]+)/ads-events/([^/]+)$` (DELETE). Other methods on those paths answer 405 `{ error: "method_not_allowed" }`. Any other path returns `undefined`.
- Validation and responses exactly as spec D4. The 5-minute future check uses `Date.now()` at request time. Insert binds `note` trimmed.
- Mock core in tests: a brand id the mock core knows but the factory does not is the unmanaged case. Read `apps/web/src/server/mock-core.ts` for its fixture brand ids.

**Tests (`ads-events-api.test.ts`, setup like `deploys-api.test.ts`):**
- "an employee creates an event: 201, one row, one ads_event.create audit row with the event in after_json".
- "an owner creates an event on a core-only brand" (unmanaged; 201).
- "an unknown brand gives 404 not_found brand and writes nothing".
- "422 for unknown type, time before 2020, time 10 minutes ahead, a 501-character note after trim, and an empty note for other" (one `it` per case or a table-driven `it.each`).
- "the note is stored trimmed".
- "a failed audit insert leaves no event row": call the handler with an env whose `FACTORY` wraps the real one and makes `batch` fail when it holds the audit insert, or use a D1 trigger created in the test that raises on `INSERT INTO audit_log WHEN NEW.action = 'ads_event.create'` and drop it after; expect 500 and zero `ads_account_events` rows.
- "an employee DELETE answers 403 forbidden_role owner; the row stays; no audit row".
- "an owner DELETE answers 200 with the event; the row is gone; one ads_event.delete audit row with before_json".
- "DELETE of an event id that belongs to another brand answers 404 not_found ads_event".
- "400 invalid_brand_id for a malformed brand id".

- [ ] Tests first, fail, implement, pass. Run the whole `apps/web` worker project (the role matrix test lives in `api.test.ts`).
- [ ] Commit: `feat(web): manual Ads account event create and delete routes with audit (FUS-380)`

---

### Task 4: `GET /api/brands/:id/timeline`

**Files:**
- Modify: `apps/web/src/server/deploys.ts` (export `installEvents`, `factoryAuditEvents`, `coreAuditEvents` and `byInstantDesc`; add an optional last parameter `range: { from?: string; to?: string } = {}` to each of the three; with an empty range the SQL text and binds are exactly as today)
- Modify: `apps/web/src/server/timeline.ts` (GET handler)
- Test: `apps/web/test/timeline-api.test.ts`

**Interfaces / behavior:** spec D4 GET, steps 1 to 6.
- Range SQL for installs: `julianday(started_at) >= julianday(?)` / `<= julianday(?)`; factory audit and ads events: same on `created_at` / `occurred_at`. Core audit: filter entries by `Date.parse(e.at)` in memory before mapping.
- Revisions for install rows: one query `SELECT r.revision_id, r.revision, r.template_version_id, fa.bundle_form_version FROM brand_revisions r LEFT JOIN form_artifacts fa ON fa.form_artifact_id = r.form_artifact_id WHERE r.brand_id = ?1`, mapped by id; a missing id gives null.
- Types: query install rows only when `deploy` is wanted; factory audit only for `factory_edit`; core audit when `config` or `pause_resume` is wanted (then drop the category not wanted); ads events with `type IN (...)` of the wanted event types.
- `actor_scope`: `"all"` for owner, `"own"` for employee. The employee's audit-sourced rows are only their own; ads events and install rows are all.
- Parse the response with `TimelineResponse.parse` before answering, as `deploys.ts` does.

**Tests (`timeline-api.test.ts`; seed installs, revisions with two template versions, factory audit rows, mock core audit entries as `deploys-api.test.ts` does, and ads events):**
- "an owner gets every source merged newest first by instant" (include one `+07:00` install row).
- "install rows carry from and to revision refs with template and form version".
- "types=ad_disapproved returns only those events and does not call core listAudit" (spy or count mock-core calls if the helper allows; otherwise only assert the items).
- "from/to narrow every source by instant" (the +07:00 row at 00:00Z is inside `from=...T00:00:00.000Z`).
- "limit=2 cuts to 2 and sets has_more".
- "core audit unavailable answers 200 with unavailable core_audit".
- "an employee sees all installs and events but only own audit rows, actor_scope own".
- "a core-only brand gets its core rows and no install rows"; "an unknown brand gives 404".
- "422 for from after to and for types=bogus".
- "deploys-api tests stay unchanged" is the existing file passing; run it.

- [ ] Tests first, fail, implement, pass. Run the whole `apps/web` worker project.
- [ ] Commit: `feat(web): brand timeline read merging change history and Ads events (FUS-380)`

---

### Task 5: Client timeline module and API methods

**Files:**
- Create: `apps/web/src/client/timeline.ts`
- Modify: `apps/web/src/client/api.ts` (three methods next to `deploys`, with `// spec timeline`)
- Test: `apps/web/test/timeline-client.test.ts`

**Interfaces (`client/timeline.ts`):**
- `ADS_EVENT_LABEL: Record<AdsEventType, string>`, `ADS_EVENT_TONE: Record<AdsEventType, Tone>`, `CHANGE_CATEGORY_LABEL: Record<ChangeCategory, string>` (spec D2 and D5 strings).
- `type RangePreset = "7d" | "30d" | "90d" | "all"`; `interface TimelineFilters { range: RangePreset | { from: string | null; to: string | null } /* YYYY-MM-DD */; types: TimelineType[] /* all = every type */ }`.
- `parseTimelineSearch(search: string): TimelineFilters` (default `30d`, all types; an unknown type id is dropped; a bad date reads as null) and `timelineSearch(filters): string` (`""` for the defaults; `?range=7d`, `?from=..&to=..`, `&types=` only when not all). Round-trip: `parseTimelineSearch(timelineSearch(f))` equals `f`.
- `filtersToQuery(filters, now: Date): { from?: string; to?: string; types?: string }`: presets count back from `now` (7d = now minus 7×24 h); custom dates are local-day bounds (`from` 00:00:00.000 local, `to` 23:59:59.999 local) as UTC ISO; `types` omitted when all.
- `groupByDay(items: TimelineItem[]): { day: string /* local YYYY-MM-DD */; items: TimelineItem[] }[]` keeping order.
- `sinceLastChange(items: TimelineItem[]): Map<string /* event item_id */, { change: Extract<TimelineItem, { kind: "change" }>; ms: number }>`: for each ads_event item, the newest change with `at` ≤ the event `at` (by `Date.parse`); none gives no entry.
- `fmtSince(ms: number): string`: the `fmtDuration` format of `Deploys.tsx`, plus days past 48 hours: `"<d> วัน (<d>d)"` (and `"<d> วัน <h> ชม. (<d>d <h>h)"` when hours remain).
- `isNearChange(ms: number): boolean`: `ms <= 24 * 3600_000`.
- `localInputNow(now: Date): string` (`YYYY-MM-DDTHH:mm` local, for `datetime-local`) and `localInputToIso(value: string): string | null`.
- `api.brandTimeline(brandId, query)` (GET, parses `TimelineResponse`), `api.createAdsEvent(brandId, body)` (POST, parses `{ event: AdsAccountEvent }`), `api.deleteAdsEvent(brandId, eventId)` (DELETE). Path segments through `encodeURIComponent`.

**Tests (`timeline-client.test.ts`, worker project; fix the time zone by building local dates with `new Date(y, m, d, ...)` and comparing ISO output of the same construction):**
- "parseTimelineSearch defaults to 30d and all types"; "timelineSearch round-trips custom dates and a type subset"; "unknown type ids and bad dates are dropped".
- "filtersToQuery: 7d preset counts back 7 days; custom dates are local day bounds; all types omits types".
- "groupByDay splits at local midnight and keeps order".
- "sinceLastChange picks the newest earlier change, ignores a later one, and gives no entry without an earlier change".
- "fmtSince formats 45 s, 5 min, 3 h 10 min, 3 days".
- "localInputToIso round-trips localInputNow".

- [ ] Tests first, fail, implement, pass.
- [ ] Commit: `feat(web): brand timeline client filters, grouping and since-last-change marker (FUS-380)`

---

### Task 6: Timeline screen: list, filters, notes

**Files:**
- Create: `apps/web/src/client/screens/BrandTimeline.tsx` (export `BrandTimelineScreen({ me, brandId }: { me: Me; brandId: string })`)
- Create: `apps/web/src/client/screens/BrandTimeline.css`
- Test: `apps/web/test/brand-timeline.ui.test.tsx`

**Behavior:** spec D6 items 1, 2, 4 (without Delete), 5, 6 and spec D7. The filter bar reads `useSearch()` and writes with `navigate(location.pathname + timelineSearch(next), { replace: true })`. Each load sends `api.brandTimeline(brandId, filtersToQuery(filters, new Date()))`; a late answer for old filters is ignored. All types unchecked shows the empty state with no request. Rows get `id="tl-<item_id>"`. Markers: `tl-marker-change` (square) for changes, `tl-marker-event tl-tone-<tone>` (round) for events; `tl-near-change` on events within 24 h of their change. Reuse `Spinner`, `EmptyState`, `StatusBadge`, `BrandLabel`, `NotFound`, `operationLabel`, `statusBadgeTone`, `statusLabel`.

**Tests (mock `fetch` the way `deploys.ui.test.tsx` does):**
- "renders change and event rows grouped by day with distinct markers".
- "an install row shows template and form versions from and to".
- "an event row shows the since-last-change line linking to the change row, and is highlighted within 24 h".
- "checking a type filter updates the URL and sends types in the request"; "the 7-day preset sends from".
- "unchecking every type shows the empty state without a request".
- "shows the core_audit note, the has_more note, and the own-scope hint for an employee".
- "a failed load shows Retry and a retry reloads"; "a 404 shows Brand not found".

- [ ] Tests first, fail, implement, pass (`--project ui brand-timeline`).
- [ ] Commit: `feat(web): brand timeline screen with filters and change markers (FUS-380)`

---

### Task 7: Add event form and Owner-only delete

**Files:**
- Modify: `apps/web/src/client/screens/BrandTimeline.tsx` (form section and delete button)
- Modify: `apps/web/src/client/screens/BrandTimeline.css` (if needed)
- Test: `apps/web/test/brand-timeline-events.ui.test.tsx`

**Behavior:** spec D6 items 3 and 4 (Delete). The form opens with `localInputNow(new Date())`; submit converts with `localInputToIso`; the note counter shows `n/500`; `other` with an empty note disables submit and shows "ต้องใส่หมายเหตุสำหรับประเภทอื่น ๆ (A note is required for Other)". 422 issues show under the matching field (`path` `type`, `occurred_at`, `note`). Delete uses `useConfirm` as in spec D6.

**Tests:**
- "the time input defaults to now and the POST body carries the chosen type, ISO time and note".
- "success shows the toast, resets the form and reloads the list".
- "a 422 shows the issue under the time field"; "Other with an empty note disables submit".
- "an employee sees no Delete button"; "an owner deletes after confirming; Cancel sends no request".

- [ ] Tests first, fail, implement, pass.
- [ ] Commit: `feat(web): add Ads account events and Owner-only delete on the brand timeline (FUS-380)`

---

### Task 8: Route and entry link

**Files:**
- Modify: `apps/web/src/client/router.ts` (`{ view: "brand-timeline"; brandId: string }` in `Route` under a `// spec timeline` line; `parseRoute` matches `^/brands/([^/]+)/timeline$` before `one`; `routePath` case)
- Modify: `apps/web/src/client/App.tsx` (render `BrandTimelineScreen` for the route; `SidebarNav current` gets `"brands"` when the view is `brand-timeline`)
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (one `<a className="btn" href=…>ไทม์ไลน์ (Timeline)</a>` in the first `side-actions` row, shown for every brand, unmanaged included; plain left click calls `navigate`, see `isPlainLeftClick`). If the first row only renders for managed brands, add the link to the `site` row or a new one-line row, and record the choice.
- Test: `apps/web/test/brand-timeline-route.ui.test.tsx`

**Tests:**
- "parseRoute reads /brands/b1/timeline and routePath builds it back; a bad escape reads as not-found or the brands list, matching how parseRoute treats `/brands/%`".
- "the brand detail panel shows a Timeline link to /brands/<id>/timeline and a click navigates".
- "opening /brands/b1/timeline renders the timeline screen with Brands active in the sidebar".
- Existing `router.ui.test.tsx` and `app.ui.test.tsx` stay green.

- [ ] Tests first, fail, implement, pass. Then the full `bun run --cwd apps/web test` and root `bun run typecheck`.
- [ ] Commit: `feat(web): brand timeline route and entry link from the brand panel (FUS-380)`
