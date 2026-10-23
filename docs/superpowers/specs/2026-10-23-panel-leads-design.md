# Panel spec B: Leads list + detail, CSV, Postback Inspector, PII access audit (FUS-376)

Source: ship order step 3 in `2026-10-23-panel-backlog-and-order.md` (backlog items 1 and 13).
Tracking issue: FUS-376. Runs in parallel with spec C; spec A (FUS-375) is ahead of it.

## Goal

An owner can find one lead, read it in full, reconcile it against the LeadsGate postbacks and the
Google Ads conversion upload, and export a CSV. An employee can do the same work on counts and
status without ever receiving a name, an email, a phone number, a street address, a birth date or a
money value. Every release of PII leaves an audit row.

## Baseline (branch point `b6e307c`, spec 1 merged)

- `getLead` (`workers/core/src/admin/index.ts:557`) returns the full `applicant` block to anyone
  who passes the gate. The gate is endpoint-level `min_role: "owner"`
  (`packages/contracts/src/admin-api.ts:685`), so an employee sees nothing at all and an owner sees
  everything with no audit row. Both halves are wrong for this spec.
- There is no list endpoint for leads. The only lead read is one id at a time, plus the
  `leadAggregates` counts (`admin-api.ts:674`).
- `postback_events` is already joined into `getLead` (`admin/index.ts:563`) with
  `event_type`, `payout`, `created_at`. `conversion_uploads` is not read by any admin endpoint.
- `suppressions` (`packages/leads-db/migrations/0001_v1_baseline.sql:128`) is written only by the
  mailing reverse sync (`packages/mailing/src/index.ts:195`). No admin endpoint reads it. The
  primary key is the lowercased email, so every row is PII.
- CSV already has a pattern: core answers JSON (`trafficRiskExport`), the panel renders the file
  with `csvCell()` and a `content-disposition` header (`apps/web/src/server/traffic-risk.ts:28-85`).
- Core writes audit rows to the factory D1 (`writeAudit`, `admin/index.ts:269`), its `action`
  parameter is a closed union of three brand actions. `AuditEntry.action`
  (`admin-api.ts:428`) accepts any `^[a-z_]+(?:\.[a-z_]+)+$` string and `target.type` any
  `^[a-z_]{1,32}$`, so new action names need no schema change.
- The panel's `/api/audit` passes core rows straight through and only de-duplicates against its
  own `auth.*` / `user.*` rows (`apps/web/src/server/index.ts:198-224`). A new core audit action
  therefore appears on the existing Audit screen with no client change. `Audit.tsx:21` renders the
  raw action string, so no label map needs an entry.
- Lead columns available: V1 baseline (`0001_v1_baseline.sql:17-54`) plus the additive
  `experiment_id`, `variant`, `keyword` (`0003_anjuna_experiment_keyword.sql`).
- Indexes on `leads`: `session_id`, `created_at`, `status`, `click_id`, `(experiment_id, variant)`.
  There is no `brand` index.

## Decisions

1. **PII is defined by a field list, not by an endpoint.** The PII fields of a lead are
   `first_name`, `last_name`, `birth_date`, `email`, `home_phone`, `work_phone`, `address`,
   `city`, `zip`, and the whole `suppressions.email` column. `state` is not PII on its own and
   stays visible to an employee; `zip` is withheld because ZIP5 with a birth date or an income
   figure identifies a person.
2. **Core is the only enforcement point.** Core redacts by role inside the handler. The panel does
   not re-gate `getLead` at endpoint level, because an endpoint gate would take the non-PII view
   away from an employee. The panel still gates the PII CSV and the suppression search, which are
   owner-only at endpoint level.
3. **Money fields follow spec A's rule.** `postbacks[].payout` and the conversion `value` are
   `null` for any role other than `owner`. Click id values never leave core (AGENTS.md rule 2
   territory): the conversion block carries a `click_type` label, never a `gclid`, `gbraid`,
   `wbraid` or `msclkid` value.
