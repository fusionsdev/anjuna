# Panel spec B: Leads, CSV, Postback Inspector, PII audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can list, read, reconcile and export leads with PII; an employee does the same work on counts and status and never receives a name, email, phone, street address, birth date or money value; every PII release writes an audit row.

**Architecture:** Four new read-only endpoints on core's `AdminService`, declared in the shared contract and gated by `authorize()`. Core redacts PII per field inside the handler using the role from the request context, and awaits an audit insert into the factory D1 before it returns any PII body. The panel proxies the endpoints (no leads D1 binding, ADR-0001) and renders CSV itself from a core JSON export, reusing the `trafficRiskExport` pattern. Three new screens hang off the spec-1 shell.

**Tech Stack:** TypeScript strict, Zod v4 contracts, Cloudflare Workers + D1, Vitest with `@cloudflare/vitest-pool-workers` / Miniflare, React 19 with no router dependency.

**Spec:** `docs/superpowers/specs/2026-10-23-panel-leads-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No LeadsGate call, no deploy, no real external call, no secret in a file.
- **PII field list** (the only fields that count as PII on a lead): `first_name`, `last_name`, `birth_date`, `email`, `home_phone`, `work_phone`, `address`, `city`, `zip`. Plus the whole `suppressions.email` column. `state` is not PII and stays visible to an employee.
- **Money rule** (spec A, unchanged here): `postbacks[].payout`, `conversion.value` are `null` for any role other than `owner`.
- **Click ids never leave core.** No response field carries a `gclid`, `gbraid`, `wbraid`, `msclkid` or `click_id` value. `click_type` is a label only.
- **Audit rows never contain PII.** Field names, filters, counts and the actor's own query string only.
- **Audit fails closed.** Core `await`s the audit insert before returning a PII body; a failure propagates (core 500 → panel `502 bad_gateway`).
- `last_error` is owner-only on lead detail. Do not import or copy spec A's `packages/contracts/src/conversions.ts`; that lane is unmerged.
- No new migration in `packages/leads-db/migrations/`.
- Conflict rule: every new contract entry, core handler and panel route goes in one contiguous block marked `// spec leads`. Touch shared lines minimally.
- TDD: write the test, run it, see it fail, implement, see it pass.
- Done per task: `bun run typecheck` at the repo root green plus the suite of every package touched (`bun run --cwd packages/contracts test`, `bun run --cwd workers/core test`, `bun run --cwd apps/web test`).
- UI copy is Thai first with English in parentheses, matching the surrounding screens.

## Review Focus

Five inputs the spec implies but whose handling no task's happy path exercises. Each has a test added to the task that owns the code.

1. **A V1-era lead with NULL `work_phone`, `keyword`, `variant`, `experiment_id`, `updated_at`.** Columns 0003 added are nullable and about 1,000 production rows predate them. Detail, list and both CSVs must render an empty cell, never the string `"null"` and never a parse failure. (Tasks 2, 4, 12)
2. **`q` containing `%`, `_` or `\`.** A `LIKE` pattern built from raw input widens the search: `q=%` would return every lead, and on suppressions it would dump the whole email column to the owner under a one-character query. Escape before binding. (Tasks 2, 5)
3. **A CSV cell whose value starts with `=`, `+`, `-` or `@`, or contains a quote or CRLF.** An applicant name is attacker-supplied free text that lands in a spreadsheet. `csvCell` already guards this for the risk export; the PII columns must go through the same function. (Tasks 6, 8)
4. **Two leads with the same `created_at` to the millisecond.** `h.seedLead()` writes a fixed timestamp, so this is the common case in tests and a real case in production bursts. The keyset cursor must neither skip nor repeat a row across the page boundary. (Task 2)
5. **A `conversion_uploads.status` outside `pending|processing|uploaded|dead`.** The column is free text with a default; the drain on the VPS writes it. A strict enum would turn one odd row into a `502` for the whole detail page. Map an unknown value to `"pending"` and keep the raw string out of the response. (Task 3)

---

### Task 1: Contract — leads, export and suppressions schemas

**Files:**
- Modify: `packages/contracts/src/admin-api.ts` (new `// spec leads` block after `GetLeadResponse`, line 414; `AdminApi` entries after `getLead`, line 685; `ADMIN_AUDIT_ACTIONS`, line 419)
- Modify: `packages/contracts/test/admin-api.test.ts` (`PLAN_MATRIX` line 292, `authorize("getLead")` lines 194-197, endpoint count line 387)
- Create: `packages/contracts/fixtures/admin/leads.list.response.json`, `lead.get.response.employee.json`, `leads.export.response.json`, `leads.export.response.pii.json`, `suppressions.list.response.json`
- Modify: `packages/contracts/fixtures/admin/lead.get.response.json` (add `profile`, `conversion`)

**Interfaces:**
- Consumes: `Day`, `Timestamp`, `Count` (`admin-api.ts:153-155`), `LeadId` (`:359`), `LeadApplicant` (`:362`), `LeadOutcome` / `leadOutcome()` (`:309-320`), `LEAD_AGGREGATES_MAX_DAYS` (`:323`), `BrandId`, `Hostname`, `VariantId` from `common.js`.
- Produces: `LeadFilter`, `LeadsQuery`, `LeadListRow`, `LeadsResponse`, `LeadProfile`, `LeadConversion`, `LeadExportQuery`, `LeadExportRow`, `LeadExportResponse`, `LEAD_EXPORT_LIMIT`, `LEAD_EXPORT_COLUMNS`, `LEAD_EXPORT_PII_COLUMNS`, `SuppressionsQuery`, `SuppressionsResponse`, `SuppressionReason`, `SuppressionSource`, `LeadCursor`; `AdminApi.listLeads | getLead | leadExport | listSuppressions`.

