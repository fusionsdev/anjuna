# Panel traffic and client error log (spec D, FUS-379) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/traffic` screen (five per-session metrics, five breakdowns, an SVG trend, the last 200 events, CSV) and an `/errors` screen (`client_errors` with brand, type and period filters, counts per type, cursor paging), both employee-visible and read-only.

**Architecture:** One new contracts module defines two admin endpoints. Two new core modules answer them with `SELECT` only. One new panel server module proxies them and builds the CSV. Two new screens and one chart component render them. Shared files get one small block each.

**Tech Stack:** Bun workspaces, TypeScript strict, Zod contracts, Cloudflare Workers, D1, React 19, Vitest (`apps/web` projects `worker` for `test/**/*.test.ts`, `ui` for `test/**/*.ui.test.tsx`, `build` for `*.node.test.ts`; `workers/core` Miniflare harness in `test/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-10-25-panel-traffic-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `wrangler deploy`, no real external call, no secret in a file.
- No new D1 migration or index. No change under `spike/`, `packages/brand-runtime/`, `apps/lead-form/`, `packages/leads-db/`, or to `workers/core/src/analytics.ts` and `workers/core/src/admin/traffic.ts` (spec D8).
- The new core modules hold only `SELECT`. No audit row, no log line with request data.
- Fields that never leave core: `session_id`, `click_session_id`, `brand`, `browser_timezone`, `campaign`, `form_version`, `form_variant`, `build_id`, `traffic_events.occurred_at`, `clock_skew`, `touch_capable`, `risk_score`, `risk_signals` (spec D3).
- `error_message` is null for an employee (spec D5).
- New code goes in its own module with a `// spec traffic` comment. Shared files (`packages/contracts/src/admin-api.ts`, `packages/contracts/src/index.ts`, `workers/core/src/admin/index.ts`, `apps/web/src/server/index.ts`, `apps/web/src/server/mock-core.ts`, `apps/web/src/client/api.ts`, `apps/web/src/client/router.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/components/AppShell.tsx`) get the smallest possible addition, marked `// spec traffic`. Never reformat or reorder them. A parallel lane (FUS-380) edits the same files.
- UI copy is Thai first with English in parentheses, using the exact strings in the spec.
- Done per task: `bun run typecheck` at the repo root green plus the test suite of every package the task touched green.

## Review Focus

1. **A session that resends `lead_submitted`.** Expected: `leads` counts 1 for that session. Test in Task 2.
2. **A session whose later events have no source.** Expected: every metric of that session lands under the entry event's source. Test in Task 2.
3. **Leaks.** Expected: the report JSON never holds a raw `session_id`, `click_session_id` or the `brand` display name; the CSV has exactly the D6 columns. Tests in Tasks 2 and 4.
4. **Error brand via session.** An error whose session has traffic on `brand-a.example` has `brand_id: "brand-a"`; an error with no traffic row has null brand and is excluded by a brand filter. Test in Task 3.
5. **Cursor paging and type counts.** 51 rows give 50 plus a cursor; the next page holds the 51st; counts ignore the `error_type` filter. Test in Task 3.
6. **Employee view of `error_message`.** Null in core, null in mock core, "— (Owner only)" on screen. Tests in Tasks 3, 4 and 7.

---

### Task 1: Contracts for `trafficReport` and `clientErrors`

**Files:**
- Create: `packages/contracts/src/traffic-log.ts`
- Modify: `packages/contracts/src/index.ts` (one `export * from "./traffic-log.js";` line at the end)
- Modify: `packages/contracts/src/admin-api.ts` (import + one `// spec traffic` block of two entries at the end of `AdminApi`)
- Create: `packages/contracts/fixtures/admin/traffic-report.response.json`, `packages/contracts/fixtures/admin/client-errors.response.json`
- Modify: `packages/contracts/test/admin-api.test.ts` (two fixture cases, two `matchAdminRoute` asserts, endpoint count 19 -> 21)
- Test: `packages/contracts/test/traffic-log.test.ts`

**Interfaces (produced in `traffic-log.ts`):**
- `TRAFFIC_LOG_PERIODS = ["24h", "7d", "30d"] as const`, `TrafficLogPeriod` enum.
- `trafficLogWindow(period, now = new Date()): { from: string; to: string; bucket: "hour" | "day" }` per spec D2 (`7d`/`30d` reuse `trafficWindow`).
- `trafficLogBuckets(window): string[]`: ISO bucket starts from `from` up to `to` (24 for 24h, 7 or 30 days).
- `TRAFFIC_METRICS = ["landing_views", "form_starts", "leads", "validation_errors", "redirect_errors"] as const`, `TrafficMetrics` strict object of five non-negative ints.
- `TRAFFIC_BREAKDOWN_LIMIT = 100`, `TRAFFIC_RECENT_LIMIT = 200`, `CLIENT_ERRORS_PAGE_LIMIT = 50`, `CLIENT_ERROR_TYPES_LIMIT = 50`.
- `SessionRef = z.string().regex(/^[0-9a-f]{12}$/)`.
- `TrafficReportQuery = z.strictObject({ period: TrafficLogPeriod.default("24h") })`.
- `TrafficRecentEvent` strict: `at` (iso datetime), `event_type` (string 1..40), `hostname` (string), `brand_id` (string), `form_step` (int 1..40 nullable), `error_code`, `device`, `browser`, `source` (string nullable each), `session_ref` (SessionRef).
- `TRAFFIC_RECENT_COLUMNS = ["at", "event_type", "hostname", "brand_id", "form_step", "error_code", "device", "browser", "source", "session_ref"] as const` (the CSV order, spec D6).
- `TrafficReportResponse` strict: `period`, `from`, `to`, `bucket`, `totals: TrafficMetrics`, `breakdowns: { brand, hostname, device, browser, source }` (each `array(TrafficMetrics.extend({ key: string }))`, max 100), `trend: array(TrafficMetrics.extend({ at: iso datetime }))`, `recent: array(TrafficRecentEvent).max(200)`.
- `ClientErrorCursor = z.string().regex(/^[1-9][0-9]{0,14}$/)`.
- `ClientErrorsQuery` strict: `period` (default 24h), `brand_id: BrandId.optional()`, `error_type: z.string().min(1).max(64).optional()`, `cursor: ClientErrorCursor.optional()`.
- `ClientErrorRow` strict: `id` (positive int), `occurred_at` (string max 40), `error_type` (string 1..64), `error_message` (string max 200 nullable), `screen_id` (string max 64 nullable), `hostname` (string nullable), `brand_id` (string nullable), `session_ref` (SessionRef nullable).
- `ClientErrorsResponse` strict: `period`, `from`, `to`, `counts: array({ error_type, count }).max(50)`, `rows: array(ClientErrorRow).max(50)`, `next_cursor: ClientErrorCursor.nullable()`.
- `AdminApi.trafficReport` (`GET /admin/traffic/report`, employee) and `AdminApi.clientErrors` (`GET /admin/client-errors`, employee).

- [ ] **Step 1: Write failing tests** in `traffic-log.test.ts`:
  - "trafficLogWindow 24h starts 23 hours before the current UTC hour": now `2026-11-02T12:34:00.000Z` -> from `2026-11-01T13:00:00.000Z`, to now, bucket hour; `trafficLogBuckets` has 24 entries, first = from, last `2026-11-02T12:00:00.000Z`.
  - "trafficLogWindow 7d and 30d are UTC calendar days including today": 7d from `2026-10-27T00:00:00.000Z`, 7 day buckets; 30d from `2026-10-04T00:00:00.000Z`, 30 buckets.
  - "TrafficReportResponse rejects an extra field and a raw session id": the fixture with `recent[0].session_id` added fails; the fixture passes.
  - "ClientErrorsQuery rejects a bad cursor, an unknown period and an extra key": `cursor: "0"`, `cursor: "abc"`, `period: "today"`, `{ foo: 1 }` all fail; `{}` parses to `{ period: "24h" }`.
  - "ClientErrorsResponse accepts a null message and a null brand": fixture rows include one employee-style row.
  - In `admin-api.test.ts`: the two fixture cases, `matchAdminRoute("GET", "/admin/traffic/report")` -> `trafficReport`, `matchAdminRoute("GET", "/admin/client-errors")` -> `clientErrors`, `ADMIN_ENDPOINTS` length 21.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd packages/contracts test -- test/traffic-log.test.ts test/admin-api.test.ts`.
- [ ] **Step 3: Implement** the module, the fixtures (traffic: period `7d`, 7 trend entries, 2 rows per breakdown, 3 recent events; errors: 3 rows, one with null brand and null message, `next_cursor: null`), the index export and the `AdminApi` block.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(contracts): traffic report and client errors admin endpoints (FUS-379)`

---

### Task 2: Core `GET /admin/traffic/report`

**Files:**
- Create: `workers/core/src/admin/traffic-log.ts`
- Modify: `workers/core/src/admin/index.ts` (import + one `// spec traffic` `if (route.endpoint === "trafficReport")` block before the final `not_found`)
- Test: `workers/core/test/traffic-report.test.ts`

**Interfaces (produced):**
- `export async function sessionRef(hostname: string | null, sessionId: string): Promise<string>` — SHA-256 hex of `` `session:${host}:${sessionId}` `` where `host` is lower-case, `www.` stripped, empty or null -> `unknown`; first 12 chars.
- `export const BRAND_OF_HOST: string` — the SQL fragment that maps a `host` column to `brand_id` through `brand_runtime.hostnames` with the host fallback (same logic as `traffic.ts`, copied, not imported, so `traffic.ts` stays unchanged).
- `export async function loadTrafficReport(env: Pick<Env, "LEADS">, query: TrafficReportQuery, now = new Date()): Promise<TrafficReportResponse>`.

**SQL shape:** a `SESSIONS` CTE over `traffic_events WHERE created_at >= ?1 AND created_at < ?2`, one row per `(host, session_id)` with entry `created_at`, `device`, `browser`, `source` (first event by `created_at, id`, `unknown` for empty) and five `MAX(CASE WHEN event_type = ... THEN 1 ELSE 0 END)` flags, then `brand_id` via `BRAND_OF_HOST`. No visit filter. Then `SUM` of the flags for totals, `GROUP BY` for each of the five breakdowns (`ORDER BY landing_views DESC, key LIMIT 100`), and `GROUP BY` the bucket expression (`strftime('%Y-%m-%dT%H:00:00Z', entered_at)` or `strftime('%Y-%m-%dT00:00:00Z', entered_at)`) zero-filled in TypeScript with `trafficLogBuckets`. Recent: `SELECT created_at, event_type, hostname, session_id, form_step, error_code, device_class, browser_family, source, <brand_id>` ordered `created_at DESC, id DESC LIMIT 200`, mapped with `sessionRef`; `session_id` is dropped after hashing. Interpolated SQL is an allow-listed expression only. Parse the result with `TrafficReportResponse.parse`.

- [ ] **Step 1: Write failing tests** (seed like `traffic.test.ts`: `createHarness`, `seedBrand("brand-a")`, `seedBrand("brand-b")`, events on `brand-a.example` and `brand-b.example`, now `2026-11-02T12:00:00.000Z`):
  - "counts each metric once per session": session `one` with 2 `landing_viewed`, 1 `form_started`, 2 `lead_submitted` -> totals `landing_views` 1, `form_starts` 1, `leads` 1.
  - "counts an error-only session in its error metric": session with only `form_validation_failed` -> `validation_errors` 1, `landing_views` 0; session with `redirect_failed` -> `redirect_errors` 1.
  - "attributes a session to its entry source, device and browser": later events with null source still land under `google`; `breakdowns.source` = exact rows.
  - "maps hostnames to brand ids and falls back to the host": `brand` keys `brand-a`, `brand-b`, `unmapped.example`; `hostname` keys are hosts.
  - "excludes events outside the window": events at `2026-10-01` and at `now` (exclusive end) are absent for 7d.
  - "24h trend has 24 hourly buckets and 7d has 7 daily buckets, zero filled": length and a known non-zero bucket value; other buckets all zero.
  - "breakdowns stop at 100 rows": seed 101 distinct sources in one batch -> length 100.
  - "recent holds at most 200 events, newest first, with a 12-hex session_ref": seed 205 events; length 200; `at` sorted desc; `session_ref` matches `/^[0-9a-f]{12}$/` and equals `sessionRef("brand-a.example", "one")` for that session.
  - "never returns a raw session id, click session id or brand display name": seed `click_session_id = 'clk-secret-1'`, `brand = 'forged-brand'`, session id `sess-raw-123456`; `JSON.stringify(report)` contains none of the three.
  - "the admin route answers an employee and rejects a bad period": `h.admin("/admin/traffic/report?period=7d", employee)` -> 200 and parses; `period=today` -> 422.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd workers/core test -- test/traffic-report.test.ts`.
- [ ] **Step 3: Implement** the module and the route block.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run --cwd workers/core test -- test/traffic.test.ts test/admin.test.ts` and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(core): read-only traffic report admin route (FUS-379)`

---

### Task 3: Core `GET /admin/client-errors`

**Files:**
- Create: `workers/core/src/admin/client-errors.ts`
- Modify: `workers/core/src/admin/index.ts` (import + one `// spec traffic` `if (route.endpoint === "clientErrors")` block next to the Task 2 block)
- Test: `workers/core/test/client-errors.test.ts`

**Interfaces (produced):**
- `export async function loadClientErrors(env: Pick<Env, "LEADS">, query: ClientErrorsQuery, role: AdminRole, now = new Date()): Promise<ClientErrorsResponse>`.

**SQL shape:** a CTE over `client_errors WHERE occurred_at >= ?1 AND occurred_at < ?2` that adds `host = (SELECT MIN(lower(t.hostname)) FROM traffic_events t WHERE t.session_id = e.session_id)` when `session_id` is not empty, then `brand_id` via `BRAND_OF_HOST` from Task 2 (null when `host` is null). Rows: `WHERE (?3 IS NULL OR brand_id = ?3) AND (?4 IS NULL OR error_type = ?4) AND (?5 IS NULL OR id < ?5) ORDER BY id DESC LIMIT 51`; 51 rows -> 50 plus `next_cursor = String(rows[49].id)`. Counts: same CTE, brand filter only, `GROUP BY error_type ORDER BY count DESC, error_type LIMIT 50`. Map `screen_id` empty -> null, `session_ref` via `sessionRef(host, session_id)` or null for an empty session id, `error_message` -> null unless `role === "owner"` (empty stays `""` for an owner). Parse with `ClientErrorsResponse.parse`.

- [ ] **Step 1: Write failing tests** (now `2026-11-02T12:00:00.000Z`, `seedBrand("brand-a")`, `seedBrand("brand-b")`; traffic rows give session `s-a` host `brand-a.example`, `s-b` host `brand-b.example`; errors for `s-a`, `s-b`, `s-none` (no traffic) and one with empty session id):
  - "resolves the brand through the session": rows for `s-a` -> `brand_id` `brand-a`, hostname `brand-a.example`; `s-none` -> null, null.
  - "filters by brand, type and period": `brand_id=brand-a` keeps only `s-a` rows; `error_type=timeout` keeps only timeouts; an error at `2026-10-01` is out of 7d; an `occurred_at` of `not-a-date` is out of every period.
  - "counts per type ignore the type filter and follow the brand filter": with `error_type=timeout` the counts still list `submission_error`; with `brand_id=brand-b` counts only `s-b` rows.
  - "pages 50 rows newest first with an id cursor": seed 51 errors; page 1 has 50 rows ids desc and `next_cursor` = the 50th id; page 2 with that cursor has 1 row and `next_cursor: null`.
  - "hides error_message from an employee": owner row message `Failed to fetch`; employee same row null.
  - "session_ref matches the traffic report ref": equals `sessionRef("brand-a.example", "s-a")`; null for the empty session id.
  - "the admin route answers an employee and rejects a bad cursor": `h.admin("/admin/client-errors?period=7d", employee)` -> 200; `cursor=0` -> 422.
  - "new core read modules hold only SELECT statements": read `src/admin/traffic-log.ts` and `src/admin/client-errors.ts` as text; no match for `/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd workers/core test -- test/client-errors.test.ts`.
- [ ] **Step 3: Implement** the module and the route block. Pass `context.actor_role` as `role`.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run --cwd workers/core test` and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(core): read-only client errors admin route (FUS-379)`

---

### Task 4: Panel server routes, CSV and mock core

**Files:**
- Create: `apps/web/src/server/traffic-log.ts`
- Modify: `apps/web/src/server/index.ts` (import + one `handleTrafficLogRoute` call next to `handleTrafficRiskRoute`, `// spec traffic`)
- Modify: `apps/web/src/server/mock-core.ts` (fixture imports + one `// spec traffic` block for `trafficReport` and `clientErrors`)
- Test: `apps/web/test/traffic-log-api.test.ts`

**Interfaces (produced):**
- `export function trafficCsv(body: TrafficReportResponse): string` — `csvRows(TRAFFIC_RECENT_COLUMNS, body.recent)`.
- `export async function handleTrafficLogRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined>` — `GET /api/traffic/report`, `GET /api/traffic/report.csv`, `GET /api/client-errors` per spec D6; `authorize(endpoint, ctx.actor_role)` on each; JSON routes return `fromCore`-equivalent results; the CSV route returns `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="traffic-<period>.csv"` (period from the parsed query, default `24h`) and `Cache-Control: no-store`, or the core error as JSON with its status. Other paths return `undefined`.
- Mock core: `trafficReport` answers the fixture with `period`, `from`, `to`, `bucket` from `trafficLogWindow(query.period)` and `trend` rebuilt as zeros over `trafficLogBuckets` except the fixture's first entry; an invalid query -> 422. `clientErrors` answers the fixture filtered by `brand_id` and `error_type`, with `error_message: null` on every row when the actor is not owner; invalid -> 422.

- [ ] **Step 1: Write failing tests** (use `call`, `sessions`, `setupDatabases`, `resetState` from `./helpers`, as `conversions-api.test.ts` does):
  - "GET /api/traffic/report returns the parsed report to an employee and an owner".
  - "GET /api/traffic/report rejects an unknown period with 422".
  - "GET /api/traffic/report.csv returns the recent table with the spec columns": header line equals `TRAFFIC_RECENT_COLUMNS.join(",")`; row count = `recent.length`; content type, disposition `traffic-24h.csv`, no-store.
  - "trafficCsv neutralises a formula in source": a recent row with `source: "=HYPERLINK(1)"` -> cell `'=HYPERLINK(1)`.
  - "trafficCsv never writes a session id column": the header has no `session_id`, `click_session_id` or `brand`.
  - "GET /api/client-errors hides error_message from an employee and shows it to an owner".
  - "GET /api/client-errors forwards period, brand_id, error_type and cursor to core": spy on the mock as `conversions-api.test.ts` does; the forwarded URL holds all four.
  - "the three routes return 401 without a session".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project worker test/traffic-log-api.test.ts`.
- [ ] **Step 3: Implement** the module, the index.ts call and the mock block.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run --cwd apps/web test -- --project worker` and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): traffic report, CSV and client errors proxy routes (FUS-379)`

---

### Task 5: Client API methods and `TrendChart`

**Files:**
- Modify: `apps/web/src/client/api.ts` (three methods in one `// spec traffic` block: `trafficReport(period)`, `trafficReportCsvUrl(period)`, `clientErrors(filters)` returning parsed contract types)
- Create: `apps/web/src/client/components/TrendChart.tsx`
- Test: `apps/web/test/trend-chart.ui.test.tsx`

