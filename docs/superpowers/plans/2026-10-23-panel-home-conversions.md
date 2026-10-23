# Panel spec A: Home overview and Conversions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Conversions page and a Home overview with deltas, conversion health and daily bars, and stop sending money fields to employees from core.

**Architecture:** Core (`workers/core`) owns the data and redacts money by `context.actor_role`. A new `conversionsReport` admin endpoint reads `conversion_uploads` joined to `leads.brand`. The panel server (`apps/web/src/server`) forwards it like `/api/spend`; the panel client adds a `/conversions` route and extends `Home.tsx`.

**Tech Stack:** Bun workspaces, Turborepo, TypeScript strict, zod 4, Cloudflare Workers + D1 (Miniflare / vitest-pool-workers), React 19, Vitest 4 (worker, ui jsdom, build projects).

**Spec:** `docs/superpowers/specs/2026-10-23-panel-home-conversions-design.md`

## Global Constraints

- Money fields (`funnelReport.rows[].revenue`, `conversionsReport.value_totals`, `conversionsReport.rows[].value`) are `null` for any `actor_role` other than `owner`. Redaction happens in core and in the panel mock core. The client never receives a number it must hide.
- Conversions are read-only. No requeue, edit or delete endpoint or button.
- Click id values (`gclid`, `gbraid`, `wbraid`, `msclkid`) never leave core. Only `click_type` names which one exists.
- No new runtime dependency. Charts are inline SVG.
- Do not change `conversion_uploads`, the drain routes (`/api/conversions/*`) or `drain.mjs`.
- UI copy: Thai first, English in parentheses where the spec gives both. Copy strings exactly as the spec tables give them.
- Period rule: `today|7d|30d` as UTC days, using `spendPeriodRange` from `packages/contracts/src/spend.ts:65`.
- Each task: `bun run typecheck` at the repo root and the touched packages' test suites green before commit. Commit messages end with `(FUS-375)`.
- AGENTS.md: no secrets, no deploys, no real external calls.

## Review Focus

1. Employee session on Home: revenue and profit cells show "—" (hidden), never `$0`; covered in Task 2 (`home.ui.test.tsx` "employee sees no revenue").
2. `last_error` with leading spaces or upper case (`"  No Route for brand=x"`) still maps to `no_route`; covered in Task 1 table test.
3. Deep link `/conversions?period=bogus&status=x` falls back to `7d` and `all` without a crash and without a 422; covered in Task 5.
4. Previous-window value 0 (new brand) gives a delta of `–`, never `Infinity%` or `NaN%`; covered in Task 6 `delta()` unit test.
5. Conversion row whose lead has no click id at all gives `click_type: null` and reason `no_click_id`; covered in Task 3.

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/contracts/src/conversions.ts` (new) | 1 | `ConversionReasonCode`, `conversionReasonCode()`, `CONVERSION_STATUSES` |
| `packages/contracts/src/admin-api.ts` | 1, 2 | `ConversionsQuery`, `ConversionsReportResponse`, `conversionsReport` endpoint; funnel `revenue` nullable |
| `packages/contracts/fixtures/admin/conversions.response.json` (new) | 1 | Owner fixture, one row per reason code |
| `packages/contracts/test/conversions.test.ts` (new) | 1 | Reason table and schema tests |
| `workers/core/src/admin/reports.ts`, `workers/core/src/admin/index.ts` | 2, 3 | Funnel redaction; `loadConversions` |
| `workers/core/test/conversions-report.test.ts` (new), `workers/core/test/admin.test.ts` | 2, 3 | Core tests |
| `apps/web/src/server/index.ts`, `apps/web/src/server/mock-core.ts` | 2, 4 | `/api/conversions`; mock redaction |
| `apps/web/test/conversions-api.test.ts` (new), `apps/web/test/funnel-redaction.test.ts` (new) | 2, 4 | Panel worker tests |
| `apps/web/src/client/api.ts` | 2, 4 | `api.conversions`, `api.leadAggregates`; `revenue` nullable |
| `apps/web/src/client/conversion-labels.ts` (new) | 5 | Reason label + fix text table |
| `apps/web/src/client/screens/Conversions.tsx` (new), `Conversions.css` (new) | 5 | Conversions page |
| `apps/web/src/client/router.ts`, `App.tsx`, `components/AppShell.tsx` | 5 | Route, nav, title |
| `apps/web/src/client/home-metrics.ts` (new) | 6 | `previousRange`, `delta` |
| `apps/web/src/client/components/DailyBars.tsx` (new) | 8 | Inline SVG bars |
| `apps/web/src/client/screens/Home.tsx`, `Home.css` | 2, 6, 7, 8 | Home changes |
| `apps/web/src/client/screens/Funnel.tsx` | 2 | Null revenue |

---

### Task 1: Contracts for conversions

**Files:**
- Create: `packages/contracts/src/conversions.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./conversions.js";`)
- Modify: `packages/contracts/src/admin-api.ts` (schemas next to `FunnelReportResponse`, endpoint in `AdminApi` after `spendReport`)
- Create: `packages/contracts/fixtures/admin/conversions.response.json`
- Test: `packages/contracts/test/conversions.test.ts`

**Interfaces:**
- Produces: `CONVERSION_STATUSES`, `ConversionStatus`, `ConversionReasonCode` (zod enum), `conversionReasonCode(status: ConversionStatus, lastError: string | null): ConversionReasonCode | null`, `ConversionsQuery`, `ConversionsReportResponse`, `ConversionRow` (type), `AdminApi.conversionsReport`, `CONVERSIONS_ROW_LIMIT = 200`, `CONVERSION_STALLED_HOURS = 6`.