- [ ] **Step 1: Write the failing tests** in `packages/contracts/test/admin-api.test.ts`

```ts
it("leads query refuses a window longer than 93 days and from after to", () => {
  expect(LeadsQuery.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
  expect(LeadsQuery.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(false);
  expect(LeadsQuery.safeParse({}).success).toBe(true); // both absent is allowed
  expect(LeadsQuery.safeParse({ q: "ab" }).success).toBe(false); // under 4 chars
  expect(LeadsQuery.safeParse({ limit: 201 }).success).toBe(false);
});

it("lead export refuses pii=1 for an employee and allows it for an owner", () => {
  const denied = authorize("leadExport", "employee", { pii: true });
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error).toEqual({ error: "forbidden_role", required_role: "owner", denied_fields: ["pii"] });
  expect(authorize("leadExport", "employee").ok).toBe(true);
  expect(authorize("leadExport", "owner", { pii: true }).ok).toBe(true);
});

it("lead detail parses the employee fixture with applicant, payout and value null", () => {
  const employeeLead = AdminApi.getLead.response.parse(fixture(A("lead.get.response.employee.json"))).lead;
  expect(employeeLead.applicant).toBeNull();
  expect(employeeLead.postbacks.every((p) => p.payout === null)).toBe(true);
  expect(employeeLead.conversion?.value).toBeNull();
  expect(employeeLead.conversion?.last_error).toBeNull();
  expect(employeeLead.profile.state).toBe("TX");
  expect(JSON.stringify(employeeLead)).not.toContain("fixture-click");
});

it("every new endpoint parses its fixture and sits in the role table", () => {
  expect(AdminApi.listLeads.response.safeParse(fixture(A("leads.list.response.json"))).success).toBe(true);
  expect(AdminApi.leadExport.response.safeParse(fixture(A("leads.export.response.pii.json"))).success).toBe(true);
  expect(AdminApi.listSuppressions.response.safeParse(fixture(A("suppressions.list.response.json"))).success).toBe(true);
  expect(row("listLeads").min_role).toBe("employee");
  expect(row("leadExport").min_role).toBe("employee");
  expect(row("listSuppressions").min_role).toBe("owner");
  expect(row("getLead").min_role).toBe("employee");
});

it("export column constants cover every row field and keep PII last", () => {
  const plain = Object.keys(LeadExportRow.parse(fixture(A("leads.export.response.json")).rows[0]));
  expect([...LEAD_EXPORT_COLUMNS]).toEqual(expect.arrayContaining(plain));
  expect(LEAD_EXPORT_PII_COLUMNS.slice(0, LEAD_EXPORT_COLUMNS.length)).toEqual([...LEAD_EXPORT_COLUMNS]);
  expect(LEAD_EXPORT_PII_COLUMNS).toContain("email");
  expect(LEAD_EXPORT_COLUMNS).not.toContain("email");
  expect(LEAD_EXPORT_PII_COLUMNS).not.toContain("click_id");
});
```

Also update in place:
- `PLAN_MATRIX` (`:292`): replace the `"View individual leads with PII"` row with two rows — `{ action: "View individual leads without PII", employee: "all", covered_by: ["listLeads", "getLead", "leadExport"] }` and `{ action: "Search the email suppression list", employee: "no", covered_by: ["listSuppressions"] }`. Add a comment above them that the PII *fields* of `getLead` are owner-only inside the handler and are covered by `workers/core/test/admin.test.ts`, not by the endpoint table.
- `authorize("getLead", "employee")` (`:194-197`): now `ok: true`.
- endpoint count (`:387`): `18`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/contracts test`
Expected: FAIL — `LeadsQuery is not defined`, `AdminApi.listLeads is undefined`.

- [ ] **Step 3: Implement the `// spec leads` block in `packages/contracts/src/admin-api.ts`**

Schemas exactly as the spec's "Core: new endpoints" section writes them. Extra decisions the spec leaves to the implementer:

- `LeadCursor = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)` — opaque to the contract; shape is core's business.
- `LeadFilter` carries the two `.refine()` checks only when both `from` and `to` are present.
- `LeadProfile` is a `strictObject` of the eleven non-identifying fields in the spec; `LeadApplicant` keeps its current shape and `LeadDetail.applicant` becomes `LeadApplicant.nullable()`.
- `LeadExportRow = LeadListRow.omit({ has_conversion: true, postback_count: true }).extend(<PII fields>.partial())` so one schema parses both column sets; `pii: z.boolean()` on the response says which set it is.
- `LeadExportQuery` also takes `limit: coerce.number().int().min(1).max(LEAD_EXPORT_LIMIT).default(LEAD_EXPORT_LIMIT)`, so `truncated` is testable without seeding 5,001 rows and the panel can offer a small preview later.
- `authorize()` gains a `leadExport` branch beside the `patchBrand` branch: when `patch?.pii` is truthy and the role is not `owner`, return `forbidden_role` with `required_role: "owner"` and `denied_fields: ["pii"]`. Keep the existing `patchBrand` branch untouched.
- `AdminApi.getLead.min_role` changes to `"employee"`; its doc comment states that the PII fields inside are owner-only and redacted by core.