4. **`last_error` is owner-only on lead detail.** The drain stores raw AdKit failure text which can
   echo the upload payload (spec A, `drain.mjs:299`). Spec A builds a reason-code taxonomy and an
   allow-list sanitizer in `packages/contracts/src/conversions.ts`. This lane does not copy that
   code and does not depend on an unmerged branch: an employee gets `last_error: null`, an owner
   gets the raw string. Mapping reason codes onto lead detail is listed under "Proposed (out of
   scope)".
5. **Audit rows never contain PII.** A `pii.lead_view` row records the lead id and the field names
   released, never the values. A `pii.suppression_search` row records the query string the actor
   typed, the filters and the row count, never the emails returned. The actor's own query is the
   actor's own input, so storing it leaks nothing new about a third party.
6. **The audit write fails closed.** Core awaits the audit insert *before* it returns a PII body.
   If the insert throws, the error propagates, core answers a non-contract 500, and the panel's
   `callCore` turns that into `502 bad_gateway`. An unaudited PII release is worse than a failed
   read.
7. **Every CSV export is audited, PII or not.** The debate asked for "every CSV export".
   Non-PII exports write `lead.export`; PII exports write `pii.lead_export`.
8. **No new migration.** A `(brand, created_at)` composite index would help the brand-filtered
   list, but V1 has handled about 1,000 leads and `idx_leads_created_at` already covers the date
   window that every list query carries. Adding a migration file would also collide with the
   numbering of the other lanes running now. Listed under "Proposed (out of scope)".
9. **Keyset paging, not offset.** `leads.lead_id` is a TEXT primary key with no rowid alias, so the
   numeric `encodeCursor` (`admin/index.ts:613`) cannot page it. Leads page on
   `(created_at DESC, lead_id DESC)`; suppressions page on `email ASC` (its primary key).

## Core: new endpoints

All four go in one `// spec leads` block in `packages/contracts/src/admin-api.ts`, placed after
`GetLeadResponse` and before the audit section, with their entries added as one contiguous block in
`AdminApi` so the other lanes' blocks stay untouched.

### Shared query schemas

```
LeadFilter = strictObject({
  brand:  BrandId.optional(),
  from:   Day.optional(),                       // UTC calendar day, inclusive
  to:     Day.optional(),                       // UTC calendar day, inclusive
  status: LeadOutcome.optional(),               // pending | sold | rejected
  q:      z.string().regex(/^[A-Za-z0-9-]{4,64}$/).optional(),
})
```

- `q` matches `lead_id` by prefix or `click_id` exactly. It never matches an email or a phone
  number, so an employee cannot use it to confirm a guessed address. Searching by email or phone is
  out of scope.
- `from`/`to` default to the last 30 days when both are absent, and refuse `from > to` and a window
  longer than `LEAD_AGGREGATES_MAX_DAYS` (93), reusing the refinement of `LeadAggregatesQuery`.
- `status` filters on the derived outcome, mapped with `leadOutcome()`:
  `sold` -> `status = 'soldLead'`, `rejected` -> `status = 'rejectLead'`,
  `pending` -> `status NOT IN ('soldLead','rejectLead')`.

### 1. `listLeads` — `GET /admin/leads`, `min_role: "employee"`

```
LeadsQuery    = LeadFilter.extend({ limit: coerce.number().int().min(1).max(200).optional(), cursor: Cursor.optional() })
LeadListRow   = strictObject({
  lead_id: LeadId, brand: z.string().min(1), hostname: Hostname,
  status: z.string().max(32), outcome: LeadOutcome,
  requested_amount: z.number().int().positive(), loan_purpose: z.string(),
  state: z.string().length(2), keyword: z.string().max(60).nullable(),
  variant: VariantId.nullable(), form_variant: z.string().max(64),
  has_conversion: z.boolean(), postback_count: Count,
  created_at: Timestamp,
})
LeadsResponse = strictObject({ rows: array(LeadListRow), next_cursor: z.string().nullable() })
```