- [ ] **Step 1: Write the failing test** `packages/contracts/test/conversions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/admin/conversions.response.json";
import { AdminApi, ConversionsQuery, ConversionsReportResponse, conversionReasonCode } from "../src/index.js";

describe("conversionReasonCode", () => {
  it.each([
    ["no click id", "no_click_id"],
    ["no gclid/gbraid/wbraid", "no_click_id"],
    ["no msclkid", "no_click_id"],
    ["reclaim: exhausted attempts after stale lease", "lease_exhausted"],
    ["no route for brand=brand-a hostname=a.example", "no_route"],
    ["  No Route for brand=x", "no_route"],
    ["not ready yet: click too recent", "not_ready"],
    ["missing Microsoft env (ACCOUNT/CONVERSION_NAME)", "ms_env_missing"],
    ["upload failed", "upload_failed"],
    ["INVALID_GCLID: The gclid could not be decoded", "platform_error"],
  ] as const)("maps %j to %s", (text, code) => {
    expect(conversionReasonCode("dead", text)).toBe(code);
  });

  it("returns null for empty text, null text and uploaded rows", () => {
    expect(conversionReasonCode("pending", null)).toBeNull();
    expect(conversionReasonCode("pending", "   ")).toBeNull();
    expect(conversionReasonCode("uploaded", "upload failed")).toBeNull();
  });
});

describe("conversions schemas", () => {
  it("defaults status to all and rejects an unknown period", () => {
    expect(ConversionsQuery.parse({ period: "7d" })).toEqual({ period: "7d", status: "all" });
    expect(ConversionsQuery.safeParse({ period: "90d" }).success).toBe(false);
    expect(ConversionsQuery.safeParse({ period: "7d", extra: "1" }).success).toBe(false);
  });

  it("parses the owner fixture and an employee shape with null money", () => {
    const owner = ConversionsReportResponse.parse(fixture);
    const employee = { ...owner, value_totals: null, rows: owner.rows.map((r) => ({ ...r, value: null })) };
    expect(ConversionsReportResponse.parse(employee).value_totals).toBeNull();
  });

  it("rejects a row that carries a click id value", () => {
    const row = { ...fixture.rows[0], gclid: "abc" };
    expect(ConversionsReportResponse.safeParse({ ...fixture, rows: [row] }).success).toBe(false);
  });

  it("registers the endpoint for employees", () => {
    expect(AdminApi.conversionsReport).toMatchObject({ method: "GET", path: "/admin/conversions", min_role: "employee" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd packages/contracts test -- conversions`
Expected: FAIL, `conversionReasonCode` is not exported and the fixture file is missing.

- [ ] **Step 3: Write `packages/contracts/src/conversions.ts`**

```ts
import { z } from "zod";

/** Status values of `conversion_uploads.status` (leads D1, 0001_v1_baseline.sql). */
export const CONVERSION_STATUSES = ["pending", "processing", "uploaded", "dead"] as const;
export const ConversionStatus = z.enum(CONVERSION_STATUSES);
export type ConversionStatus = z.infer<typeof ConversionStatus>;

export const ConversionReasonCode = z.enum([
  "no_click_id", "lease_exhausted", "no_route", "not_ready", "ms_env_missing", "upload_failed", "platform_error",
]);
export type ConversionReasonCode = z.infer<typeof ConversionReasonCode>;

/** Rows returned by one conversions report call. */
export const CONVERSIONS_ROW_LIMIT = 200;
/** Same threshold as the conversion_stalled alert (insights alerts.ts). */
export const CONVERSION_STALLED_HOURS = 6;

// Prefixes of the `last_error` strings core and drain.mjs write. First match wins.
const PREFIXES: Array<[string, ConversionReasonCode]> = [
  ["no click id", "no_click_id"],
  ["no gclid/gbraid/wbraid", "no_click_id"],
  ["no msclkid", "no_click_id"],
  ["reclaim: exhausted attempts", "lease_exhausted"],
  ["no route for brand=", "no_route"],
  ["not ready yet", "not_ready"],
  ["missing microsoft env", "ms_env_missing"],
  ["upload failed", "upload_failed"],
];

/** Reason code for a row's `last_error`. Uploaded rows and empty text have no reason. */
export function conversionReasonCode(status: ConversionStatus, lastError: string | null): ConversionReasonCode | null {
  if (status === "uploaded") return null;
  const text = (lastError ?? "").trim().toLowerCase();
  if (!text) return null;
  return PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "platform_error";
}
```

- [ ] **Step 4: Add schemas to `admin-api.ts`** after `FunnelReportResponse` (import `ConversionReasonCode`, `ConversionStatus`, `CONVERSION_STATUSES` from `./conversions.js` and `SpendPeriod` from `./spend.js`):

```ts
// --- GET /admin/conversions (read-only, money redacted for non-owners) --------------------------

const Money = z.number().finite().min(0);

export const ConversionsQuery = z.strictObject({
  period: SpendPeriod,
  status: z.enum(["all", ...CONVERSION_STATUSES]).default("all"),
  brand: BrandId.optional(),
  /** Test clock, as in AlertsQuery. Omitted means now. */
  now: Timestamp.optional(),
});
export type ConversionsQuery = z.infer<typeof ConversionsQuery>;

export const ConversionRow = z.strictObject({
  lead_id: LeadId,
  brand: z.string().min(1),
  status: ConversionStatus,
  reason_code: ConversionReasonCode.nullable(),
  last_error: z.string().max(300).nullable(),
  /** Which click id the row has. The id value never leaves core. */
  click_type: z.enum(["gclid", "gbraid", "wbraid", "msclkid"]).nullable(),
  attempts: Count,
  /** USD. null for a non-owner. */
  value: Money.nullable(),
  currency: z.string().length(3),
  occurred_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
  next_attempt_at: Timestamp.nullable(),
});
export type ConversionRow = z.infer<typeof ConversionRow>;

export const ConversionsReportResponse = z.strictObject({
  period: SpendPeriod,
  from: Timestamp,
  /** Exclusive. */
  to: Timestamp,
  /** Period window counts; ignore the status and brand filters. */
  totals: z.strictObject({ pending: Count, processing: Count, uploaded: Count, dead: Count }),
  /** USD sums for the period window. null for a non-owner. */
  value_totals: z.strictObject({ uploaded: Money, dead: Money }).nullable(),
  /** Rows still pending more than CONVERSION_STALLED_HOURS after creation, any age. */
  stalled: Count,
  rows: z.array(ConversionRow),
  /** True when more than CONVERSIONS_ROW_LIMIT rows matched. */
  truncated: z.boolean(),
});
export type ConversionsReportResponse = z.infer<typeof ConversionsReportResponse>;
```