**Interfaces (produced):**
- `api.trafficReport(period: TrafficLogPeriod): Promise<TrafficReportResponse>`.
- `api.trafficReportCsvUrl(period: TrafficLogPeriod): string` -> `/api/traffic/report.csv?period=<period>`.
- `api.clientErrors(q: { period: TrafficLogPeriod; brand_id?: string; error_type?: string; cursor?: string }): Promise<ClientErrorsResponse>` — omits unset keys from the query.
- `export function TrendChart({ trend, bucket }: { trend: TrafficReportResponse["trend"]; bucket: "hour" | "day" })` — inline SVG per spec D7: `role="img"`, `aria-label="แนวโน้มทราฟฟิก (Traffic trend)"`, two `polyline`s with class `trend-landing` and `trend-leads`, one `<g>` per bucket with a `<title>` `"<label>: เข้าชม N, เริ่มกรอก N, ลีด N, กรอกผิด N, ส่งต่อไม่สำเร็จ N"` where `<label>` is `HH:00` (hour) or `YYYY-MM-DD` (day) in UTC, an axis caption "เวลา UTC", and `EmptyState` "ยังไม่มีทราฟฟิกในช่วงนี้" when every metric of every bucket is 0. Scale y to the largest `landing_views` or `leads`.

- [ ] **Step 1: Write failing tests**:
  - "renders one titled bucket per trend entry with every metric".
  - "labels hourly buckets HH:00 and daily buckets YYYY-MM-DD in UTC".
  - "draws the landing and leads polylines with one point per bucket".
  - "shows the empty state when every bucket is zero".
  - "api.clientErrors omits unset filters from the query" (spy on `fetch`).
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/trend-chart.ui.test.tsx`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — the same command and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): traffic trend chart and API client methods (FUS-379)`

