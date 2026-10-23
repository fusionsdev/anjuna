# Panel spec A: Home overview and Conversions (FUS-375)

Ship order step 2 in `2026-10-23-panel-backlog-and-order.md`. Builds on spec 1 (FUS-374, merged as `b6e307c`): routes, app shell, `DataTable`, `StatusBadge`, `EmptyState`, `Spinner`.

## Goal

The owner sees money and conversion health on one Home page, and finds every conversion that did not reach Google Ads or Microsoft Ads on a Conversions page with a reason and a fix text. An employee sees the same pages with counts only: no revenue, no payout, no conversion value, enforced by the server.

## Baseline (origin/main `b6e307c`)

- Home (`apps/web/src/client/screens/Home.tsx`) has a period switch (`today|7d|30d`), a 4-cell `.ledger`, div flow bars, a "ต้องแก้" list from alerts and a to-do list. The owner ledger shows spend, CPL, revenue, profit. The employee ledger shows visits, leads, sold, pending. There are no deltas.
- No admin endpoint returns conversion upload rows. The panel sees conversions only through the `conversion_stalled` alert.
- `funnelReport` (employee) returns `revenue` per row to employees. Only the client hides it (`Funnel.tsx:173`, `Home.tsx:122-216`). This is the field-level leak spec A closes.
- `conversion_uploads` (leads D1, `packages/leads-db/migrations/0001_v1_baseline.sql:91-110`): `status` is `pending|processing|uploaded|dead`; `last_error` is free text up to 300 chars; `value REAL` is the postback payout (clamped to 230); no brand column, join `leads.brand`.
- Core admin calls carry `x-actor-role` from the panel session (`admin-api.ts:63-87`). Core runs `authorize(endpoint, role)` and has the role in its request context.

## Decisions

1. Money redaction happens in core, the source of the data, keyed on `context.actor_role`. A non-owner gets `null` in every money field. The panel server passes the response through its strict schema unchanged. The mock core applies the same redaction so local dev matches.
2. Money fields in scope: `funnelReport.rows[].revenue`, and the new `conversionsReport` value fields. `spendReport` and `getLead` stay owner-only at endpoint level (unchanged).
3. Conversions are read-only. No requeue, no edit, no delete. Requeue is a blocked item with its own governance spec.
4. Reason codes are derived from `last_error` text by one pure function in `@anjuna/contracts`. The database and the drain stay unchanged (V1 parity, rule 1).
5. The `no_route` fix text points to the drain config on the VPS. The panel has no remote drain viewer.
6. Charts are inline SVG. No chart library.

## Reason codes

`conversionReasonCode(status, lastError): ConversionReasonCode | null` in `packages/contracts/src/conversions.ts`. Matching is case-insensitive on the trimmed text, first match wins:

| Code | `last_error` match | Written by |
|---|---|---|
| `no_click_id` | starts with `no click id`, `no gclid/gbraid/wbraid`, or `no msclkid` | core `conversions.ts:59`, drain `drain.mjs:197`, `:232` |
| `lease_exhausted` | starts with `reclaim: exhausted attempts` | core `conversions.ts:67` |
| `no_route` | starts with `no route for brand=` | drain `drain.mjs:294` |
| `not_ready` | starts with `not ready yet` | drain `drain.mjs:221` |
| `ms_env_missing` | starts with `missing Microsoft env` | drain `drain.mjs:230` |
| `upload_failed` | starts with `upload failed` | drain `drain.mjs:224` |
| `platform_error` | any other non-empty text | raw Google/Microsoft error, drain `:262`, `:274`, `:299` |
| `null` | empty or null `last_error`, or `status = uploaded` | |

UI text per code (Thai first, English in parentheses), with one fix line each:

| Code | Label | Fix text |
|---|---|---|
| `no_click_id` | ไม่มี click id (No click id) | Lead มาโดยไม่มี gclid/gbraid/wbraid/msclkid. ส่งขึ้น Ads ไม่ได้. ตรวจว่าแคมเปญเปิด auto-tagging. |
| `lease_exhausted` | ลองครบแล้ว (Attempts exhausted) | Drain ดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของ drain บน VPS. |
| `no_route` | ไม่มี route (No route) | Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS. |
| `not_ready` | ยังไม่พร้อม (Not ready) | Ads ยังไม่รับ click นี้. Drain จะลองใหม่เอง. |
| `ms_env_missing` | ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing) | ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของ drain. |
| `upload_failed` | อัปโหลดไม่ผ่าน (Upload failed) | Ads ตอบ error. Drain จะลองใหม่ตาม backoff. |
| `platform_error` | Ads ตอบ error (Platform error) | ดูข้อความ error เต็มในแถว. |

## Core: `conversionsReport`

Reason codes and statuses live in `packages/contracts/src/conversions.ts`. Query and response schemas sit in `admin-api.ts` next to `FunnelReportResponse` (they need `LeadId`, `Count`, `Timestamp` from that file), with the endpoint in `AdminApi`. Row `brand` is `z.string().min(1)` because old `leads.brand` values may not match `BrandId`.

```ts
conversionsReport: { method: "GET", path: "/admin/conversions", min_role: "employee",
  query: ConversionsQuery, response: ConversionsReportResponse }
```

- `ConversionsQuery = strictObject({ period: SpendPeriod, status: enum(["all","pending","processing","uploaded","dead"]).default("all"), brand: BrandId.optional(), now: Timestamp.optional() })`. `now` is the test clock, as in `AlertsQuery`.
- The period window uses the same rule as `SpendPeriod`: UTC days, `today` is the current UTC day, `7d` and `30d` end today and include it. It filters on `conversion_uploads.created_at`.
- Response:

```ts
ConversionsReportResponse = strictObject({
  period: SpendPeriod, from: Timestamp, to: Timestamp,
  totals: strictObject({ pending: Count, processing: Count, uploaded: Count, dead: Count }),
  value_totals: strictObject({ uploaded: Money, dead: Money }).nullable(),   // null for non-owner
  stalled: Count,          // status pending and created_at older than 6 h, any age; same rule as the conversion_stalled alert
  rows: array(strictObject({
    lead_id: LeadId, brand: string().min(1), status: enum(["pending","processing","uploaded","dead"]),
    reason_code: ConversionReasonCode.nullable(), last_error: string().max(300).nullable(),
    click_type: enum(["gclid","gbraid","wbraid","msclkid"]).nullable(),   // which id is present, never its value
    attempts: Count, value: Money.nullable(), currency: string().length(3),
    occurred_at: Timestamp, created_at: Timestamp, updated_at: Timestamp, next_attempt_at: Timestamp.nullable(),
  })),
  truncated: boolean(),    // true when more than 200 rows matched
})
```

- `Money = z.number().finite().min(0)` (USD), `Count` and `Timestamp` as in `admin-api.ts`, `LeadId` from `admin-api.ts:359`, `BrandId` from `common.ts:9`.
- `totals` and `value_totals` count the period window and ignore the `status` filter. `rows` honor `status` and `brand`.
- Rows order: `dead` first, then `pending`, `processing`, `uploaded`; inside a status, newest `updated_at` first. Limit 200.
- `value` and `value_totals` are `null` when `actor_role !== "owner"`.
- Click ids never leave core. `click_type` names the first present of `gclid`, `gbraid`, `wbraid`, `msclkid`.

`funnelReport`: `rows[].revenue` becomes `z.number().finite().min(0).nullable()`. Core sets it to `null` for a non-owner.

## Panel server

- `GET /api/conversions?period&status&brand` (employee), pattern of `/api/spend` in `apps/web/src/server/index.ts`. 422 on a bad query, 401 without session.
- Mock core serves a fixture `packages/contracts/fixtures/admin/conversions.response.json` with rows for every reason code, and redacts money for an employee context. The `funnelReport` mock redacts `revenue` the same way.