`LeadId` is declared at `admin-api.ts:359`; place these schemas after it (move the block below `LeadId` if needed). `brand` uses `z.string().min(1)` because `leads.brand` is not guaranteed to match `BrandId` for old rows.

Add to `AdminApi` after `spendReport`:

```ts
  conversionsReport: {
    method: "GET",
    path: "/admin/conversions",
    min_role: "employee",
    query: ConversionsQuery,
    response: ConversionsReportResponse,
  },
```

- [ ] **Step 5: Write the fixture** `packages/contracts/fixtures/admin/conversions.response.json`: `period "7d"`, `from "2026-10-17T00:00:00.000Z"`, `to "2026-10-24T00:00:00.000Z"`, `totals {pending:3, processing:1, uploaded:5, dead:4}`, `value_totals {uploaded: 412.5, dead: 170}`, `stalled 1`, `truncated false`, and 9 rows: one `uploaded` row (reason null, click_type gclid, value 85), one row per reason code (7 rows, statuses `dead` or `pending`, `last_error` text from the Step 1 table), one `processing` row with null `last_error`. Brands `brand-a` and `brand-b`. Lead ids are UUID strings. All timestamps inside the window.

- [ ] **Step 6: Run tests, then typecheck**

Run: `bun run --cwd packages/contracts test` then `bun run typecheck`
Expected: PASS. If a contracts test enumerates every `AdminApi` endpoint (fixture per endpoint, route matcher table), extend it for `conversionsReport`. If `apps/web/src/server/mock-core.ts` fails typecheck on an exhaustive switch, add `case "conversionsReport": return json(200, conversionsReport);` there with the fixture import; Task 4 replaces it.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/web/src/server/mock-core.ts
git commit -m "feat(contracts): conversions report schema and reason codes (FUS-375)"
```

---

### Task 2: Funnel revenue is owner-only at field level

**Files:**
- Modify: `packages/contracts/src/admin-api.ts:524` (`revenue` nullable)
- Modify: `workers/core/src/admin/index.ts:736-740` (pass role), `workers/core/src/admin/reports.ts:25-28`
- Modify: `apps/web/src/server/mock-core.ts:283-284`
- Modify: `apps/web/src/client/screens/Home.tsx:40-55, 165-167, 216`, `apps/web/src/client/screens/Funnel.tsx:173`
- Test: `workers/core/test/admin.test.ts`, `apps/web/test/funnel-redaction.test.ts` (new), `apps/web/test/home.ui.test.tsx`

**Interfaces:**
- Consumes: `AdminRequestContext.actor_role`.
- Produces: `loadFunnel(env, filter, role: AdminRole)`; `FunnelReportResponse.rows[].revenue: number | null`; Home `FunnelTotals.revenue: number | null`.

- [ ] **Step 1: Failing core test** in `workers/core/test/admin.test.ts`, inside `describe("AdminService contract")`, next to the employee funnel test at line 89:

```ts
  it("sends funnel revenue to the owner and null revenue to an employee", async () => {
    const query = new URLSearchParams({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" });
    const asOwner = FunnelReportResponse.parse(await (await h.admin(`/admin/funnel?${query}`, owner)).json());
    const asEmployee = FunnelReportResponse.parse(await (await h.admin(`/admin/funnel?${query}`, employee)).json());
    expect(asOwner.rows.length).toBeGreaterThan(0);
    expect(asOwner.rows.every((r) => typeof r.revenue === "number")).toBe(true);
    expect(asEmployee.rows.map((r) => r.revenue)).toEqual(asOwner.rows.map(() => null));
    expect(asEmployee.rows.map((r) => r.sold)).toEqual(asOwner.rows.map((r) => r.sold));
  });
```

The existing employee funnel test at line 89 compares revenue to a number; change its expectation to `null` for revenue.

- [ ] **Step 2: Run** `bun run --cwd workers/core test -- admin` — Expected: FAIL (employee gets a number).

- [ ] **Step 3: Implement.** Contract: `revenue: z.number().finite().min(0).nullable(),` with a doc comment `/** USD. null for a non-owner. */`. Core `reports.ts`:

```ts
export async function loadFunnel(env: Env, filter: FunnelQuery, role: AdminRole): Promise<FunnelReportResponse> {
  const report = await funnelReport(env.LEADS, EMPTY_EVENTS, filter);
  const shown = role === "owner" ? report : { ...report, rows: report.rows.map((row) => ({ ...row, revenue: null })) };
  return FunnelReportResponse.parse(shown);
}
```

`index.ts:739`: `return json(FunnelReportResponse.parse(await loadFunnel(env, filter, context.actor_role)));`. If `actor_role` can be `"system"`, it gets `null` (only `owner` sees money).

Mock core `case "funnelReport":` returns `json(200, ctx.actor_role === "owner" ? funnelReport : { ...funnelReport, rows: funnelReport.rows.map((r) => ({ ...r, revenue: null })) })`. If `ctx` is not in scope at the `switch`, pass it in.

- [ ] **Step 4: Panel worker test** `apps/web/test/funnel-redaction.test.ts` (pattern of `spend-api.test.ts`, mock core on, default env):

```ts
import { FunnelReportResponse } from "@anjuna/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, resetState, sessions, setupDatabases } from "./helpers";

let owner: string;
let employee: string;
beforeAll(async () => { await setupDatabases(); });
beforeEach(async () => { resetState(); owner = await sessions.owner(); employee = await sessions.employee(); });

describe("GET /api/funnel money redaction (mock core)", () => {
  const path = "/api/funnel?from=2026-10-01T00:00:00.000Z&to=2026-10-08T00:00:00.000Z";
  it("gives the owner revenue numbers", async () => {
    const body = FunnelReportResponse.parse(await (await call(path, { cookie: owner })).json());
    expect(body.rows.some((r) => typeof r.revenue === "number")).toBe(true);
  });
  it("gives an employee null revenue on every row", async () => {
    const body = FunnelReportResponse.parse(await (await call(path, { cookie: employee })).json());
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.revenue === null)).toBe(true);
  });
});
```

Check the real funnel path in `apps/web/src/server/index.ts` and use it.

- [ ] **Step 5: Client.** `Home.tsx` `FunnelTotals.revenue: number | null`; `sumFunnel` keeps `revenue` `null` when every row has `revenue === null`, otherwise sums the numbers. `revenue` Value becomes `null` when totals revenue is `null`; `usd(null)` already renders "—". `Funnel.tsx:173`: `{owner && <td>{r.revenue === null ? "—" : r.revenue.toFixed(2)}</td>}`.

Add to `apps/web/test/home.ui.test.tsx` (use its existing fetch stub; make the funnel route return the fixture with `revenue: null` rows and an employee `me`):

```ts
it("employee sees no revenue", async () => {
  // render HomeScreen with an employee me and funnel rows whose revenue is null
  // expect no text matching /\$0/ and no cell labelled รายได้
});
```

Write the test body with the file's existing helpers; the assertion is: `screen.queryByText("รายได้")` is null and `document.body.textContent` does not match `/\$0(?!\.)/`.

- [ ] **Step 6: Run** `bun run typecheck`, `bun run --cwd workers/core test`, `bun run --cwd apps/web test`. Expected: PASS.

- [ ] **Step 7: Commit** `git commit -m "fix(core): funnel revenue is owner-only at field level (FUS-375)"`

---

### Task 3: Core `conversionsReport`

**Files:**
- Create: `workers/core/src/admin/conversions-report.ts`
- Modify: `workers/core/src/admin/index.ts` (dispatch after `spendReport`)
- Test: `workers/core/test/conversions-report.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts; `spendPeriodRange`; harness `seedLead`, `seedConversion`, `reset`.
- Produces: `loadConversions(env: Env, query: ConversionsQuery, role: AdminRole): Promise<ConversionsReportResponse>`.

