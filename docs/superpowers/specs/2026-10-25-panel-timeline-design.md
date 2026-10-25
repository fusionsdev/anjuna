# Panel brand timeline design (spec 6, FUS-380, phase 1)

Source: ship order step 6 in `2026-10-23-panel-backlog-and-order.md` (backlog item 10, phase 1 only). Tracking issue: FUS-380. Owner decision 2026-10-23: manual account-event marks first, AdKit pull later. Debate decision: no passive bot logging until byte-identity tests exist. Builds on spec 1 (FUS-374), spec A (FUS-375), spec B (FUS-376), spec C (FUS-377) and spec 4 (FUS-378), all merged on main at 9f083e8.

## Scope

In scope, from the FUS-380 description:

1. A per-brand timeline screen at `/brands/:id/timeline`, reached from the brand detail panel.
2. One time-ordered list that merges (a) change history already stored and (b) manual Google Ads account events.
3. Manual event entry for owner and employee: type, time (defaults to now, editable), note. Stored in D1 through a new migration. Every create and every delete writes an audit row. Delete is Owner-only.
4. Filters by type and by date range. Markers that make "a change, then an account event" readable.

Out of scope: any server-side bot, user-agent or visit logging in brand Workers or core; the AdKit pull (phase 2); any response variation (AGENTS.md rule 3); editing an event (delete and re-create instead); a cross-brand events view.

## Baseline (origin/main 9f083e8)

- The panel Worker binds the factory D1 as `env.FACTORY` (`apps/web/src/server/env.ts`). It never binds the leads D1.
- `factory.audit_log` is append-only (update and delete triggers). The panel writes factory actions through `writeFactoryAudit` in `apps/web/src/server/audit.ts`, gated by the `FACTORY_AUDIT_PREFIXES` allowlist.
- Core writes `brand.update`, `brand.pause` and `brand.resume` rows (old and new values) and serves them through `listAudit` (`target_type`, `target_id`, `actor_id`, `cursor`, `limit` up to 200). There is no date filter on `listAudit`.
- `apps/web/src/server/deploys.ts` (spec C) already merges three change sources into `DeployEvent` rows, newest first:
  - `installEvents`: factory `installs` rows (install, rollback, upgrade, redeploy), with `from_revision_id` and `to_revision_id`;
  - `factoryAuditEvents`: factory audit rows whose action is in `DEPLOY_AUDIT_ACTIONS` (`brand.create`, `brand.duplicate`, `brand.draft_update`, `brand.profile`, `brand.asset`, `checklist.attest`);
  - `coreAuditEvents`: core audit rows whose action is in `CORE_DEPLOY_AUDIT_ACTIONS`.
  An employee sees every install row but only their own audit rows, the same scope as `/api/audit`. When core cannot be read, the response lists `unavailable: ["core_audit"]` and still answers 200.
- Template and form versions of a deploy live in `brand_revisions.template_version_id` and `form_artifacts.bundle_form_version` (joined in `brandRevisions` in the same file).
- A brand can be `unmanaged`: it exists in core `brand_runtime` but has no factory `brands` row. Such a brand has core audit rows but no install rows.
- The router (`router.ts`) parses `/brands/:id` to `{ view: "brands", brandId }`. Any deeper brand path is `not-found` today.
- `PANEL_ROLE_TABLE` is asserted key by key in `apps/web/test/api.test.ts` ("panel-only actions follow the plan's matrix").

## Decisions

### D1. Manual events live in the factory D1