Fixtures: derive the employee fixture from the owner one (same lead, `applicant: null`, `payout: null`, `value: null`, `last_error: null`) so a diff of the two files is the PII surface.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/contracts test && bun run typecheck`
Expected: PASS. Typecheck will also flag `workers/core/src/admin/index.ts` for the now-nullable `applicant`; leave that to Task 3 and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/admin-api.ts packages/contracts/test/admin-api.test.ts packages/contracts/fixtures/admin
git commit -m "feat(contracts): leads list, export and suppression schemas (FUS-376)"
```

---

### Task 2: Core — `listLeads`

**Files:**
- Modify: `workers/core/src/admin/index.ts` (new `// spec leads` handler block after `getLead`, line 612; router arm in `handleAdminRequest`, line 698)
- Modify: `workers/core/test/admin.test.ts`

**Interfaces:**
- Consumes: Task 1's `LeadsQuery`, `LeadsResponse`, `LeadListRow`; `parseWith`, `parseQuery`, `invalid`, `json`, `leadOutcome`.
- Produces: `encodeLeadCursor(createdAt: string, leadId: string): string`, `decodeLeadCursor(cursor: string): { created_at: string; lead_id: string } | null`, `likeEscape(value: string): string`, and `leadFilterSql(query: LeadsQuery, bindings: unknown[]): string` (the shared `WHERE` builder) — Tasks 4 and 5 reuse all four.

- [ ] **Step 1: Write the failing tests** in `workers/core/test/admin.test.ts`

```ts
describe("GET /admin/leads (FUS-376)", () => {
  // seedLead writes a fixed created_at; the suite UPDATEs it per lead to build the orderings.
  it("pages newest first and the cursor returns the next page with no overlap", async () => { /* limit=2, follow next_cursor, assert disjoint lead_ids and descending created_at */ });
  it("pages leads that share a created_at to the millisecond without skipping or repeating one", async () => { /* 3 leads, same created_at, limit=2; union of both pages is all 3 */ });
  it("filters by brand, day window, outcome and q on a lead_id prefix or an exact click_id", async () => { /* 4 assertions, one per filter */ });
  it("treats %, _ and backslash in q as literal characters", async () => { /* q="%" returns 0 rows, not every lead */ });
  it("returns the same bytes to an employee and an owner", async () => { /* compare .text() of both calls */ });
  it("reports has_conversion and postback_count per row", async () => { /* seedConversion on one lead only */ });
  it("renders a V1-era lead whose keyword, variant and experiment_id are NULL", async () => { /* parse succeeds, fields are null */ });
  it("answers 422 on a bad cursor, a reversed window and limit 201", async () => { /* 3 assertions */ });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd workers/core test -- admin`
Expected: FAIL with 404 `not_found` / `resource: "route"`.

- [ ] **Step 3: Implement `listLeads(url: URL, env: Env, context: AdminRequestContext): Promise<Response>`**

One SQL statement. Build the `WHERE` with the incremental `add()` helper that `listAudit` uses (`index.ts:650-657`) so the bind indexes stay correct:

```
SELECT l.lead_id, l.brand, l.hostname, l.status, l.requested_amount, l.loan_purpose,
       l.state, l.keyword, l.variant, l.form_variant, l.created_at,
       EXISTS (SELECT 1 FROM conversion_uploads c WHERE c.lead_id = l.lead_id) AS has_conversion,
       (SELECT COUNT(*) FROM postback_events p WHERE p.lead_id = l.lead_id) AS postback_count
FROM leads l
WHERE <filters>
ORDER BY l.created_at DESC, l.lead_id DESC
LIMIT ?n
```

- Day window: the half-open `julianday(created_at) >= ?from AND < ?toExclusive` form `leadAggregates` already uses (`index.ts:526-544`), with the same `setUTCDate(+1)` for the exclusive end. Default window is the last 30 days when both days are absent.
- Keyset predicate for a cursor: `(l.created_at < ?c OR (l.created_at = ?c AND l.lead_id < ?i))` — this is what makes Review Focus 4 pass.
- `q`: `(l.lead_id LIKE ?q ESCAPE '\' OR l.click_id = ?raw)` where the pattern is `likeEscape(q) + "%"`. `likeEscape` prefixes `\` to `%`, `_` and `\`.
- `status`: map through the three cases in the spec; `pending` is `NOT IN ('soldLead','rejectLead')`.
- Fetch `limit + 1` rows, slice to `limit`, and set `next_cursor` from the last kept row.
- Router arm: `if (route.endpoint === "listLeads") return listLeads(new URL(request.url), env, context);` placed in the `// spec leads` block.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd workers/core test -- admin && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/core/src/admin/index.ts workers/core/test/admin.test.ts
git commit -m "feat(core): leads list with keyset paging and filters (FUS-376)"
```

---

### Task 3: Core — `getLead` field-level redaction, conversion block, `pii.lead_view`

**Files:**
- Modify: `workers/core/src/admin/index.ts` (`getLead`, line 557; `writeAudit`, line 269)
- Modify: `workers/core/test/admin.test.ts` (including the existing `"keeps PII owner-only and scopes audit visibility by role"` case, line 352)

**Interfaces:**
- Consumes: Task 1's `LeadDetail`, `LeadProfile`, `LeadConversion`; Task 2's handler block placement.
- Produces: `writeAudit(env, context, action, entityType, entityId, oldValue, newValue, at)` — the `entity_type` parameter is new and Tasks 4 and 5 call it. `PII_LEAD_FIELDS: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
it("gives an employee the profile block and null applicant, payout and conversion value", async () => {
  const res = await h.admin(`/admin/leads/${leadId}`, employee);
  expect(res.status).toBe(200);
  const text = await res.text();
  const { lead } = GetLeadResponse.parse(JSON.parse(text));
  expect(lead.applicant).toBeNull();
  expect(lead.profile.state).toBe("TX");
  expect(lead.profile.monthly_income).toBe(3000);
  expect(lead.postbacks.every((p) => p.payout === null)).toBe(true);
  expect(lead.conversion?.value).toBeNull();
  expect(lead.conversion?.last_error).toBeNull();
  for (const pii of ["Test", "Applicant", "test@example.com", "2145550123", "100 Example St", "Dallas", "75201", "1990-01-01"]) {
    expect(text).not.toContain(pii);
  }
});