- [ ] **Step 1: Failing test** `workers/core/test/conversions-report.test.ts`. Use `createHarness` from `./helpers.js`, `owner`/`employee` contexts as in `admin.test.ts`, `now = "2026-10-23T12:00:00.000Z"`, query `period=7d&now=${now}`. Seed brands `brand-a`, `brand-b`; leads via `seedLead(id, cid, brand, tracking)`; conversions via `seedConversion(id, overrides)`. Cases:

```ts
it("counts the period window by status and ignores rows before it", ...)
// seed: 2 uploaded (value 85, 40), 1 pending created 2026-10-23T10:00Z, 1 pending created 2026-10-22T00:00Z,
// 1 processing, 2 dead (value 30, last_error "no route for brand=brand-b hostname=b.example" and "no click id"),
// 1 uploaded created 2026-10-10 (outside 7d window).
// expect totals {pending:2, processing:1, uploaded:2, dead:2}; owner value_totals {uploaded:125, dead:60} (dead value 30 each).

it("counts stalled pending rows older than 6 hours at any age", ...)
// stalled = 1 inside window (2026-10-22) + add 1 pending from 2026-10-01 -> stalled 2; the 10:00Z row is not stalled.

it("orders dead, pending, processing, uploaded, newest updated_at first", ...)

it("maps reason codes and click types without leaking click ids", ...)
// gclid row -> click_type "gclid"; row with gclid NULL and msclkid set -> "msclkid";
// row with no click id at all and last_error "no click id" -> click_type null, reason_code "no_click_id".
// JSON.stringify(body) does not contain any seeded gclid/msclkid value.

it("filters rows by status and brand but keeps totals for the whole window", ...)

it("truncates at 200 rows", ...)
// seed 201 uploaded rows inside the window; rows.length 200, truncated true.

it("redacts money for an employee", ...)
// value_totals null; every row value null; counts equal the owner's.

it("rejects an unknown period with 422", ...)
```

Write each case fully with `expect` calls on the parsed `ConversionsReportResponse`. `seedConversion` overrides set `status`, `value`, `last_error`, `attempts`, `created_at`, `updated_at`, `gclid` (`null` to clear), `msclkid`, `next_attempt_at`.

- [ ] **Step 2: Run** `bun run --cwd workers/core test -- conversions-report` — Expected: FAIL (route not found).

- [ ] **Step 3: Implement** `workers/core/src/admin/conversions-report.ts`:

```ts
import {
  CONVERSION_STALLED_HOURS, CONVERSIONS_ROW_LIMIT, ConversionsReportResponse, conversionReasonCode, spendPeriodRange,
  type AdminRole, type ConversionStatus, type ConversionsQuery,
} from "@anjuna/contracts";
import type { Env } from "../env.js";

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;

interface Row {
  lead_id: string; brand: string; status: ConversionStatus; last_error: string | null;
  gclid: string | null; gbraid: string | null; wbraid: string | null; msclkid: string | null;
  attempts: number; value: number; currency: string; occurred_at: string; created_at: string;
  updated_at: string; next_attempt_at: string | null;
}

/** Read-only conversion queue report. Money is null unless the caller is the owner. */
export async function loadConversions(env: Env, query: ConversionsQuery, role: AdminRole): Promise<ConversionsReportResponse> {
  const now = query.now ? new Date(query.now) : new Date();
  const days = spendPeriodRange(query.period, now);
  const from = `${days.from}T00:00:00.000Z`;
  const to = nextDay(days.to);
  const owner = role === "owner";

  const totals = await env.LEADS.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM conversion_uploads
     WHERE created_at >= ?1 AND created_at < ?2 GROUP BY status`,
  ).bind(from, to).all<{ status: ConversionStatus; n: number; v: number }>();
  const stalledBefore = new Date(now.getTime() - CONVERSION_STALLED_HOURS * 3_600_000).toISOString();
  const stalled = await env.LEADS.prepare(
    "SELECT COUNT(*) AS n FROM conversion_uploads WHERE status = 'pending' AND created_at < ?1",
  ).bind(stalledBefore).first<{ n: number }>();

  const rows = await env.LEADS.prepare(
    `SELECT c.lead_id, l.brand, c.status, c.last_error, c.gclid, c.gbraid, c.wbraid, c.msclkid, c.attempts,
            c.value, c.currency, c.occurred_at, c.created_at, c.updated_at, c.next_attempt_at
     FROM conversion_uploads c JOIN leads l ON l.lead_id = c.lead_id
     WHERE c.created_at >= ?1 AND c.created_at < ?2
       AND (?3 = 'all' OR c.status = ?3) AND (?4 IS NULL OR l.brand = ?4)
     ORDER BY CASE c.status WHEN 'dead' THEN 0 WHEN 'pending' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,
              c.updated_at DESC, c.lead_id
     LIMIT ?5`,
  ).bind(from, to, query.status, query.brand ?? null, CONVERSIONS_ROW_LIMIT + 1).all<Row>();

  const count = (s: ConversionStatus) => Number(totals.results.find((r) => r.status === s)?.n ?? 0);
  const sum = (s: ConversionStatus) => cents(Number(totals.results.find((r) => r.status === s)?.v ?? 0));
  return ConversionsReportResponse.parse({
    period: query.period, from, to,
    totals: { pending: count("pending"), processing: count("processing"), uploaded: count("uploaded"), dead: count("dead") },
    value_totals: owner ? { uploaded: sum("uploaded"), dead: sum("dead") } : null,
    stalled: Number(stalled?.n ?? 0),
    rows: rows.results.slice(0, CONVERSIONS_ROW_LIMIT).map((r) => ({
      lead_id: r.lead_id, brand: r.brand, status: r.status,
      reason_code: conversionReasonCode(r.status, r.last_error),
      last_error: r.last_error,
      click_type: r.gclid ? "gclid" : r.gbraid ? "gbraid" : r.wbraid ? "wbraid" : r.msclkid ? "msclkid" : null,
      attempts: Number(r.attempts), value: owner ? cents(Number(r.value)) : null, currency: r.currency,
      occurred_at: r.occurred_at, created_at: r.created_at, updated_at: r.updated_at, next_attempt_at: r.next_attempt_at,
    })),
    truncated: rows.results.length > CONVERSIONS_ROW_LIMIT,
  });
}
```

Check actual column names and nullability in `packages/leads-db/migrations/0001_v1_baseline.sql:91-110` before running; adjust `Row` if a column differs (for example if `next_attempt_at` is `NOT NULL`). Timestamps stored without milliseconds must still pass `z.iso.datetime()`; if a stored value fails, normalize with `new Date(x).toISOString()`.

Dispatch in `index.ts` after `spendReport`:

```ts
  if (route.endpoint === "conversionsReport") {
    const query = parseWith(ConversionsQuery, parseQuery(new URL(request.url)), context);
    if (query instanceof Response) return query;
    return json(await loadConversions(env, query, context.actor_role));
  }
```

- [ ] **Step 4: Run** `bun run --cwd workers/core test` and `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(core): read-only conversions report with reason codes and owner-only value (FUS-375)"`

---

### Task 4: Panel `/api/conversions`, mock core, client API

**Files:**
- Modify: `apps/web/src/server/index.ts` (route next to `/api/spend` at line 313)
- Modify: `apps/web/src/server/mock-core.ts` (validate `ConversionsQuery`, serve fixture, redact money for non-owner)
- Modify: `apps/web/src/client/api.ts` (`conversions`, `leadAggregates`)
- Test: `apps/web/test/conversions-api.test.ts`

**Interfaces:**
- Consumes: Task 1 `ConversionsQuery`, `ConversionsReportResponse`; existing server route `/api/leads/aggregates`.
- Produces: `api.conversions(q: { period: SpendPeriod; status?: ConversionsQuery["status"]; brand?: string }): Promise<ConversionsReportResponse>`; `api.leadAggregates(q: { from: string; to: string }): Promise<LeadAggregatesResponse>` (days `YYYY-MM-DD`).

- [ ] **Step 1: Failing test** `apps/web/test/conversions-api.test.ts`, copying the structure of `spend-api.test.ts`:

```ts
describe("GET /api/conversions", () => {
  it("returns the mock report with value to the owner", ...)        // 200, value_totals not null
  it("returns counts with null money to an employee", ...)          // 200, value_totals null, every row value null
  it("returns 401 without a session", ...)
  it("rejects an unknown period or status with 422", ...)          // period=90d, status=lost
  it("forwards period, status and brand and the employee context to GET /admin/conversions", ...)
  // MOCK_CORE "0", CORE fetch stub returns the fixture with money nulled; check pathname,
  // searchParams period/status/brand, header x-actor-role "employee".
});
```

Write each case fully with the `call`, `makeEnv`, `sessions` helpers.

- [ ] **Step 2: Run** `bun run --cwd apps/web test -- conversions-api` — Expected: FAIL (404).