New migration `packages/factory-db/migrations/0009_ads_account_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS ads_account_events (
  event_id     TEXT PRIMARY KEY,                 -- crypto.randomUUID()
  brand_id     TEXT NOT NULL,                    -- factory or core brand id; no FK, an unmanaged brand has no factory row
  type         TEXT NOT NULL CHECK (type IN ('ad_disapproved', 'account_suspended', 'account_reinstated',
                                             'policy_warning', 'bot_visit_observed', 'other')),
  occurred_at  TEXT NOT NULL,                    -- ISO 8601 UTC, when it happened in the Ads account
  note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by   TEXT NOT NULL,                    -- auth user id
  created_role TEXT NOT NULL CHECK (created_role IN ('owner', 'employee')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_account_events_brand ON ads_account_events(brand_id, occurred_at);
```

Why factory and not leads: the panel already binds the factory D1 and writes its audit rows there, so an insert and its audit row commit in one `db.batch`. Binding the leads D1 to the panel would break the rule in `env.ts`. The rows are operator notes, never lead data, so AGENTS.md rule 5 holds.

Delete removes the row. The `ads_event.delete` audit row keeps the full event in `before_json`, so nothing is lost.

`FACTORY_DB_MIGRATIONS` gains `"0009_ads_account_events.sql"`. Applying it to the remote D1 is a deploy step after merge (owner-gated, Wave 4); the PR body says so.

### D2. Event types

| Type id | Label | Marker tone (`StatusBadge` `Tone`) |
|---|---|---|
| `ad_disapproved` | โฆษณาถูกปฏิเสธ (Ad disapproved) | `bad` |
| `account_suspended` | บัญชีถูกระงับ (Account suspended) | `bad` |
| `account_reinstated` | บัญชีกลับมาใช้ได้ (Account reinstated) | `live` |
| `policy_warning` | คำเตือนนโยบาย (Policy warning) | `warn` |
| `bot_visit_observed` | พบการเข้าชมของบอท (Bot visit observed) | `warn` |
| `other` | อื่น ๆ (Other) | `mute` |

`bot_visit_observed` is a mark the operator types after seeing a bot in Google Ads or in the Traffic screen. Nothing records visits for it, and nothing in any brand response depends on it.

### D3. Roles

`PANEL_ROLE_TABLE` gains three entries, appended after `viewSettings`:

- `viewBrandTimeline: "employee"`
- `createAdsEvent: "employee"`
- `deleteAdsEvent: "owner"`

The read follows the `/api/deploys` scope: install rows and manual events are visible to both roles in full; audit-sourced change rows are all rows for an owner and only the caller's own rows for an employee. The response says which (`actor_scope: "all" | "own"`), and the screen shows a hint to an employee.

### D4. Panel routes (new module `apps/web/src/server/timeline.ts`, `// spec timeline`)

All three routes take `:id` through `decodePathSegment` and validate it with `BrandId` (400 `invalid_brand_id`). `index.ts` calls `handleTimelineRoute` right after `handleDeployRoute`, before any `/api/brands/:id` proxy.

Brand existence (`brandExists`): a factory `brands` row with that id, or else core `getBrand` answering 200. Otherwise 404 `{ error: "not_found", resource: "brand" }`. A core failure other than 404 during this check answers 502 `bad_gateway`.

#### `GET /api/brands/:id/timeline`

Query (`TimelineQuery`, strict, from the URL search params):

- `from`, `to`: optional `Timestamp`; `from` must not be after `to` (422).
- `types`: optional comma list of `TimelineType` (the four change categories in D5 plus the six event types); empty or absent means all.
- `limit`: optional integer 1 to 200, default 100.

Steps:

1. `authorizePanel("viewBrandTimeline")`; 403 `forbidden_role`.
2. `brandExists`.
3. Read the requested sources, each filtered to the brand and the range (`julianday(x) >= julianday(from)` and `<= julianday(to)` in SQL; in memory for core audit), each asking for `limit + 1` rows:
   - install rows, through `installEvents` from `deploys.ts`;
   - factory audit rows, through `factoryAuditEvents`;
   - core audit rows, through `coreAuditEvents`;
   - manual events from `ads_account_events`, by `occurred_at`.
   `deploys.ts` exports the three functions and gives each an optional `range: { from?: string; to?: string }` argument. With no range their SQL and results are unchanged, so `/api/deploys` keeps its behavior.
