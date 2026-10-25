# Panel traffic and client error log design (spec D, FUS-379)

Source: ship order step 5 in `2026-10-23-panel-backlog-and-order.md`. Tracking issue: FUS-379. Reference: the AURUM Observe Admin Traffic page. Builds on spec 1 (FUS-374), spec A (FUS-375), spec B (FUS-376), spec C (FUS-377) and spec 4 (FUS-378), all merged on main at 9f083e8.

## Scope

In scope, from the FUS-379 description:

1. A `/traffic` screen: landing views, form starts, leads submitted, validation errors and redirect errors for 24h, 7d and 30d.
2. Breakdowns by brand (domain), hostname, device, browser and source.
3. An hourly (24h) or daily (7d, 30d) trend as inline SVG.
4. A recent events table: the last 200 events, no PII, an opaque session reference.
5. CSV export of the recent events table (no PII).
6. An `/errors` screen: the `client_errors` list with filters (brand through the session, error type, time range), counts per type and cursor paging.
7. Data from the existing D1 tables `traffic_events` and `client_errors` through new read-only core admin routes. The panel proxies them. Employee-visible: no PII, no money.

Out of scope: a live SSE feed, bot detection or blocking, risk scoring, any change to the Funnel screen, any change to telemetry ingest, any new D1 migration or index.

## Baseline (origin/main 9f083e8)

- `traffic_events` (`packages/leads-db/migrations/0001_v1_baseline.sql:179`) holds one row per telemetry event. Core writes it in `workers/core/src/analytics.ts` `telemetry()`. `hostname` comes from the authenticated envelope with `www.` stripped. `created_at` is core time. `occurred_at` is client time. `event_type` is one of `gate_viewed`, `landing_viewed`, `form_started`, `form_step_viewed`, `form_step_completed`, `form_validation_failed`, `lead_submission_started`, `lead_submitted`, `redirect_started`, `redirect_failed`. `error_code`, `device_class` and `browser_family` are allow-listed at ingest. `source` and `campaign` are cleaned free text (64 chars). `brand` is a client display name and is never an identity. `click_session_id` joins to a gclid.
- `client_errors` (`0001_v1_baseline.sql:116`) has `id`, `session_id`, `error_type`, `error_message`, `screen_id`, `occurred_at`. It has no hostname and no `created_at`. Core `errors()` writes every field from the visitor's body: `occurred_at` is client text (40 chars), `error_message` is free text (200 chars). The lead form sends `error_type` `timeout` or `submission_error` and `err.message` as the message (`apps/lead-form/src/App.tsx:1493`). The table has no index except the primary key.
- Index on `traffic_events`: `(created_at, form_step, event_type)`, `(hostname, created_at)`, `(session_id, occurred_at)`, `(click_session_id)`.
- Core `GET /admin/traffic/breakdown` (`workers/core/src/admin/traffic.ts`) serves the Funnel screen: visits and leads per session, attributed to the session's entry event, brand from `brand_runtime.hostnames`. It stays unchanged.
- `trafficWindow(period, now)` in `packages/contracts/src/traffic.ts` gives UTC calendar periods that include today, upper bound exclusive.
- The panel proxies core report routes in `apps/web/src/server/index.ts` with `authorize(endpoint, role)` and `fromCore(callCore(...))`. `callCore` parses every core response with the contract schema. CSV cells go through `csvRows` in `apps/web/src/server/csv.ts`, which neutralises formula prefixes.
- Conversions (FUS-375) sets the precedent for free text: core nulls `last_error` for a non-owner.
- `AdminApi` has 19 endpoints. `packages/contracts/test/admin-api.test.ts` asserts the count and that every fixture file in `fixtures/admin` is covered.

## Decisions

### D1. Two new core endpoints in their own contract module

New file `packages/contracts/src/traffic-log.ts` (comment `// spec traffic`), exported from `index.ts`. Two `AdminApi` entries, added as one block with a `// spec traffic` comment:

- `trafficReport`: `GET /admin/traffic/report`, `min_role: "employee"`, query `TrafficReportQuery`, response `TrafficReportResponse`.
- `clientErrors`: `GET /admin/client-errors`, `min_role: "employee"`, query `ClientErrorsQuery`, response `ClientErrorsResponse`.

Both are pure reads. Neither writes a row, an audit entry or a log line with request data.

### D2. Periods and windows

`TrafficLogPeriod = z.enum(["24h", "7d", "30d"])`, default `"24h"`. `trafficLogWindow(period, now)` returns `{ from, to, bucket }`:

- `24h`: `from` is the start of the current UTC hour minus 23 hours; `bucket` is `"hour"`; 24 buckets, the last one partial.
- `7d` and `30d`: `from` is `trafficWindow(period, now).from` (UTC midnight 6 or 29 days back); `bucket` is `"day"`; 7 or 30 buckets.
- `to` is `now`, exclusive.