---

### Task 6: `/traffic` screen

**Files:**
- Create: `apps/web/src/client/screens/Traffic.tsx`
- Create: `apps/web/src/client/screens/Traffic.css`
- Test: `apps/web/test/traffic.ui.test.tsx`

**Interfaces (produced):**
- `export function readTrafficPeriod(search: string): TrafficLogPeriod` (unknown -> `24h`), `export function trafficPath(period): string` (`/traffic` for 24h, else `/traffic?period=<p>`).
- `export function TrafficScreen()` per spec D7: period chips with `aria-pressed`, five stat tiles, `TrendChart`, breakdown tabs with one `DataTable` labelled "แยกตาม (Breakdown)", recent `DataTable` labelled "เหตุการณ์ล่าสุด (Recent events)", a CSV link with `href = api.trafficReportCsvUrl(period)`, `Spinner` while loading, an error card with "ลองอีกครั้ง" that refetches. The brand tab and the recent table use `BrandLabel` with `useBrandDomains()`.

- [ ] **Step 1: Write failing tests** (mock `fetch` with the `traffic-report.response.json` fixture, as `conversions.ui.test.tsx` does):
  - "loads 24h by default and shows the five totals".
  - "a period chip navigates to /traffic?period=7d and refetches with period=7d".
  - "readTrafficPeriod reads an unknown period as 24h".
  - "breakdown tabs switch the table rows to the selected dimension".
  - "the recent table shows session refs and no raw session id".
  - "the CSV link points at /api/traffic/report.csv with the period".
  - "a failed load shows the error card and Retry refetches".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/traffic.ui.test.tsx`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — the same command and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): traffic screen with totals, breakdowns, trend and recent events (FUS-379)`