4. For install rows, join the from and to revisions: `{ revision, template_version_id, bundle_form_version }` or null.
5. Map to `TimelineItem` (D5), sort newest instant first (ties by `item_id` descending), cut to `limit`.
6. Answer 200 `{ brand_id, items, has_more, unavailable, actor_scope }`. `has_more` is true when the merged list is longer than `limit` before the cut, or core returned a `next_cursor`. Core `listAudit` has no date filter, so core rows come from the newest 200 for the brand; a range older than those shows no core rows (phase 1 limit, listed in the PR). `unavailable` is `["core_audit"]` when core audit could not be read, else `[]`.

A source whose types are all filtered out is not queried.

#### `POST /api/brands/:id/ads-events`

Body (`CreateAdsEventRequest`, strict): `{ type: AdsEventType, occurred_at: Timestamp, note: string }`.

1. `authorizePanel("createAdsEvent")`; 403.
2. Parse; 422 `{ error: "invalid", issues }` on failure. Extra rules, each a 422 issue: `note` is trimmed and at most 500 characters; `note` is required (non-empty after trim) when `type` is `other`; `occurred_at` is not before `2020-01-01T00:00:00.000Z` and not more than 5 minutes after the server's now.
3. `brandExists`.
4. One `env.FACTORY.batch`: the insert, and an audit row `ads_event.create`, `entity_type "brand"`, `entity_id` = brand id, `after_json` = the stored event. Actor from `ctx`.
5. Answer 201 `{ event: AdsAccountEvent }`.

#### `DELETE /api/brands/:id/ads-events/:eventId`

1. `authorizePanel("deleteAdsEvent")`; 403 for an employee.
2. Load the event by `event_id` and `brand_id`; 404 `{ error: "not_found", resource: "ads_event" }` when missing.
3. One `env.FACTORY.batch`: the delete, and an audit row `ads_event.delete` with `before_json` = the event and no `after_json`.
4. Answer 200 `{ deleted: AdsAccountEvent }`.

`audit.ts`: `FACTORY_AUDIT_PREFIXES` gains `"ads_event"`, and a new exported `factoryAuditStatement(db, input): D1PreparedStatement` builds the same insert `writeFactoryAudit` runs (which then uses it), so the routes can batch it. The `ads_event.*` actions are not in `DEPLOY_AUDIT_ACTIONS`, so they never show as change rows; the manual event itself is the row. They show on the Audit screen.

### D5. Item shapes (panel-only schemas in `apps/web/src/shared/timeline.ts`)

```ts
AdsEventType = z.enum(["ad_disapproved", "account_suspended", "account_reinstated", "policy_warning", "bot_visit_observed", "other"]);
ChangeCategory = z.enum(["config", "pause_resume", "deploy", "factory_edit"]);
TimelineType = z.union([ChangeCategory, AdsEventType]);
AdsAccountEvent = z.strictObject({ event_id, brand_id: BrandId, type: AdsEventType, occurred_at: Timestamp, note: z.string().max(500),
  created_by: ActorId, created_role: z.enum(["owner", "employee"]), created_at: Timestamp });
RevisionRef = z.strictObject({ revision: z.number().int().positive(), template_version_id: Id, bundle_form_version: FormVersion.nullable() });
TimelineItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("change"), item_id: z.string(), at: Timestamp, category: ChangeCategory,
    change: DeployEvent, from_revision: RevisionRef.nullable(), to_revision: RevisionRef.nullable() }),
  z.strictObject({ kind: z.literal("ads_event"), item_id: z.string(), at: Timestamp, event: AdsAccountEvent }),
]);
TimelineResponse = z.strictObject({ brand_id: BrandId, items: z.array(TimelineItem), has_more: z.boolean(),
  unavailable: z.array(DeployUnavailableSource), actor_scope: z.enum(["all", "own"]) });
```