it("gives an owner the applicant block and writes one pii.lead_view row naming fields only", async () => {
  const before = await auditCount();
  const { lead } = GetLeadResponse.parse(await (await h.admin(`/admin/leads/${leadId}`, owner)).json());
  expect(lead.applicant?.first_name).toBe("Test");
  expect(await auditCount()).toBe(before + 1);
  const row = await h.factory.prepare("SELECT action, actor_id, entity_type, entity_id, after_json FROM audit_log ORDER BY id DESC LIMIT 1").first<any>();
  expect([row.action, row.entity_type, row.entity_id, row.actor_id]).toEqual(["pii.lead_view", "lead", leadId, owner.actor_id]);
  expect(JSON.parse(row.after_json).fields).toContain("email");
  expect(row.after_json).not.toContain("test@example.com");
});

it("writes no audit row for an employee read", async () => { /* auditCount unchanged */ });
it("reports click_type from the first present click id and never the value", async () => { /* seedConversion gclid "fixture-click"; click_type === "gclid"; text has no "fixture-click" */ });
it("returns conversion null when no upload row exists", async () => { /* second lead, no seedConversion */ });
it("maps an unknown conversion status to pending and keeps the raw value out", async () => { /* UPDATE conversion_uploads SET status='weird'; parse succeeds, status === "pending", text lacks "weird" */ });
it("renders a lead whose work_phone and updated_at are NULL", async () => { /* owner read; applicant.work_phone === null */ });
it("returns 502 to the panel and no PII when the audit insert fails", async () => { /* DROP the audit_log table for one call, then recreate */ });
```

Update line 352's case: the employee call is now `200`, not `403`; keep its audit-scope assertions unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd workers/core test -- admin`
Expected: FAIL — employee gets 403, no `profile` key, no audit row.

- [ ] **Step 3: Implement the redaction in `getLead`**

- `const isOwner = context.actor_role === "owner";`
- Build `profile` from the row's eleven non-identifying columns; build `applicant` only when `isOwner`, else `null`.
- `postbacks`: `payout: isOwner ? Number(event.payout) : null`.
- Second query: `SELECT status, gclid, gbraid, wbraid, msclkid, value, currency, occurred_at, attempts, last_error, next_attempt_at, created_at, updated_at FROM conversion_uploads WHERE lead_id = ?1`. Map to `LeadConversion` with `value`/`last_error` under `isOwner`, `click_type` as the first non-null of the four click columns else `"none"`, and `status` passed through a local `conversionStatus(raw: string)` that returns `"pending"` for anything outside the four known values.
- Before `return json(...)`, when `applicant !== null`: `await writeAudit(env, context, "pii.lead_view", "lead", leadId, {}, { fields: PII_LEAD_FIELDS }, new Date().toISOString())`. No try/catch — the spec's decision 6 requires it to fail closed.
- Widen `writeAudit`'s `action` union to the four new names and replace the hardcoded `'brand'` in its SQL with the new `entityType` parameter; update its three existing call sites to pass `"brand"`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd workers/core test -- admin && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/core/src/admin/index.ts workers/core/test/admin.test.ts
git commit -m "feat(core): field-level PII redaction on lead detail with an access audit row (FUS-376)"
```

---

### Task 4: Core — `leadExport` and the two export audit actions

**Files:**
- Modify: `workers/core/src/admin/index.ts` (`// spec leads` block, router arm)
- Modify: `workers/core/test/admin.test.ts`

**Interfaces:**
- Consumes: Task 1's `LeadExportQuery`, `LeadExportResponse`, `LEAD_EXPORT_LIMIT`; Task 2's filter builder and `likeEscape`; Task 3's `writeAudit`.
- Produces: nothing new. Task 8 consumes the endpoint.

- [ ] **Step 1: Write the failing tests**

```ts
describe("GET /admin/leads/export (FUS-376)", () => {
  it("is 403 forbidden_role for an employee who asks for pii=1 and 200 without it", async () => { /* employee pii=1 -> 403 denied_fields ["pii"]; employee plain -> 200, rows have no email key */ });
  it("returns the PII columns to an owner and writes pii.lead_export with filters and a row count", async () => { /* action, entity_type "lead_export", entity_id "<from>..<to>:<brand|all>", after_json has rows/pii/filters and no email */ });
  it("writes lead.export, not pii.lead_export, for a non-PII download", async () => { /* employee plain export, newest audit row action */ });
  it("sets truncated and returns only the newest rows when more matched", async () => {
    const page = LeadExportResponse.parse(await (await h.admin("/admin/leads/export?limit=2", owner)).json());
    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(LeadExportResponse.parse(await (await h.admin("/admin/leads/export", owner)).json()).truncated).toBe(false);
  });
  it("exports a V1-era lead with NULL keyword and work_phone as nulls", async () => { /* parse succeeds */ });
  it("never includes click_id or a click id value in an export row", async () => { /* .text() has no "fixture-click" and no click_id key */ });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd workers/core test -- admin`