Traffic filters on `traffic_events.created_at` (core time). Client errors filter on `client_errors.occurred_at` (client text, the only time the table has). A row whose `occurred_at` is not an ISO timestamp compares as text and normally falls outside the window. The screen labels times as UTC.

### D3. Traffic report: five metrics, counted per session

A session is one `(lower(hostname), session_id)` pair, as in `traffic.ts`. Each metric counts sessions in the window with at least one event of its type:

| Metric | `event_type` |
|---|---|
| `landing_views` | `landing_viewed` |
| `form_starts` | `form_started` |
| `leads` | `lead_submitted` |
| `validation_errors` | `form_validation_failed` |
| `redirect_errors` | `redirect_failed` |

A session counts once per metric even when the form resends an event. A session with only an error event still counts in that error metric (the Funnel's visit filter does not apply here).

Attribution: each session takes `device`, `browser` and `source` from its first event in the window by `created_at, id` (empty or null reads `unknown`, as in `traffic.ts`). `brand_id` comes from `brand_runtime.hostnames` (exact or `www.` match); an unmatched host uses the host as its `brand_id`, as in `traffic.ts`. `brand` (the client display name) is never read.

`TrafficReportResponse` (strict):

- `period`, `from`, `to`, `bucket` (`"hour"` or `"day"`).
- `totals`: the five metrics.
- `breakdowns`: `{ brand, hostname, device, browser, source }`, each an array of `{ key, ...five metrics }`, sorted by `landing_views` desc, then `key` asc, at most `TRAFFIC_BREAKDOWN_LIMIT = 100` rows.
- `trend`: one entry per bucket from `from` to `to`, `{ at, ...five metrics }`, where `at` is the bucket start in ISO UTC. A bucket with no session is all zeros. A session lands in the bucket of its first event in the window.
- `recent`: the newest `TRAFFIC_RECENT_LIMIT = 200` events in the window by `created_at desc, id desc`, each `{ at, event_type, hostname, brand_id, form_step, error_code, device, browser, source, session_ref }`. `at` is `created_at`. `device`, `browser` and `source` are the row's own values (null when empty).

Fields that never leave core: `session_id`, `click_session_id`, `brand`, `browser_timezone`, `campaign`, `form_version`, `form_variant`, `build_id`, `occurred_at`, `clock_skew`, `touch_capable`, `risk_score`, `risk_signals`.

### D4. Opaque session reference

`session_ref` is the first 12 hex characters of SHA-256 over `` `session:${hostname}:${session_id}` `` (lower-case hostname, `www.` stripped), computed in core with `crypto.subtle`. The same function serves both endpoints, so an error row and a traffic row of one session show the same ref. The ref is shown and filtered on only; it never maps back to a session id in any response.

### D5. Client errors: brand through the session, owner-only message

`ClientErrorsQuery` (strict): `period` (TrafficLogPeriod, default `"24h"`), `brand_id` (BrandId, optional), `error_type` (string 1 to 64 chars, optional), `cursor` (`/^[1-9][0-9]{0,15}$/`, optional).

Brand: an error's hostname is `MIN(lower(hostname))` over `traffic_events` rows with the same `session_id`; its `brand_id` follows D3. An error with no matching traffic row has `hostname: null` and `brand_id: null`. A `brand_id` filter keeps only errors whose resolved `brand_id` equals it.

Paging: newest first by `id desc`, `CLIENT_ERRORS_PAGE_LIMIT = 50` rows. `next_cursor` is the last row's `id` as a string when one more row exists, else null. A request with `cursor` returns rows with `id < cursor`.

Counts: `counts` is `[{ error_type, count }]` for the period and brand filter, ignoring `error_type` and `cursor`, sorted by count desc then type asc, at most 50 types. The type chips show these, so picking a type never hides the other chips.

`ClientErrorsResponse` (strict): `period`, `from`, `to`, `counts`, `rows`, `next_cursor`. A row is `{ id, occurred_at, error_type, error_message, screen_id, hostname, brand_id, session_ref }`. `occurred_at` is a string of at most 40 characters (client text, not validated as a datetime). `screen_id` is a string or null (empty reads null). `session_ref` is null when `session_id` is empty.

`error_message` is free text from a public endpoint and could hold anything a visitor typed. Core returns it only when `actor_role` is `owner`; for an employee it is null. Same rule as Conversions `last_error`.

### D6. Panel server routes

New module `apps/web/src/server/traffic-log.ts` (`// spec traffic`), called from `index.ts` with one added line next to `handleTrafficRiskRoute`:

- `GET /api/traffic/report?period=` -> `authorize("trafficReport")`, proxy core.
- `GET /api/traffic/report.csv?period=` -> `authorize("trafficReport")`, call core, answer `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="traffic-<period>.csv"` and `Cache-Control: no-store`. Columns, in order, from `TRAFFIC_RECENT_COLUMNS`: `at, event_type, hostname, brand_id, form_step, error_code, device, browser, source, session_ref`. Rows through `csvRows`. A core error passes through as JSON with its status, as `fromCore` does.
- `GET /api/client-errors?period=&brand_id=&error_type=&cursor=` -> `authorize("clientErrors")`, proxy core.

Both endpoints are `min_role: "employee"`, so an employee and an owner see the same screens. No `PANEL_ROLE_TABLE` entry is added.

`mock-core.ts` gains the two endpoints in one block (`// spec traffic`) that answers from two new golden fixtures, `traffic-report.response.json` and `client-errors.response.json`, with the query's `period` echoed and the employee view nulling `error_message`.

### D7. Screens

Routes `/traffic` and `/errors` join `router.ts` `STATIC`. Nav items after "ฟันเนล": "ทราฟฟิก (Traffic)" and "ข้อผิดพลาดฝั่งเว็บ (Client errors)", both shown to every role. `pageTitle` gains the same two labels.

`screens/Traffic.tsx`:

- Period chips "24 ชม. (24h)", "7 วัน (7d)", "30 วัน (30d)". The period lives in the URL (`?period=`, default 24h omitted), read with `useSearch`, as Conversions does.
- Five stat tiles with the totals: "เข้าชมหน้าแรก (Landing views)", "เริ่มกรอกฟอร์ม (Form starts)", "ส่งลีด (Leads)", "กรอกผิด (Validation errors)", "ส่งต่อไม่สำเร็จ (Redirect errors)".
- `components/TrendChart.tsx`: inline SVG, one polyline each for landing views and leads over the trend buckets, a `<title>` per bucket with every metric, `role="img"` and an `aria-label`. All-zero trend shows `EmptyState` "ยังไม่มีทราฟฟิกในช่วงนี้". Axis label "เวลา UTC".
- Breakdown tabs "แบรนด์", "โดเมน (Hostname)", "อุปกรณ์", "เบราว์เซอร์", "แหล่งที่มา (Source)", one `DataTable` for the selected tab with the key and five metric columns. The brand tab renders the key with `BrandLabel`.
- Recent events `DataTable` (200 rows): time, event, `BrandLabel`, step, error code, device, browser, source, session ref in monospace. A button "ดาวน์โหลด CSV" links to `/api/traffic/report.csv?period=<period>`.
- Loading `Spinner`, an error card with "ลองอีกครั้ง" retry, no request for a period that is not selected.

`screens/ClientErrors.tsx`:

- Period chips as above, a brand `<select>` built from `useBrandDomains()` with "ทุกแบรนด์" first, and type chips from `counts` with "ทั้งหมด" first, each showing its count. All filters live in the URL (`?period=&brand=&type=`); an unknown value reads as the default.
- `DataTable`: time (as stored), type, `BrandLabel` (or "—"), screen, session ref, message. A null message shows "— (Owner only)" for an employee and "—" for an owner when the stored message is empty.
- "โหลดเพิ่ม (Load more)" appends the next page with `cursor`; a filter change resets the list.

### D8. Observe only (AGENTS.md rule 3)

No file under `packages/brand-runtime/`, `apps/lead-form/` or `workers/core/src/analytics.ts` changes. The new core modules hold only `SELECT` statements; a test reads both module sources and fails on `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP` or `ALTER`. Nothing a brand serves changes.

## Acceptance criteria

1. AC1: `GET /admin/traffic/report` returns the five per-session metrics for 24h, 7d and 30d with D2 windows. Evidence: core test.
2. AC2: Breakdowns by brand, hostname, device, browser and source, entry-attributed, capped at 100. Evidence: core test.
3. AC3: The trend has 24 hourly or 7/30 daily buckets with zero-filled gaps. Evidence: core test and TrendChart UI test.
4. AC4: Recent events: at most 200, newest first, no field outside D3, a 12-hex `session_ref`. Evidence: core test asserting no `session_id`, `click_session_id` or `brand` text in the JSON.
5. AC5: CSV export of the recent table with the D6 columns and formula-safe cells. Evidence: panel server test.
6. AC6: `GET /admin/client-errors` filters by period, brand (through the session) and type, pages with a cursor, and counts per type ignoring the type filter. Evidence: core test.
7. AC7: `error_message` is null for an employee and present for an owner. Evidence: core test and panel server test.
8. AC8: `/traffic` and `/errors` screens render, change period and filters through the URL, and show loading, empty and error states. Evidence: UI tests.
9. AC9: Both screens and routes are open to employee and owner; the panel server checks `authorize()` for each route. Evidence: panel server test with both roles.
10. AC10: Observe only: the new core modules hold only reads, and no ingest or brand file changes. Evidence: source scan test and `git diff --stat origin/main`.
11. AC11: `bun run typecheck` and `bun run test` green at the repo root.