Change category of a `DeployEvent`:

| Category | Rows | Label |
|---|---|---|
| `config` | core `brand.update` | แก้ค่าแบรนด์ (Config change) |
| `pause_resume` | core `brand.pause`, `brand.resume` | หยุด/เปิดแบรนด์ (Pause/Resume) |
| `deploy` | every install row (install, redeploy, upgrade, rollback) | ติดตั้ง/ย้อนกลับ (Deploy/Rollback) |
| `factory_edit` | factory `DEPLOY_AUDIT_ACTIONS` rows | แก้ไขใน factory (Factory edit) |

`item_id` is the `DeployEvent.event_id` for a change and `ads-<event_id>` for a manual event. `at` is `started_at` for a change and `occurred_at` for a manual event. No schema goes into `packages/contracts` (the parallel lane FUS-379 edits `admin-api.ts`).

### D6. Screen `/brands/:id/timeline`

Router: `Route` gains `{ view: "brand-timeline"; brandId: string }`. `parseRoute` maps `/brands/<id>/timeline` (one decoded segment; `new` is not reserved here because `/brands/new/timeline` is not a wizard path); `routePath` builds it back. The sidebar marks "แบรนด์" active on this route. `App.tsx` renders `BrandTimelineScreen`.

Entry: the brand detail panel in `BrandLifecycle.tsx` gains one link "ไทม์ไลน์ (Timeline)" in its first `side-actions` row, for every brand including unmanaged, navigating with `navigate()` (plain left click) and keeping a real `href` for a new tab.

Screen layout, top to bottom:

1. Header: `BrandLabel` (domain first, from `useBrandLabels`), title "ไทม์ไลน์แบรนด์ (Brand timeline)", a back link "กลับไปที่แบรนด์ (Back to brand)" to `/brands/:id`.
2. Filter bar:
   - Date range presets "7 วัน", "30 วัน" (default), "90 วัน", "ทั้งหมด (All)", plus two `type="date"` inputs "ตั้งแต่ (From)" and "ถึง (To)". A date means the local day: `from` = local 00:00:00.000, `to` = local 23:59:59.999, both sent as UTC ISO.
   - Type checkboxes in two groups: "การเปลี่ยนแปลง (Changes)" with the four categories, and "เหตุการณ์บัญชี Ads (Ads account events)" with the six types. All checked by default. Unchecking all of them is allowed and shows the empty state without a request.
   - "ล้างตัวกรอง (Reset filters)".
   - The filter state lives in the URL query (`?range=30d` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`, `&types=a,b` only when not all are checked), read with `useSearch`, written with `navigate(..., { replace: true })`, so reload and Back keep it.
3. "บันทึกเหตุการณ์ (Add event)" form, shown to both roles: type select (D2 labels), `type="datetime-local"` input defaulting to the local now at form open, note textarea (500 characters, counter, required for `other`). Submit sends `POST`; success shows `Toast` "บันทึกเหตุการณ์แล้ว (Event saved)", resets the form to now, and reloads the list. A 422 shows the issues under the fields; other errors show `ApiError.thai`. Submit is disabled while in flight.
4. The list, newest first, grouped by local day with a day heading (`th-TH` long date). Each row:
   - a marker: a change row has a square marker with class `tl-marker-change`; a manual event has a round marker with class `tl-marker-event tl-tone-<tone>` (D2 tone);
   - local time (`HH:mm`), with the full ISO in `<time dateTime>`;
   - change rows: the category label, then the operation label (`operationLabel`) or the action code, the status badge for install rows, and "template <from> → <to> · form <from> → <to>" when revisions are known and differ; the actor and role;
   - event rows: the type label as a `StatusBadge` with the D2 tone, the note, the actor and role, and the "since last change" line (D7);
   - an Owner-only "ลบ (Delete)" button on event rows, which asks `useConfirm` (tone `danger`, title "ลบเหตุการณ์นี้? (Delete this event?)", body names the type and time) and then sends `DELETE`; success shows a toast "ลบแล้ว (Deleted)" and reloads.
5. Notes: `unavailable` core audit shows the same text as `UNAVAILABLE_NOTE.core_audit` in `Deploys.tsx` (copied to the timeline module); `has_more` shows "แสดง <n> รายการล่าสุด ให้แคบช่วงวันที่เพื่อดูรายการเก่ากว่า (Showing the newest <n>; narrow the date range to see older items)"; `actor_scope: "own"` shows "คุณเห็นเฉพาะการแก้ไขที่คุณทำเอง การติดตั้งและเหตุการณ์ Ads แสดงครบ (You see only your own edits; deploys and Ads events are complete)".
6. States: `Spinner` while loading; an error card with "ลองใหม่ (Retry)" on a failed load; `EmptyState` "ไม่มีรายการในช่วงนี้ (Nothing in this range)" when `items` is empty. A 404 brand shows `NotFound` "ไม่พบแบรนด์ (Brand not found)".

At 375 px the page has no sideways scroll; the filter bar wraps.

### D7. "Change, then event" marker

For each manual event row, the screen finds the newest change row (any category in the loaded list) whose `at` is at or before the event's `at`. When one exists, the row shows: "หลังการเปลี่ยนแปลง <duration> (<duration> after: <change label>)", where the change label is the category label plus the operation or action, and the duration uses the format of `fmtDuration` in `Deploys.tsx` (seconds, minutes, hours, then days "<d> วัน (<d>d)" past 48 hours). The text links to the change row (in-page anchor `#tl-<item_id>`). When no earlier change is loaded, the line is absent. The computation runs only over the loaded, filtered items, and with change categories filtered out no line shows.

Also, a manual event that falls within 24 hours after a change gets the class `tl-near-change` (a left border), so a run of "change then problem" stands out while scrolling.

### D8. No effect on brand traffic

Nothing in this spec changes `packages/brand-runtime`, `workers/core`, or any brand-served byte. The timeline reads stored rows; the manual events are typed by an operator. AGENTS.md rule 3 is untouched because no code path reads the new table except the panel.

## Acceptance criteria

1. AC1 `/brands/:id/timeline` renders for owner and employee, reached from a "ไทม์ไลน์ (Timeline)" link in the brand detail panel; reload keeps the route and filters.
2. AC2 The list merges install rows (with template and form version from and to), factory audit rows, core config and pause/resume rows, and manual events, newest first, grouped by day.
3. AC3 An owner and an employee can add an event with type, time (defaults to now, editable) and note; the row is stored in `ads_account_events` and one `ads_event.create` audit row is written in the same batch.
4. AC4 Delete is Owner-only: the button shows to an owner only, the route answers 403 to an employee, and a delete writes one `ads_event.delete` audit row holding the old event.
5. AC5 Invalid input answers 422: unknown type, a time before 2020 or more than 5 minutes ahead, a note over 500 characters, an empty note for `other`, `from` after `to`.
6. AC6 Filters by type and date range narrow the list on the server; presets and custom dates work; the state is in the URL.
7. AC7 Change rows and event rows carry distinct markers; an event row shows how long after the latest earlier change it happened, and events within 24 hours of a change are highlighted.
8. AC8 Core audit failure still answers 200 with `unavailable: ["core_audit"]` and a note; an employee sees only their own audit-sourced rows with a hint; `has_more` shows the narrow-the-range note.
9. AC9 `/api/deploys` behavior is unchanged (its existing tests pass unmodified).
10. AC10 Migration 0009 applies cleanly and re-applies as a no-op; no file under `packages/brand-runtime`, `workers/` or `spike/` changes.
11. AC11 `bun run typecheck` and `bun run test` green.