Expected: FAIL with 404 route.

- [ ] **Step 3: Implement `leadExport(url, env, context)`**

Call Task 2's `leadFilterSql(query, bindings)` so the list and the export can never drift apart. Order and limit as in Task 2 but with `LIMIT LEAD_EXPORT_LIMIT + 1` and no cursor; `truncated` is `rows.length > LEAD_EXPORT_LIMIT`. Select the PII columns only when the role is `owner` and `pii` is `"1"`. The role check comes from `authorize("leadExport", context.actor_role, { pii: query.pii === "1" })`, called after the query parses. Audit with `writeAudit(..., pii ? "pii.lead_export" : "lead.export", "lead_export", \`${from}..${to}:${brand ?? "all"}\`, {}, { rows, truncated, pii, filters }, now)`, awaited before the body.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd workers/core test -- admin && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/core/src/admin/index.ts workers/core/test/admin.test.ts
git commit -m "feat(core): audited lead export with an owner-only PII column set (FUS-376)"
```

---

### Task 5: Core — `listSuppressions`

**Files:**
- Modify: `workers/core/src/admin/index.ts` (`// spec leads` block, router arm)
- Modify: `workers/core/test/admin.test.ts`

**Interfaces:**
- Consumes: Task 1's `SuppressionsQuery`, `SuppressionsResponse`; Task 2's `likeEscape`; Task 3's `writeAudit`.
- Produces: nothing new. Task 9 consumes the endpoint.

- [ ] **Step 1: Write the failing tests**

```ts
describe("GET /admin/suppressions (FUS-376)", () => {
  it("is 403 forbidden_role for an employee", async () => { /* required_role "owner" */ });
  it("searches by q as a substring, by reason and by source", async () => { /* seed 3 suppressions, 3 assertions */ });
  it("lowercases q and treats % and _ as literal characters", async () => { /* q="A@" matches "a@..."; q="%" returns 0 rows */ });
  it("pages ascending by email with no overlap", async () => { /* limit=2, follow next_cursor */ });
  it("writes one pii.suppression_search row with the query and the count and no email", async () => { /* entity_type "suppression", entity_id "search", after_json has q/reason/source/rows, text lacks the seeded address */ });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd workers/core test -- admin`
Expected: FAIL with 403/404.

- [ ] **Step 3: Implement `listSuppressions(url, env, context)`**

`SELECT email, reason, source, created_at, updated_at FROM suppressions WHERE <filters> ORDER BY email ASC LIMIT ?n`. `q` lowercased then `likeEscape`d into `%…%` with `ESCAPE '\'`. Cursor is `base64url(email)` compared with `email > ?`. Audit as in the spec, awaited before the body.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd workers/core test -- admin && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/core/src/admin/index.ts workers/core/test/admin.test.ts
git commit -m "feat(core): audited owner-only suppression search (FUS-376)"
```

---

### Task 6: Panel — extract `csvCell` into its own module

**Files:**
- Create: `apps/web/src/server/csv.ts`
- Modify: `apps/web/src/server/traffic-risk.ts` (delete the local `csvCell`, import and re-export it)
- Modify: `apps/web/test/traffic-risk-api.test.ts` (import path unchanged via the re-export; add the guard cases)

**Interfaces:**
- Produces: `csvCell(value: string | number | null): string`, `csvRows(columns: readonly string[], rows: Record<string, unknown>[]): string` — Task 8 uses both.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/traffic-risk-api.test.ts`

```ts
import { csvCell, csvRows } from "../src/server/csv";

it("guards a formula, a quote and a CRLF in one cell", () => {
  expect(csvCell("=1+1")).toBe("'=1+1");
  expect(csvCell("-Smith")).toBe("'-Smith");
  expect(csvCell('a"b')).toBe('"a""b"');
  expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  expect(csvCell(null)).toBe("");
  expect(csvCell(0)).toBe("0");
});

it("renders a header row and CRLF line endings in column order", () => {
  expect(csvRows(["b", "a"], [{ a: 1, b: "x" }])).toBe("b,a\r\nx,1\r\n");
  expect(csvRows(["a"], [{}])).toBe("a\r\n\r\n");
});
```