- [ ] **Step 3: Implement.** Server, same shape as the spend route:

```ts
  if (path === "/api/conversions" && method === "GET") {
    const g = authorize("conversionsReport", ctx.actor_role);
    if (!g.ok) return /* same 403 helper the spend route uses */;
    const q = ConversionsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return /* same 422 helper the spend route uses */;
    return fromCore(await callCore(env, ctx, { endpoint: "conversionsReport", query: url.searchParams }));
  }
```

Copy the exact helper calls from the `/api/spend` block. Mock core: add `ConversionsQuery` validation in the step-3 validation chain, and in the switch return the fixture with `period` from the query; when `ctx.actor_role !== "owner"` set `value_totals: null` and every row `value: null`. Filter fixture rows by `status` and `brand` when given.

Client `api.ts`:

```ts
  conversions: (q: { period: SpendPeriod; status?: string; brand?: string }) =>
    request<ConversionsReportResponse>("GET", `/api/conversions?${new URLSearchParams(
      Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string"),
    )}`),
  leadAggregates: (q: { from: string; to: string }) =>
    request<LeadAggregatesResponse>("GET", `/api/leads/aggregates?${new URLSearchParams(q)}`),
```

Follow the existing `api.funnel` style if it differs.

- [ ] **Step 4: Run** `bun run --cwd apps/web test`, `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(web): /api/conversions route, mock core redaction and client calls (FUS-375)"`

---

### Task 5: Conversions page

**Files:**
- Create: `apps/web/src/client/conversion-labels.ts`, `apps/web/src/client/screens/Conversions.tsx`, `apps/web/src/client/screens/Conversions.css`
- Modify: `apps/web/src/client/router.ts` (`Route` union and `STATIC`: `{ view: "conversions" }` at `/conversions`), `apps/web/src/client/components/AppShell.tsx` (`pageTitle.conversions = "คอนเวอร์ชัน (Conversions)"`), `apps/web/src/client/App.tsx` (nav item after funnel: `{ id: "conversions", label: "คอนเวอร์ชัน", show: true }`, render `{view === "conversions" && <ConversionsScreen me={me} />}`)
- Test: `apps/web/test/conversions.ui.test.tsx`; update `apps/web/test/router.ui.test.tsx` path lists (:12-28, :47) and `apps/web/test/app.ui.test.tsx` nav label list (:65-67) and screen mocks (:8-32)

**Interfaces:**
- Consumes: `api.conversions`, `useBrandLabels`, `BrandLabel`, `DataTable`, `StatusBadge`, `EmptyState`, `Spinner`, `ApiError.thai`, `navigate`.
- Produces: `REASON_TEXT: Record<ConversionReasonCode, { label: string; fix: string }>`; `ConversionsScreen({ me }: { me: Me })`; `readConversionFilters(search: string): { period: SpendPeriod; status: "all" | ConversionStatus; brand: string | null }`; `conversionsPath(f): string`.

- [ ] **Step 1: Failing UI test** `apps/web/test/conversions.ui.test.tsx` (fetch stub pattern of `new-brand-route.ui.test.tsx`, routes `/api/conversions`, `/api/lifecycle/brands`, `/api/brands`):

```ts
it("reads period and status from the URL and asks core for them", ...)
// history.pushState({}, "", "/conversions?period=30d&status=dead"); render <ConversionsScreen me={owner} />;
// the fetch for /api/conversions has period=30d&status=dead; the 30d segment and the dead chip are pressed.
it("falls back to 7d and all for unknown query values", ...)       // ?period=bogus&status=x -> period=7d, no status param
it("writes the status chip into the URL with replace", ...)       // click "ส่งไม่ได้ (dead)" -> location.search has status=dead, history.length unchanged
it("shows the reason label, fix text and full error", ...)         // row with no_route shows "ไม่มี route (No route)" and the fix text
it("shows the value column and value totals to the owner only", ...) // owner: header "มูลค่า (Value)" and "$412.50"; employee: neither
it("shows the empty state and the truncated note", ...)
it("shows ApiError.thai on failure", ...)
```

Write each case fully. Router test: add `["/conversions", { view: "conversions" }]` to both path lists. App test: add "คอนเวอร์ชัน" to the nav label list and a `vi.mock` for `../src/client/screens/Conversions`.

- [ ] **Step 2: Run** `bun run --cwd apps/web test -- conversions router app` — Expected: FAIL.

- [ ] **Step 3: Implement** `conversion-labels.ts` with the 7 rows of the spec "UI text per code" table, copied exactly:

```ts
import type { ConversionReasonCode } from "@anjuna/contracts";

export const REASON_TEXT: Record<ConversionReasonCode, { label: string; fix: string }> = {
  no_click_id: { label: "ไม่มี click id (No click id)", fix: "Lead มาโดยไม่มี gclid/gbraid/wbraid/msclkid. ส่งขึ้น Ads ไม่ได้. ตรวจว่าแคมเปญเปิด auto-tagging." },
  lease_exhausted: { label: "ลองครบแล้ว (Attempts exhausted)", fix: "Drain ดึงไปแล้วไม่ตอบกลับจนครบจำนวนครั้ง. ตรวจ log ของ drain บน VPS." },
  no_route: { label: "ไม่มี route (No route)", fix: "Drain ไม่รู้ว่าแบรนด์นี้ส่งเข้าบัญชี Ads ไหน. เพิ่ม route ใน drain config บน VPS." },
  not_ready: { label: "ยังไม่พร้อม (Not ready)", fix: "Ads ยังไม่รับ click นี้. Drain จะลองใหม่เอง." },
  ms_env_missing: { label: "ตั้งค่า Microsoft ไม่ครบ (Microsoft env missing)", fix: "ตั้ง ACCOUNT และ CONVERSION_NAME ของ Microsoft Ads ใน env ของ drain." },
  upload_failed: { label: "อัปโหลดไม่ผ่าน (Upload failed)", fix: "Ads ตอบ error. Drain จะลองใหม่ตาม backoff." },
  platform_error: { label: "Ads ตอบ error (Platform error)", fix: "ดูข้อความ error เต็มในแถว." },
};
```