- The row has no PII for any role, so the response is byte-identical for an employee and an owner
  and the list writes no audit row.
- `brand` is `z.string().min(1)`, not `BrandId`: old `leads.brand` values predate the pattern
  (same reason as spec A's conversions rows).
- `has_conversion` and `postback_count` come from `EXISTS` and a correlated `COUNT` so the list
  shows reconciliation state without a second round trip.
- Default `limit` 50. `next_cursor` is `base64url("<created_at>|<lead_id>")`, null on the last page.
  A cursor that does not decode to that shape is `422 invalid` on `cursor`.

### 2. `getLead` — `GET /admin/leads/:lead_id`, `min_role` drops `"owner"` -> `"employee"`

`LeadDetail` changes:

- `applicant` becomes `LeadApplicant.nullable()` and is `null` for an employee. The owner block is
  unchanged, so the existing owner fixture keeps its shape.
- new `profile`, present for both roles, carrying the non-identifying eligibility fields:
  `state`, `address_length_months`, `own_home`, `income_type`, `employer`, `job_title`,
  `employed_months`, `pay_date1`, `pay_frequency`, `direct_deposit`, `monthly_income`.
  `employer` and `job_title` are employment facts, not contact data, and an employee needs them to
  judge a rejection.
- `postbacks[].payout` becomes `z.number().min(0).nullable()`, `null` for an employee.
- new `conversion: LeadConversion | null`:

```
LeadConversion = strictObject({
  status: z.enum(["pending","processing","uploaded","dead"]),
  click_type: z.enum(["gclid","gbraid","wbraid","msclkid","none"]),
  currency: z.string().length(3),
  occurred_at: Timestamp,
  attempts: Count,
  next_attempt_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp.nullable(),
  value: z.number().min(0).nullable(),      // owner only
  last_error: z.string().max(300).nullable(), // owner only
})
```

  `click_type` is the first non-null of `gclid`, `gbraid`, `wbraid`, `msclkid`, else `"none"`.
  No click id value appears. `google_order_id` is omitted: it equals the lead id.
- `null` for `conversion` means no `conversion_uploads` row exists, which is itself the
  reconciliation answer for a sold lead with no upload.

Audit: when `applicant` is non-null in the response, core awaits
`pii.lead_view` on `target {type:"lead", id:<lead_id>}` with
`new: { fields: ["first_name","last_name","birth_date","email","home_phone","work_phone","address","city","zip"] }`
and `old: null`. An employee read writes no row.

### 3. `leadExport` — `GET /admin/leads/export`, `min_role: "employee"`

```
LeadExportQuery    = LeadFilter.extend({ pii: enum(["0","1"]).default("0") })
LEAD_EXPORT_LIMIT  = 5_000
LeadExportResponse = strictObject({ rows: array(LeadExportRow), truncated: z.boolean(), pii: z.boolean() })
```

- `pii=1` from an employee is `403 forbidden_role` with `required_role: "owner"`, raised by
  `authorize()` through a `pii_requires_owner` branch so core and the panel answer identically.
  The check runs before the query parse only for the role; a bad filter still answers `422`.
- `LeadExportRow` is `LeadListRow` plus `click_id` is **never** included. With `pii=1` the row adds
  the nine PII fields plus the `profile` fields.
- Column order is fixed in two exported constants so the panel, the fixtures and the tests agree:
  `LEAD_EXPORT_COLUMNS` and `LEAD_EXPORT_PII_COLUMNS`.
- `truncated: true` when more than `LEAD_EXPORT_LIMIT` rows matched; core returns the newest
  `LEAD_EXPORT_LIMIT`.
- Audit, awaited before the body: `pii.lead_export` when `pii=1`, else `lead.export`, on
  `target {type:"lead_export", id:"<from>..<to>:<brand|all>"}`, with
  `new: { rows, truncated, pii, filters: { brand, from, to, status, q } }`.

### 4. `listSuppressions` — `GET /admin/suppressions`, `min_role: "owner"`

```
SuppressionsQuery    = strictObject({
  q: z.string().min(1).max(254).optional(),             // lowercased, matched as a substring of email
  reason: z.enum(["blocklisted","unsubscribed","complaint","bounce","manual"]).optional(),
  source: z.enum(["listmonk","ses","manual"]).optional(),
  limit: coerce.number().int().min(1).max(200).optional(),
  cursor: Cursor.optional(),
})
SuppressionsResponse = strictObject({
  rows: array(strictObject({ email: z.string().max(254), reason: ..., source: ..., created_at: Timestamp, updated_at: Timestamp.nullable() })),
  next_cursor: z.string().nullable(),
})
```

- Owner-only at endpoint level: every row is an email. An employee gets `403 forbidden_role`.
- `q` is lowercased by core before the `LIKE` match, because the column is stored lowercased.
  The `%` and `_` characters in `q` are escaped so a search cannot widen itself.
- Paging is keyset on the `email` primary key ascending; `next_cursor` is `base64url(email)`.
- There is no "actor" column to filter on: the table records who was suppressed, not who searched.
  The debate's "actor" is served by the audit trail below, filtered on the Audit screen.
- Audit, awaited before the body: `pii.suppression_search` on
  `target {type:"suppression", id:"search"}` with `new: { q, reason, source, rows }`. No email.

### Role table and audit actions

- `ADMIN_AUDIT_ACTIONS` gains `"pii.lead_view"`, `"pii.lead_export"`, `"lead.export"`,
  `"pii.suppression_search"`.
- `writeAudit` in `admin/index.ts` widens its `action` union to the new names and takes the
  `entity_type` as a parameter (it hardcodes `'brand'` today).
- `ADMIN_ROLE_TABLE` is generated from `AdminApi`, so the four endpoints appear in it with no edit.
  `getLead` moves from `{employee: "none", owner: "all"}` to `{employee: "all", owner: "all"}`;
  the field-level difference is documented in the spec, not in that table.

## Panel server

- `apps/web/src/server/csv.ts` (new): `csvCell` moves here unchanged.
  `apps/web/src/server/traffic-risk.ts` re-exports it so `traffic-risk-api.test.ts` keeps passing.
- `apps/web/src/server/leads.ts` (new), one `handleLeadsRoute` in the shape of
  `handleTrafficRiskRoute`:
  - `GET /api/leads` -> `listLeads` (employee).
  - `GET /api/leads/export?...&pii=1` -> `leadExport`, rendered to CSV in the panel.
    Filename `leads-<from>_<to>[-pii].csv`; headers `text/csv; charset=utf-8`,
    `content-disposition: attachment`, `cache-control: no-store`,
    `x-export-truncated: true|false`. `pii=1` is gated with
    `authorize("leadExport", role, { pii: true })` before the call to core, so the panel refuses an
    employee without a round trip; core refuses it again.
  - `GET /api/leads/:lead_id` -> `getLead`, with no owner gate. The route must be registered
    **after** `/api/leads/aggregates` and `/api/leads/export`, or those two paths match the id
    pattern. A test asserts the order.
- `apps/web/src/server/suppressions.ts` (new): `GET /api/suppressions` -> `listSuppressions`,
  gated `authorize("listSuppressions", role)` (owner).
- `apps/web/src/server/index.ts` deletes the old owner gate on `/api/leads/:lead_id`
  (`index.ts:188-196`) and calls the two new handlers in its handler chain, in its own block.
- `apps/web/src/server/mock-core.ts` serves the four endpoints from new fixtures and applies the
  same check order, including the employee redaction, so `MOCK_CORE=1` and the panel tests exercise
  the real shapes.

New fixtures in `packages/contracts/fixtures/admin/`: `leads.list.response.json`,
`lead.get.response.employee.json`, `leads.export.response.json`,
`leads.export.response.pii.json`, `suppressions.list.response.json`. The existing
`lead.get.response.json` gains `profile` and `conversion` and keeps its owner `applicant`.

## Screens

Routes added to `apps/web/src/client/router.ts`: `{ view: "leads"; leadId: string | null }` and
`{ view: "suppressions" }`; `/leads`, `/leads/:lead_id`, `/suppressions`. The `one` regex gains
`leads`. `pageTitle` in `components/AppShell.tsx` gains both views (typecheck enforces it).

Nav: "ลีด (Leads)" after "ฟันเนล", always shown; "อีเมลที่บล็อก (Suppressions)" after
"รายชื่ออีเมล", shown only when `me.role === "owner"`.

### `/leads` — `screens/Leads.tsx`

- Filter bar: brand select (options are domains from `useBrandLabels()`, value is the brand id),
  `from`/`to` date inputs defaulted to the last 30 days, status select, and a `q` box.
  Every filter is in the URL query string so a filtered list is a link.
- `DataTable` columns: created (local time), brand (`BrandLabel`, domain first), outcome
  (`StatusBadge`: sold `live`, pending `blue`, rejected `bad`), amount (right-aligned, tabular),
  state, keyword, variant, reconciliation (a `StatusBadge` from `has_conversion` and
  `postback_count`), lead id (monospace, truncated, links to the detail route).
- No contact column for any role: the list carries no PII to redact.
- "ถัดไป (Next)" uses `next_cursor`; the cursor is kept in component state, not the URL, so a
  shared link always opens page 1.
- Two export buttons: "ดาวน์โหลด CSV" for everyone, and "ดาวน์โหลด CSV พร้อม PII" shown only to an
  owner, behind a `ConfirmDialog` that says the download is audited. Both are plain links built by
  `api.leadsExportUrl()`, so the browser downloads with the session cookie, as the risk export does.
- `EmptyState` when `rows` is empty, separating "no leads in this window" from "no match for this
  filter".

### `/leads/:lead_id` — `screens/LeadDetail.tsx`

- Header: domain (`BrandLabel`), outcome badge, lead id (monospace, copyable), created and updated.
- "ผู้สมัคร (Applicant)": the `applicant` block for an owner. For an employee, one notice line —
  "ข้อมูลส่วนบุคคลสงวนสำหรับ Owner (Personal data is owner-only)" — and no empty field rows.
- "คุณสมบัติ (Profile)": the `profile` block, both roles.
- "Postback Inspector": the `postbacks` rows as `event_type`, payout (owner only, column absent for
  an employee), received-at; plus the `conversion` block as status badge, click type, attempts,
  next attempt, value (owner only) and `last_error` in a `<details>` (owner only).
  Reconciliation line, derived in the client from fields already fetched:
  - `soldLead` postback present and `conversion` null -> "ขายแล้วแต่ไม่มีรายการอัปโหลด" (alert).
  - `conversion.status === "dead"` -> "อัปโหลดล้มเหลวถาวร" (alert).
  - `conversion.status === "uploaded"` -> "ส่งคอนเวอร์ชันแล้ว" (ok).
  - no postback at all -> "ยังไม่มี postback จาก LeadsGate" (warn).
- 404 renders `NotFound`; 403 cannot happen for either role on this route.

### `/suppressions` — `screens/Suppressions.tsx`

- Owner-only screen; an employee who deep-links gets the `NotFound` owner-only panel that `/users`
  already uses (`App.tsx:110-112`).
- Search box (`q`), reason select, source select, `DataTable` of email (monospace), reason badge,
  source, created, updated, with cursor paging and an `EmptyState`.
- A line under the heading states that each search is recorded in the audit log.

### `api.ts`

`leads(filter)`, `lead(id)`, `leadsExportUrl(filter, pii)`, `suppressions(filter)`, each parsing the
contract schema like `trafficRisk` does.

## AGENTS.md rules

- Rule 1 (V1 parity): V1 has no panel, so there is nothing to port. The lead and conversion columns
  read here are V1's own, unchanged.
- Rule 2: no LeadsGate call. This lane only reads the postback rows LeadsGate already wrote.
- Rule 3 (no cloaking): the panel is not a brand response. No endpoint here varies by user agent,
  IP, ASN, referrer or gclid. Role is the only axis, and role comes from the panel session.
- Rule 4 (brand bytes clean): no brand bytes change.
- Rule 5 (Cloudflare only, D1 only): every read is D1. CSV bytes are built in the response and
  never written to R2 or anywhere else.
- Rule 6: no secrets. No endpoint here returns a token.
- Rule 7: no deploys, no real external calls.

## Tests (acceptance)

Contracts (`packages/contracts/test/admin-api.test.ts`):
1. `leads query refuses a window longer than 93 days and from after to`
2. `lead export refuses pii=1 for an employee and allows it for an owner`
3. `lead detail parses the employee fixture with applicant null and payout null`
4. `role table lists the four new endpoints with their minimum role`
5. `export column constants cover every row field`

Core (`workers/core/test/admin.test.ts`):
6. `listLeads pages newest first and the cursor returns the next page with no overlap`
7. `listLeads filters by brand, day window, outcome and q on lead_id prefix or click_id`
8. `listLeads returns the same bytes to an employee and an owner`
9. `getLead gives an employee profile fields and null applicant, payout and conversion value`
10. `getLead gives an owner the applicant block and writes one pii.lead_view row with field names only`
11. `getLead for an employee writes no audit row`
12. `getLead conversion reports click_type and never a click id value`
13. `getLead conversion is null when no upload row exists`
14. `leadExport with pii=1 is 403 for an employee`
15. `leadExport writes lead.export without pii and pii.lead_export with pii, and truncates at the limit`
16. `listSuppressions is 403 for an employee, searches by q, reason and source, pages by email, and writes pii.suppression_search with no email`
17. `a failing audit insert stops the PII body from being returned`

Panel server (`apps/web/test/leads-api.test.ts`, `apps/web/test/suppressions-api.test.ts`):
18. `GET /api/leads/aggregates and /api/leads/export are not captured by the lead id route`
19. `GET /api/leads/:id answers 200 for an employee with applicant null`
20. `GET /api/leads/export returns CSV with the declared columns, quoting and the formula guard`
21. `GET /api/leads/export?pii=1 is 403 for an employee and sets x-export-truncated for an owner`
22. `GET /api/suppressions is 403 for an employee and 200 for an owner`
23. `every route answers 401 without a session and 422 on a bad filter`

Client (`apps/web/test/leads.ui.test.tsx`, `lead-detail.ui.test.tsx`,
`suppressions.ui.test.tsx`, `router.ui.test.tsx`):
24. `/leads/<id> deep link renders the detail screen and back returns to the list`
25. `the leads filter writes its state to the URL query string`
26. `the PII CSV button is absent for an employee and confirms before downloading for an owner`
27. `lead detail hides the applicant block and the payout column from an employee`
28. `the Postback Inspector shows sold-with-no-upload as an alert`
29. `/suppressions renders the owner-only panel for an employee`

## Out of scope

- Conversion requeue, retry or any write to `conversion_uploads` (blocked item).
- Editing or deleting a lead, and adding or removing a suppression by hand.
- Lead search by email or phone number.
- Reason codes and the sanitized `last_error` from spec A on lead detail.

## Proposed (out of scope)

- A `(brand, created_at)` index on `leads` once volume outgrows the date-window scan.
- Map spec A's conversion reason codes and its allow-listed `last_error` onto lead detail after
  FUS-375 merges, so an employee sees a reason instead of nothing.
- A "PII access" filter chip on the Audit screen (`target_type=lead` already works as a URL query).
- Consent evidence on lead detail (`consent_evidence` row, `ip_hash` and `user_agent` owner-only).
- A retention job that drops PII columns after N days, which would make most of this moot.