---

### Task 7: `/errors` screen

**Files:**
- Create: `apps/web/src/client/screens/ClientErrors.tsx`
- Test: `apps/web/test/client-errors.ui.test.tsx`

**Interfaces (produced):**
- `export interface ClientErrorFilters { period: TrafficLogPeriod; brand: string | null; type: string | null }`.
- `export function readClientErrorFilters(search: string): ClientErrorFilters` (unknown period -> 24h; brand not a `BrandId` -> null; type empty or over 64 chars -> null), `export function clientErrorsPath(filters): string` (only non-default keys, `/errors` when all default).
- `export function ClientErrorsScreen({ me }: { me: Me })` per spec D7: period chips, brand `<select>` labelled "แบรนด์" with "ทุกแบรนด์", type chips from `counts` with "ทั้งหมด" first and each count, `DataTable` labelled "ข้อผิดพลาดฝั่งเว็บ (Client errors)", message cell "— (Owner only)" for an employee when null, "โหลดเพิ่ม (Load more)" while `next_cursor` is set, list reset on any filter change, loading/empty/error states (`EmptyState` "ไม่มีข้อผิดพลาดในช่วงนี้").

- [ ] **Step 1: Write failing tests** (mock `fetch` with the `client-errors.response.json` fixture):
  - "loads 24h errors and shows a chip per type with its count".
  - "a type chip navigates to /errors?type=timeout and refetches with error_type".
  - "the brand select navigates to /errors?brand=brand-a and refetches with brand_id".
  - "readClientErrorFilters drops an unknown period, a bad brand and an empty type".
  - "Load more appends the next page with the cursor and hides when next_cursor is null".
  - "an employee sees — (Owner only) for a hidden message; an owner sees the message".
  - "a filter change drops the appended pages".
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/client-errors.ui.test.tsx`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — the same command and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): client errors screen with filters and paging (FUS-379)`