`Conversions.tsx` layout per spec section "Conversions page":
- Filters from `readConversionFilters(window.location.search)`; changes call `navigate(conversionsPath(next), { replace: true })` and re-read on the `anjuna:route`/`popstate` event via `useRoute()` plus `window.location.search`.
- Period `.seg` buttons with `aria-pressed`; status chips with `aria-pressed`; brand `<select>` from `useBrandLabels()` entries plus "ทุกแบรนด์".
- Summary `.ledger` with 4 count cells and stalled (`StatusBadge tone="warn" label={`ค้างเกิน 6 ชม. ${n}`}` when n > 0). Owner adds "มูลค่าที่ส่งแล้ว" and "มูลค่าที่ส่งไม่ได้" with `$` formatting to 2 decimals.
- `DataTable` columns: แบรนด์ (`BrandLabel`), สถานะ (`StatusBadge`: uploaded `live` "ส่งแล้ว", pending `blue` "ค้างส่ง", processing `mute` "กำลังส่ง", dead `bad` "ส่งไม่ได้"), เหตุผล (label, fix in `<p className="note">`, `last_error` in `<details><summary>ข้อความเต็ม</summary>`), Click (`click_type ?? "—"`, mono), ครั้งที่ลอง (attempts, right), มูลค่า (Value) (owner only, right), สร้างเมื่อ (local time `toLocaleString("th-TH")`), ลองใหม่ (next_attempt_at or "—").
- States: `Spinner` while loading; `EmptyState title="ยังไม่มีคอนเวอร์ชันในช่วงนี้"`; error `<p role="alert">{error.thai}</p>`; truncated `<p className="note">แสดง 200 แถวล่าสุด</p>`.
- A late response for old filters is dropped (same `current` flag pattern as `Home.tsx:133`).

- [ ] **Step 4: Run** `bun run --cwd apps/web test`, `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(web): read-only Conversions page with reason codes and URL filters (FUS-375)"`

---

### Task 6: Home KPI deltas

**Files:**
- Create: `apps/web/src/client/home-metrics.ts`
- Modify: `apps/web/src/client/screens/Home.tsx`, `apps/web/src/client/screens/Home.css`
- Test: `apps/web/test/home-metrics.test.ts` is a worker-project file; put pure tests in `apps/web/test/home-metrics.ui.test.tsx` so they run in jsdom with the client code. Extend `apps/web/test/home.ui.test.tsx`.

**Interfaces:**
- Produces: `previousRange(range: { from: string; to: string }): { from: string; to: string }` (same length, ends at `range.from`); `delta(current: number | null | undefined, previous: number | null | undefined): { text: string; dir: "up" | "down" | "flat" } | null` (null while loading).

- [ ] **Step 1: Failing tests** `apps/web/test/home-metrics.ui.test.tsx`:

```ts
import { describe, expect, it } from "vitest";
import { delta, previousRange } from "../src/client/home-metrics";

describe("previousRange", () => {
  it("returns the window of equal length that ends where the range starts", () => {
    expect(previousRange({ from: "2026-10-17T00:00:00.000Z", to: "2026-10-24T00:00:00.000Z" }))
      .toEqual({ from: "2026-10-10T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" });
  });
});

describe("delta", () => {
  it("rounds the percent change", () => {
    expect(delta(112, 100)).toEqual({ text: "▲ 12%", dir: "up" });
    expect(delta(95, 100)).toEqual({ text: "▼ 5%", dir: "down" });
    expect(delta(100, 100)).toEqual({ text: "0%", dir: "flat" });
  });
  it("shows a dash when the previous value is 0 or missing", () => {
    expect(delta(5, 0)).toEqual({ text: "–", dir: "flat" });
    expect(delta(5, null)).toEqual({ text: "–", dir: "flat" });
    expect(delta(null, 5)).toEqual({ text: "–", dir: "flat" });
  });
  it("returns null while either value is loading", () => {
    expect(delta(undefined, 5)).toBeNull();
    expect(delta(5, undefined)).toBeNull();
  });
});
```

Home test additions in `home.ui.test.tsx`: the fetch stub answers the second `/api/funnel` call (previous range, recognized by its `from` param) with smaller numbers; expect the leads cell to show "▲ 50%" (for example 30 vs 20) with class `pos`; for the owner, the spend and CPL cells show no delta; revenue down shows `neg`.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.**

```ts
const DAY = 86_400_000;

export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const length = Date.parse(range.to) - Date.parse(range.from);
  return { from: new Date(Date.parse(range.from) - length).toISOString(), to: range.from };
}

export function delta(current: number | null | undefined, previous: number | null | undefined) {
  if (current === undefined || previous === undefined) return null;
  if (current === null || previous === null || previous === 0) return { text: "–", dir: "flat" as const };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: "0%", dir: "flat" as const };
  return pct > 0 ? { text: `▲ ${pct}%`, dir: "up" as const } : { text: `▼ ${Math.abs(pct)}%`, dir: "down" as const };
}
```

(`DAY` is unused if not needed; drop it.) In `Home.tsx`, the period effect also fetches `api.funnel(previousRange(periodRange(period)))` into `previousFunnel` state with the same `current` guard. Each ledger cell gets `<p className={`d ${tone}`}>{d.text}</p>` under `.v` where `tone` is `pos`/`neg`/`` from `dir` and the metric's good direction: leads, sold, visits, revenue are good when up. Owner cells spend, CPL, profit get no delta (spec). Employee "pending" cell gets no delta (alerts have no previous window). `.d` style in `Home.css`: `font-size: var(--text-xs)`, tabular numbers.