## Conversions page (`/conversions`)

- Route `{ view: "conversions" }`, sidebar item "คอนเวอร์ชัน (Conversions)" after Funnel, visible to every role. `pageTitle` entry.
- Header: period switch `today|7d|30d` (default `7d`), status filter chips `ทั้งหมด|ค้างส่ง (pending)|กำลังส่ง (processing)|ส่งแล้ว (uploaded)|ส่งไม่ได้ (dead)`, brand select from `useBrandLabels()`.
- Summary row: 4 count cells (pending, processing, uploaded, dead) and a stalled count with `StatusBadge tone="warn"` when above 0. Owner also sees uploaded value and dead value in USD.
- `DataTable` columns: brand (`BrandLabel`), status (`StatusBadge`: uploaded `live`, pending `blue`, processing `mute`, dead `bad`), reason (label + fix text under it; full `last_error` in a `<details>`), click type, attempts, value (owner only, column absent for employee), created (local time), next attempt.
- Empty state: "ยังไม่มีคอนเวอร์ชันในช่วงนี้". Error state shows `ApiError.thai`. A `truncated` response shows "แสดง 200 แถวล่าสุด".
- Filters live in the query string (`/conversions?period=30d&status=dead`), so a deep link restores them. Unknown values fall back to defaults.

## Home overview (`/`)

- KPI cards with deltas: each ledger cell shows the change against the previous window of equal length (`today` vs yesterday, `7d` vs the 7 days before). Delta text: `▲ 12%` / `▼ 5%` / `–` when the previous value is 0 or missing. Color: up is `pos` for leads, sold, revenue, profit; up is `neg` for spend and CPL.
  - Previous-window data: a second `api.funnel` call for the previous range, and a second `api.spend` call is not possible (period enum). Spend, CPL and profit cells show no delta in spec A.
- Conversions card: uploaded / pending / dead counts for the period and the stalled count; owner also sees uploaded value. The card links to `/conversions` (dead count links to `/conversions?status=dead`).
- Daily bars: inline SVG bar chart of leads and sold per UTC day from `/api/leads/aggregates` (counts only, employee allowed; the server route exists, the client gets a new `api.leadAggregates({from,to})`). `today` shows the last 7 days. Each bar has a `<title>` with day and counts. Width follows the container; height 120 px.
- Issues first: the "ต้องแก้" list adds dead conversions in the period (bad) and stalled conversions (warn), each linking to `/conversions` with the matching filter. Existing alert items stay.
- Employee view: revenue arrives as `null`; Home and Funnel treat `null` as hidden and never show 0 for it.

## Tests (acceptance)

- Contracts: `conversionReasonCode` table test covers every row of the reason table, case and whitespace; `uploaded` gives `null`.
- Core worker tests: `conversionsReport` totals, `stalled`, ordering, 200-row `truncated`, `status` and `brand` filters, `click_type` without the id value; employee gets `value: null` and `value_totals: null`; owner gets numbers. `funnelReport` employee gets `revenue: null`.
- Panel worker tests (pattern `spend-api.test.ts`): 200 forwards query, 401, 422, employee passes through null money.
- UI tests: Conversions deep link with filters, status chip changes the URL, owner sees the value column, employee does not, reason label and fix text render, empty and error states. Home deltas (up, down, previous 0), conversions card links, SVG bars count, issues list adds dead and stalled items, employee Home shows no revenue.
- Existing suites stay green. `bun run typecheck` and `bun run test` green.

## Out of scope

- Conversion requeue or edit (blocked, governance spec).
- Spend deltas (needs a spend query by date range).
- Pagination beyond 200 rows (backlog item 3 search/pagination).
- Lead detail link from a conversion row (spec B, owner-only lead page).