---

### Task 8: Routes, nav and page titles

**Files:**
- Modify: `apps/web/src/client/router.ts` (`Route` union gains `{ view: "traffic" }` and `{ view: "errors" }`; `STATIC` gains `/traffic` and `/errors`; both `// spec traffic`)
- Modify: `apps/web/src/client/App.tsx` (imports, two nav items after "ฟันเนล", two render lines, `// spec traffic`)
- Modify: `apps/web/src/client/components/AppShell.tsx` (`pageTitle` gains `traffic: "ทราฟฟิก (Traffic)"` and `errors: "ข้อผิดพลาดฝั่งเว็บ (Client errors)"`)
- Test: `apps/web/test/traffic-routes.ui.test.tsx`

- [ ] **Step 1: Write failing tests**:
  - "parseRoute reads /traffic and /errors, and routePath writes them back".
  - "the sidebar shows Traffic and Client errors to an employee and an owner, after Funnel".
  - "opening /traffic renders the Traffic screen with its page title" and the same for `/errors`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/traffic-routes.ui.test.tsx`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run --cwd apps/web test` and `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): traffic and client errors routes and nav (FUS-379)`

---

## Task order and parallelism

Sequential, T1 to T8, one coder at a time in one worktree. T2 and T3 need T1; T4 needs T1 (it uses the mock, not core); T5 needs T1; T6 needs T5; T7 needs T5; T8 needs T6 and T7.