- [ ] **Step 4: Run** `bun run --cwd apps/web test`, `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(web): Home KPI deltas against the previous window (FUS-375)"`

---

### Task 7: Home conversions card and issues

**Files:**
- Modify: `apps/web/src/client/screens/Home.tsx` (`fixItems`, new card), `Home.css`
- Test: `apps/web/test/home.ui.test.tsx`

**Interfaces:**
- Consumes: `api.conversions({ period })`, `navigate` from `router.ts`.
- Produces: `fixItems(alerts: AlertsReportResponse, conversions: ConversionsReportResponse | null)` returning the existing item shape plus items with a `path` for conversions.

- [ ] **Step 1: Failing tests** in `home.ui.test.tsx` (stub `/api/conversions` with the fixture; employee variant with money nulled):

```ts
it("shows conversion counts and links the card and the dead count to the Conversions page", ...)
// card "คอนเวอร์ชัน" shows uploaded 5, pending 3, dead 4, stalled 1; owner sees "$412.50";
// click "ส่งไม่ได้ 4" -> location.pathname "/conversions", search "?status=dead"; click card link -> "/conversions".
it("adds dead and stalled conversions to the fix list", ...)
// "ต้องแก้" list contains "คอนเวอร์ชันส่งไม่ได้ 4 รายการ" (bad) and "คอนเวอร์ชันค้างเกิน 6 ชม. 1 รายการ" (warn), bad first.
it("employee sees conversion counts without value", ...)
it("hides the card body behind — when the conversions call fails", ...)
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.** The period effect also calls `api.conversions({ period })` into `conversions` state (`undefined` loading, `null` failed). New `.panel` card "คอนเวอร์ชัน" in `.home-grid2` before "ต้องแก้": four `.cell`s (ส่งแล้ว, ค้างส่ง, ส่งไม่ได้, ค้างเกิน 6 ชม.), owner-only "มูลค่าที่ส่งแล้ว" from `value_totals.uploaded`, the dead cell as a `<a href="/conversions?status=dead">` that calls `navigate` on a plain left click (`isPlainLeftClick`), and a "ดูทั้งหมด" link to `/conversions`. `fixItems` adds: dead > 0 → `{ tone: "bad", text: `คอนเวอร์ชันส่งไม่ได้ ${n} รายการ`, path: "/conversions?status=dead" }`; stalled > 0 → `{ tone: "warn", text: `คอนเวอร์ชันค้างเกิน 6 ชม. ${n} รายการ`, path: "/conversions?status=pending" }`. Keep the bad-before-warn sort and the top-4 cut. Items with `path` navigate there; other items keep their current target.

- [ ] **Step 4: Run** `bun run --cwd apps/web test`, `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(web): Home conversions card and conversion issues (FUS-375)"`

---

### Task 8: Home daily bars (inline SVG)

**Files:**
- Create: `apps/web/src/client/components/DailyBars.tsx`
- Modify: `apps/web/src/client/screens/Home.tsx`, `Home.css`
- Test: `apps/web/test/daily-bars.ui.test.tsx`, `apps/web/test/home.ui.test.tsx`

**Interfaces:**
- Consumes: `api.leadAggregates({ from, to })` (days `YYYY-MM-DD`, inclusive).
- Produces: `DailyBars({ days }: { days: Array<{ day: string; leads: number; sold: number }> })`; `dailySeries(response: LeadAggregatesResponse, from: string, to: string): Array<{ day; leads; sold }>` (one entry per day, zero-filled; `leads` counts every status, `sold` counts `soldLead`).

- [ ] **Step 1: Failing tests** `apps/web/test/daily-bars.ui.test.tsx`:

```ts
it("zero-fills missing days and sums statuses per day", ...)
// rows for 2026-10-20 newLead 3, soldLead 2; 2026-10-22 rejectLead 1; from 2026-10-20 to 2026-10-22
// -> [{day:"2026-10-20",leads:5,sold:2},{day:"2026-10-21",leads:0,sold:0},{day:"2026-10-22",leads:1,sold:0}]
it("renders one leads bar and one sold bar per day with a title", ...)
// container.querySelectorAll("svg rect.bar-leads").length === 3; each <title> reads "2026-10-20: ลีด 5, ขายได้ 2"
it("renders an empty state when every day is zero", ...)          // text "ยังไม่มีลีดในช่วงนี้"
```

Check the outcome status names in `LeadOutcome` (`admin-api.ts`) before writing the sum.

Home test: `today` period asks `/api/leads/aggregates` for the last 7 days (`from` 6 days before today); `30d` asks 30 days.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** `DailyBars`: `<svg role="img" aria-label="ลีดและยอดขายรายวัน" viewBox={`0 0 ${days.length * 24} 120`} preserveAspectRatio="none" width="100%" height="120">`; per day a group at `x = i * 24`: `rect.bar-leads` width 10, `rect.bar-sold` width 10 at `x + 11`, heights scaled to `max(leads)` over 100 px with the baseline at y 110, `<title>` per group. Colors from tokens via CSS (`.bar-leads { fill: var(--accent) }`, `.bar-sold { fill: var(--money) }`). A legend below in HTML. Home adds a `.panel` "ลีดรายวัน" under the flow panel; days come from `spendPeriodRange` with `today` widened to `7d`.

- [ ] **Step 4: Run** `bun run --cwd apps/web test`, `bun run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(web): Home daily lead bars in inline SVG (FUS-375)"`

---

## After the tasks

1. Whole-branch review: relay-reviewer in final mode, then Codex, one fix wave, scoped re-review.
2. Root `bun run typecheck` and `bun run test`.
3. Browser check on local `wrangler dev` with mock core: `/`, `/conversions`, `/conversions?status=dead` reload and Back, owner and employee sessions, 1440 px and 375 px screenshots.
4. PR body maps each spec acceptance line to its test.