Keep the existing `csvCell`/`riskCsv` cases in that file working against the re-export.

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- traffic-risk`
Expected: FAIL — cannot resolve `../src/server/csv`.

- [ ] **Step 3: Implement `apps/web/src/server/csv.ts`**

Move `csvCell` across byte for byte. `csvRows` joins `columns` as the header, maps each row through `columns.map((c) => csvCell(row[c] as string | number | null ?? null))`, and ends every line with `\r\n` including the last, matching `riskCsv`. In `traffic-risk.ts`, `export { csvCell } from "./csv.js";` and rewrite `riskCsv` to call `csvRows(RISK_EXPORT_COLUMNS, ...)` only if the output stays byte-identical; otherwise leave `riskCsv` as it is.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test -- traffic-risk && bun run typecheck`
Expected: PASS, including the pre-existing risk CSV cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/csv.ts apps/web/src/server/traffic-risk.ts apps/web/test/traffic-risk-api.test.ts
git commit -m "refactor(web): move the CSV cell guard into its own module (FUS-376)"
```

---

### Task 7: Panel — mock core for the four endpoints

**Files:**
- Modify: `apps/web/src/server/mock-core.ts`
- Create: `apps/web/test/mock-core-leads.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas and fixtures.
- Produces: mock responses for `listLeads`, `getLead`, `leadExport`, `listSuppressions`. Tasks 8, 9, 11, 12, 13 all test against them.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/mock-core-leads.test.ts`

```ts
it("serves the four leads endpoints with the contract check order", async () => { /* 401 without context, 403 for employee on listSuppressions and on leadExport pii=1, 422 on a bad filter, 200 otherwise */ });
it("redacts the employee lead detail exactly as the fixtures do", async () => { /* applicant null, payout null, no PII substring */ });
it("filters its lead list by brand and status", async () => { /* fixture rows, 2 assertions */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- mock-core-leads`
Expected: FAIL — `not_found` route from the mock.

- [ ] **Step 3: Implement the four arms in `mock-core.ts`**

Follow the file's own pattern: parse the query with the contract schema in the pre-check section (`mock-core.ts:145-176`), run `authorize()` with `{ pii: true }` for `leadExport` in the gate section (`:182-188`), then answer from the fixture in the `switch` (`:195-295`). `getLead` picks the owner or employee fixture by `ctx.actor_role`. `leadExport` picks the plain or PII fixture by the `pii` param. Filtering is an in-memory `filter()` over the fixture rows for `brand` and `status` only — the mock does not need the day window or the cursor, and a comment says so.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test && bun run typecheck`
Expected: PASS (the whole web suite: the mock is shared).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/mock-core.ts apps/web/test/mock-core-leads.test.ts
git commit -m "test(web): mock core serves the leads, export and suppression endpoints (FUS-376)"
```

---

### Task 8: Panel — `/api/leads`, `/api/leads/export`, `/api/leads/:lead_id`

**Files:**
- Create: `apps/web/src/server/leads.ts`
- Modify: `apps/web/src/server/index.ts` (delete the owner gate at `:188-196`, add the handler to the chain at `:108-124`)
- Create: `apps/web/test/leads-api.test.ts`

**Interfaces:**
- Consumes: Task 1's schemas, Task 6's `csvCell`/`csvRows`, Task 7's mock, `callCore`, `authorize`.
- Produces: `handleLeadsRoute(request, env, url, path, ctx): Promise<Response | null>`.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/leads-api.test.ts`

```ts
it("does not capture /api/leads/aggregates or /api/leads/export with the lead id route", async () => {
  expect((await call("/api/leads/aggregates?from=2026-09-26&to=2026-10-02", { cookie: employee })).status).toBe(200);
  expect((await call("/api/leads/export", { cookie: employee })).headers.get("content-type")).toBe("text/csv; charset=utf-8");
});
it("answers 200 with applicant null to an employee on lead detail", async () => { /* parse GetLeadResponse */ });
it("returns CSV with the declared columns, CRLF rows and the formula guard", async () => { /* header equals LEAD_EXPORT_COLUMNS.join(","), filename leads-<from>_<to>.csv */ });
it("is 403 for an employee on pii=1 and sets x-export-truncated for an owner", async () => { /* 2 assertions, filename ends -pii.csv */ });
it("passes the filters through and answers 422 on a bad one", async () => { /* brand/from/to/status/q, then from>to */ });
it("answers 401 without a session on every leads route", async () => { /* 3 paths */ });
```

Update `apps/web/test/api.test.ts:145` (`expectForbidden` on the employee lead read) to assert `200` with `applicant === null`, and extend the owner case at `:201` for `profile` and `conversion`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- leads-api`
Expected: FAIL — 404 on `/api/leads`, 403 on the employee detail read.

- [ ] **Step 3: Implement `apps/web/src/server/leads.ts`**

Shape it on `handleTrafficRiskRoute` (`traffic-risk.ts:38-85`): `GET` only, match `/api/leads`, then `/api/leads/export`, then `^\/api\/leads\/([^/]+)$` **last**, and return `null` for anything else so `index.ts` keeps its `/api/leads/aggregates` arm. Gate each path with `authorize()`; for the export pass `{ pii: url.searchParams.get("pii") === "1" }`. Parse the core body with `LeadExportResponse` and render with `csvRows(pii ? LEAD_EXPORT_PII_COLUMNS : LEAD_EXPORT_COLUMNS, body.rows)`. Filename `leads-${from}_${to}${pii ? "-pii" : ""}.csv` using the parsed query values, never the raw ones. Headers as in the spec. In `index.ts`, add the call in its own `// spec leads` line beside the other handlers and delete the old lead-detail arm.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/leads.ts apps/web/src/server/index.ts apps/web/test/leads-api.test.ts apps/web/test/api.test.ts
git commit -m "feat(web): leads list, detail and CSV export routes (FUS-376)"
```

---

### Task 9: Panel — `/api/suppressions`

**Files:**
- Create: `apps/web/src/server/suppressions.ts`
- Modify: `apps/web/src/server/index.ts` (handler chain, `// spec leads` block)
- Create: `apps/web/test/suppressions-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `SuppressionsQuery`/`SuppressionsResponse`, Task 7's mock.
- Produces: `handleSuppressionsRoute(request, env, url, path, ctx): Promise<Response | null>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("is 403 forbidden_role for an employee and 200 for an owner", async () => { /* 2 assertions */ });
it("passes q, reason, source, limit and cursor through to core", async () => { /* parse SuppressionsResponse */ });
it("answers 401 without a session and 422 on an unknown reason", async () => { /* 2 assertions */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- suppressions-api`
Expected: FAIL — 404.

- [ ] **Step 3: Implement `handleSuppressionsRoute`** — same shape as Task 8, one path, `authorize("listSuppressions", ctx.actor_role)`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/suppressions.ts apps/web/src/server/index.ts apps/web/test/suppressions-api.test.ts
git commit -m "feat(web): owner-only suppression search route (FUS-376)"
```

---

### Task 10: Client — routes, page titles, API client

**Files:**
- Modify: `apps/web/src/client/router.ts` (`Route` union, `STATIC`, the `one` regex, `routePath`)
- Modify: `apps/web/src/client/components/AppShell.tsx` (`pageTitle`)
- Modify: `apps/web/src/client/api.ts`
- Modify: `apps/web/test/router.ui.test.tsx`

**Interfaces:**
- Consumes: Task 1's schemas.
- Produces: `Route` gains `{ view: "leads"; leadId: string | null }` and `{ view: "suppressions" }`; `api.leads(filter)`, `api.lead(id)`, `api.leadsExportUrl(filter, pii)`, `api.suppressions(filter)`. `LeadFilterState` (Task 11) and `SuppressionFilterState` (Task 13) are the client-side filter types, both exported from `api.ts`.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/router.ui.test.tsx`

```ts
it("parses /leads, /leads/<id> and /suppressions and round-trips each through routePath", () => { /* 6 assertions, including a bad %-escape id reading as null */ });
it("builds an export URL that carries every set filter and the pii flag", () => {
  expect(api.leadsExportUrl({ from: "2026-10-01", to: "2026-10-31", brand: "brand-a", status: "sold", q: "" }, true))
    .toBe("/api/leads/export?from=2026-10-01&to=2026-10-31&brand=brand-a&status=sold&pii=1");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- router`
Expected: FAIL — `not-found` for `/leads`.

- [ ] **Step 3: Implement**

Add both views to the `Route` union, `/leads` and `/suppressions` to `STATIC`, `leads` to the `one` regex alternation (`router.ts:62`), and a `leads` case to `routePath`. Add both keys to `pageTitle` — Thai first: `"ลีด (Leads)"`, `"อีเมลที่บล็อก (Suppressions)"`. In `api.ts`, the four methods, each parsing its contract schema the way `trafficRisk` does; `leadsExportUrl` returns a plain string so the browser downloads with the session cookie, and omits empty filter values.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/router.ts apps/web/src/client/components/AppShell.tsx apps/web/src/client/api.ts apps/web/test/router.ui.test.tsx
git commit -m "feat(web): leads and suppressions routes with their API client (FUS-376)"
```

---

### Task 11: Client — Leads list screen

**Files:**
- Create: `apps/web/src/client/screens/Leads.tsx`
- Create: `apps/web/test/leads.ui.test.tsx`

**Interfaces:**
- Consumes: Task 10's `api.leads`, `api.leadsExportUrl`, `LeadFilterState`; `DataTable`/`Column`, `StatusBadge`, `EmptyState`, `Spinner`, `ConfirmDialog` from `components/`; `useBrandLabels`/`BrandLabel` from `brand-labels.tsx`; `navigate`, `routePath` from `router.ts`.
- Produces: `<LeadsScreen me={me} selectedId={null} onSelect={(id: string) => void} />` — Task 14 mounts it.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/leads.ui.test.tsx`

```ts
it("lists leads newest first with the domain, outcome badge and amount", async () => { /* fixture rows rendered, brand cell shows the domain not brand_id */ });
it("writes the filter state to the URL query string and refetches", async () => { /* change status select, assert location.search and the request */ });
it("hides the PII CSV button from an employee", async () => { /* queryByText is null; the plain CSV link is present */ });
it("confirms before a PII download for an owner and the link carries pii=1", async () => { /* ConfirmDialog text names the audit, href ends pii=1 */ });
it("pages with next_cursor and keeps the cursor out of the URL", async () => { /* click Next, assert the request and that location.search has no cursor */ });
it("shows an empty state that distinguishes no leads from no match", async () => { /* 2 renders */ });
it("renders a row whose keyword and variant are null without printing null", async () => { /* textContent lacks "null" */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- leads.ui`
Expected: FAIL — cannot resolve `screens/Leads`.

- [ ] **Step 3: Implement `LeadsScreen`**

Columns and filter bar exactly as the spec's `/leads` section lists them. The filter lives in the URL query string (read on mount, written with `navigate(..., { replace: true })` on change); the cursor lives in `useState`. The reconciliation cell is a `StatusBadge` derived from `has_conversion` and `postback_count`. Follow the layout and class names of `screens/Funnel.tsx` so the screen inherits the console styling; no new CSS file unless `Funnel.tsx`'s classes do not cover it.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test -- leads.ui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/Leads.tsx apps/web/test/leads.ui.test.tsx
git commit -m "feat(web): leads list screen with filters, paging and CSV download (FUS-376)"
```

---

### Task 12: Client — Lead detail and the Postback Inspector

**Files:**
- Create: `apps/web/src/client/screens/LeadDetail.tsx`
- Create: `apps/web/test/lead-detail.ui.test.tsx`

**Interfaces:**
- Consumes: Task 10's `api.lead`; `DataTable`, `StatusBadge`, `EmptyState`, `Spinner`, `NotFound`, `BrandLabel`.
- Produces: `<LeadDetailScreen me={me} leadId={string} onBack={() => void} />` — Task 14 mounts it.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/lead-detail.ui.test.tsx`

```ts
it("shows the applicant block and the payout column to an owner", async () => { /* email visible, payout header present */ });
it("hides the applicant block and the payout column from an employee and says why", async () => { /* owner-only notice visible, no email, no payout header, no empty field rows */ });
it("shows sold with no conversion upload as an alert", async () => { /* soldLead postback + conversion null */ });
it("shows a dead upload as an alert and an uploaded one as ok", async () => { /* 2 renders */ });
it("shows no postback yet as a warning", async () => { /* empty postbacks */ });
it("puts last_error behind a details element for an owner and omits it for an employee", async () => { /* 2 assertions */ });
it("renders null work_phone, keyword and updated_at as empty cells", async () => { /* textContent lacks "null" */ });
it("renders NotFound when the lead does not exist", async () => { /* 404 from the mock */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- lead-detail`
Expected: FAIL — cannot resolve `screens/LeadDetail`.

- [ ] **Step 3: Implement `LeadDetailScreen`**

Sections and the four reconciliation rules exactly as the spec's `/leads/:lead_id` section states them, derived in the client from `postbacks` and `conversion`. The employee notice is one line: `ข้อมูลส่วนบุคคลสงวนสำหรับ Owner (Personal data is owner-only)`. A null field renders as an empty cell, never `"null"` or `"-"` inside a value that could be real data.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test -- lead-detail && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/LeadDetail.tsx apps/web/test/lead-detail.ui.test.tsx
git commit -m "feat(web): lead detail with the postback and conversion inspector (FUS-376)"
```

---

### Task 13: Client — Suppressions screen

**Files:**
- Create: `apps/web/src/client/screens/Suppressions.tsx`
- Create: `apps/web/test/suppressions.ui.test.tsx`

**Interfaces:**
- Consumes: Task 10's `api.suppressions`; `DataTable`, `StatusBadge`, `EmptyState`, `NotFound`.
- Produces: `<SuppressionsScreen me={me} />` — Task 14 mounts it.

- [ ] **Step 1: Write the failing tests**

```ts
it("searches by value, reason and source and pages by cursor", async () => { /* 4 assertions */ });
it("states that each search is recorded in the audit log", async () => { /* notice text present */ });
it("renders the owner-only panel for an employee and makes no request", async () => { /* NotFound, fetch not called */ });
it("shows an empty state when nothing matches", async () => { /* 1 assertion */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- suppressions.ui`
Expected: FAIL — cannot resolve `screens/Suppressions`.

- [ ] **Step 3: Implement `SuppressionsScreen`** per the spec's `/suppressions` section. An employee render returns the same `NotFound` owner-only panel `/users` uses (`App.tsx:110-112`) and must not fire the request.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run --cwd apps/web test -- suppressions.ui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/Suppressions.tsx apps/web/test/suppressions.ui.test.tsx
git commit -m "feat(web): owner-only suppression search screen (FUS-376)"
```

---

### Task 14: Client — mount the screens in the shell

**Files:**
- Modify: `apps/web/src/client/App.tsx` (nav array `:67-79`, view block `:88-116`)
- Create: `apps/web/test/leads-route.ui.test.tsx`

**Interfaces:**
- Consumes: Tasks 10 to 13.
- Produces: the finished lane.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/leads-route.ui.test.tsx`

```ts
it("deep links /leads/<id> to the detail screen and back returns to the list", async () => { /* pushState, render, history.back() */ });
it("shows the Leads nav item to both roles and Suppressions only to an owner", async () => { /* 2 renders */ });
it("renders the owner-only panel on /suppressions for an employee", async () => { /* 1 assertion */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd apps/web test -- leads-route`
Expected: FAIL — `/leads` renders `NotFound`.

- [ ] **Step 3: Implement the wiring**

Two nav entries in the spec's positions (`leads` after `funnel`, `suppressions` after `mailing`, `show: me.role === "owner"` on the second) and two view arms mounting `LeadsScreen`/`LeadDetailScreen` and `SuppressionsScreen`, following the `templates` arm's `selectedId`/`onSelect` pattern. Keep the diff on `App.tsx` to these lines: lane C edits the same file.

- [ ] **Step 4: Run to verify they pass**

Run: `bun run typecheck && bun run test`
Expected: PASS, whole repo.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/App.tsx apps/web/test/leads-route.ui.test.tsx
git commit -m "feat(web): mount the leads and suppressions screens in the shell (FUS-376)"
```

---

## Before the PR

1. `git fetch origin && git rebase origin/main`. Expect conflicts in `packages/contracts/src/admin-api.ts` (`AdminApi` table), `packages/contracts/test/admin-api.test.ts` (the `ADMIN_ENDPOINTS` length assertion and `PLAN_MATRIX`), `workers/core/src/admin/index.ts` (router arms) and `apps/web/src/client/App.tsx` (nav and view lists). Keep both lanes' blocks; the endpoint count is the sum.
2. `bun run typecheck && bun run test` green at the root.
3. Muse UI check on `/leads`, `/leads/:id` and `/suppressions` at desktop and 375 px, as owner and as employee.
4. PR to `main`, title `feat(web): panel spec B, leads list, detail, CSV, postback inspector and PII audit (FUS-376)`, each acceptance criterion in the spec mapped to its test name.