## Acceptance criteria to evidence

| AC | Evidence |
|---|---|
| AC1 Metrics and windows | `traffic-log.test.ts` window tests; `traffic-report.test.ts` "counts each metric once per session", "counts an error-only session", "excludes events outside the window" |
| AC2 Breakdowns | `traffic-report.test.ts` attribution, brand mapping and 100-row tests |
| AC3 Trend | `traffic-report.test.ts` bucket test; `trend-chart.ui.test.tsx` |
| AC4 Recent, no PII | `traffic-report.test.ts` recent and "never returns a raw session id ..." |
| AC5 CSV | `traffic-log-api.test.ts` CSV tests |
| AC6 Client errors | `client-errors.test.ts` brand, filter, counts and paging tests |
| AC7 Message owner-only | `client-errors.test.ts` "hides error_message from an employee"; `traffic-log-api.test.ts`; `client-errors.ui.test.tsx` |
| AC8 Screens | `traffic.ui.test.tsx`, `client-errors.ui.test.tsx` |
| AC9 Roles | `traffic-log-api.test.ts` employee and owner tests; `traffic-routes.ui.test.tsx` sidebar test |
| AC10 Observe only | `client-errors.test.ts` "new core read modules hold only SELECT statements"; `git diff --stat origin/main` in the PR |
| AC11 Green | `bun run typecheck`, `bun run test` output in the PR |

## Verification before the PR

- `git fetch && git rebase origin/main`, then `bun run typecheck` and `bun run test` at the repo root.
- `git diff --stat origin/main` shows no file under `packages/brand-runtime/`, `apps/lead-form/`, `packages/leads-db/`, `spike/`, and no change to `workers/core/src/analytics.ts` or `workers/core/src/admin/traffic.ts`.
