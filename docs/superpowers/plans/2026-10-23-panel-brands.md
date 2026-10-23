# Panel brands (spec C, FUS-377) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the panel a brands list an operator can triage (filter chips, issues-first sort, domain search), one cross-brand deploy timeline, per-brand revision history with the rollback target marked, and Copy Final URL / Open site on the brand card.

**Architecture:** Three new read endpoints over the existing factory D1 (`/api/deploys`, `/api/brands/:id/revisions`, plus one new field on `/api/lifecycle/brands`), two pure client modules holding all the filter, sort and URL logic, one new screen at `/deploys`, and additions inside the existing `BrandLifecycle` screen. No core change, no write path, no new dependency.

**Tech Stack:** Bun workspaces, TypeScript strict, Zod contracts, Cloudflare Workers + D1, React 19, Vitest with `@cloudflare/vitest-pool-workers` (projects `worker`, `ui`, `build`).

**Spec:** `docs/superpowers/specs/2026-10-23-panel-brands-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `wrangler deploy`, no real external call, no secret in a file.
- Rule 2: no server-side post to LeadsGate and no `LEADSGATE_ENDPOINT`. The Final URL is the brand's own landing page.
- Rule 3: no response may vary by user agent, IP, ASN, referrer or gclid. Panel role gating is not cloaking.
- Rule 4: no brand bytes change in this plan. A copied URL holds only that brand's own domain.
- Rule 5: every read goes to the factory D1 (`env.FACTORY`) or to core over the admin contract (`callCore`). No R2, no lead data.
- Lane conflict rule: new endpoints go in their own module with a `// spec brands` comment; shared files (`apps/web/src/server/index.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/router.ts`, `apps/web/src/client/components/AppShell.tsx`) get the smallest possible addition.
- Never edit `spike/`, `packages/leads-db/migrations/`, `packages/contracts/test/v1/drain.mjs` or the drain routes in `workers/core/src/conversions.ts`. No new D1 migration: every table this plan reads already exists.
- UI copy is Thai first with English in parentheses, matching the surrounding code.
- Timestamps are the raw D1 strings; `Timestamp` in contracts is `z.iso.datetime()`.
- Role gates come from `authorizePanel` in `apps/web/src/server/panel-roles.ts`. This plan adds no new `PANEL_ROLE_TABLE` entry: `installBrand` (employee) already governs reading install rows.
- Done per task: `bun run typecheck` at the repo root green plus the test suite of every package touched (`bun run --cwd packages/contracts test`, `bun run --cwd apps/web test`).

## Review Focus

1. **Mixed timestamp offsets in the deploy merge.** Rows written as `2026-10-01T00:00:00Z` and `2026-10-01T07:00:00+07:00` are the same instant but sort differently as strings. Expected: the newest instant is first regardless of how its offset is written. Test in Task 2.
2. **`navigator.clipboard` absent or rejecting.** jsdom has no clipboard, and a non-HTTPS origin has none either. Expected: Copy Final URL never throws and the operator still gets the URL. Test in Task 7.
3. **A core-only (unmanaged) brand.** It has no `brands` row, so no revisions and no `latest_install`. Expected: the revisions route answers 404, the list row renders, and Copy Final URL still works off the core hostname. Tests in Tasks 3, 4 and 7.
4. **A deploy event for a brand the factory does not know.** Core audit can name a brand absent from `brands`. Expected: the event stays in the timeline and its label falls back to the brand id. Tests in Tasks 2 and 9.
5. **A filter or search that hides the selected brand.** Expected: the side panel keeps showing the brand named in the URL; only the table rows are filtered. Test in Task 6.

---

### Task 1: Contracts for the deploy timeline, revisions and `latest_install`

**Files:**
- Modify: `packages/contracts/src/lifecycle.ts` (one `// spec brands` block appended after `LifecycleBrandSummary`; `InstallStatus` at line 49 gains `export`; `LatestInstall` is declared immediately **before** `LifecycleBrandSummary`, which gains one field)
- Create: `packages/contracts/fixtures/admin/deploys.response.json`
- Modify: `packages/contracts/test/admin-api.test.ts` (one entry in `cases` and its import — see Step 4)
- Test: `packages/contracts/test/deploys.test.ts`

**Interfaces:**
- Consumes: existing `Id`, `Timestamp`, `ActorId`, `BrandId`, `InstallOperation`, `InstallStatus`, `AuditActorRole` (from `./admin-api.js`), `LifecycleBrandSummary`.
- Produces:
  - `export const InstallStatus` / `export type InstallStatus` — `z.enum(["queued","running","ready","failed","rolled_back"])`.
  - `export const DeploySource = z.enum(["install","audit"])`.
  - `export const DeployStatus = z.enum(["queued","running","ready","failed","rolled_back","done"])`.
  - `export const DeployEvent` — strict object: `source: DeploySource`, `event_id: Id`, `brand_id: BrandId`, `operation: InstallOperation.nullable()`, `action: z.string().min(1).max(64).nullable()`, `status: DeployStatus`, `from_revision_id: Id.nullable()`, `to_revision_id: Id.nullable()`, `is_canary: z.boolean()`, `started_by: ActorId`, `started_role: AuditActorRole`, `started_at: Timestamp`, `finished_at: Timestamp.nullable()`, `error: z.string().max(500).nullable()`. Refined: an `install` row has a non-null `operation` and a null `action`; an `audit` row has a null `operation`, a non-null `action` and `status: "done"`.
  - `export const DeployHistoryQuery` — strict object, every key optional: `brand: BrandId`, `source: DeploySource`, `status: DeployStatus`, `operation: InstallOperation`, `limit: z.coerce.number().int().min(1).max(200)`.
  - `export const DeployUnavailableSource = z.enum(["core_audit"])`.
  - `export const DeployHistoryResponse` — strict object: `events: z.array(DeployEvent)`, `has_more: z.boolean()`, `unavailable: z.array(DeployUnavailableSource)`.
  - `export const BrandRevision` — strict object: `revision_id: Id`, `revision: z.number().int().positive()`, `template_version_id: Id`, `form_artifact_id: Id`, `bundle_form_version: FormVersion.nullable()`, `worker_version_id: z.string().min(1).max(128).nullable()`, `created_by: ActorId`, `created_at: Timestamp`, `is_current: z.boolean()`.
  - `export const BrandRevisionsResponse` — strict object: `brand_id: BrandId`, `current_revision_id: Id.nullable()`, `rollback_target_revision_id: Id.nullable()`, `revisions: z.array(BrandRevision)`.
  - `export const LatestInstall` — strict object: `install_id: Id`, `operation: InstallOperation`, `status: InstallStatus`, `started_at: Timestamp`, `finished_at: Timestamp.nullable()`, `started_by: ActorId`.
  - `LifecycleBrandSummary` gains `latest_install: LatestInstall.nullable().optional()`.

- [ ] **Step 1: Write the failing test** in `packages/contracts/test/deploys.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { BrandRevisionsResponse, DeployEvent, DeployHistoryQuery, DeployHistoryResponse, LifecycleBrandSummary } from "../src/index.js";
import deploysFixture from "../fixtures/admin/deploys.response.json";

const install = {
  source: "install", event_id: "inst-1", brand_id: "brand-a", operation: "install", action: null,
  status: "ready", from_revision_id: null, to_revision_id: "brand-a_rev_1", is_canary: false,
  started_by: "owner-1", started_role: "owner", started_at: "2026-10-20T01:00:00.000Z",
  finished_at: "2026-10-20T01:04:00.000Z", error: null,
};
const auditEvent = { ...install, source: "audit", event_id: "audit-7", operation: null, action: "brand.profile.update", status: "done", finished_at: null };

describe("DeployEvent", () => {
  it("accepts an install row and an audit row", () => {
    expect(DeployEvent.parse(install).operation).toBe("install");
    expect(DeployEvent.parse(auditEvent).action).toBe("brand.profile.update");
  });
  it("rejects an unknown key", () => {
    expect(DeployEvent.safeParse({ ...install, install_id: "inst-1" }).success).toBe(false);
  });
  it("rejects an audit row that carries an operation", () => {
    expect(DeployEvent.safeParse({ ...auditEvent, operation: "install" }).success).toBe(false);
  });
  it("rejects an install row with no operation and an audit row that is not done", () => {
    expect(DeployEvent.safeParse({ ...install, operation: null }).success).toBe(false);
    expect(DeployEvent.safeParse({ ...auditEvent, status: "ready" }).success).toBe(false);
  });
});

describe("DeployHistoryQuery", () => {
  it("coerces limit and bounds it to 1..200", () => {
    expect(DeployHistoryQuery.parse({ limit: "50" }).limit).toBe(50);
    expect(DeployHistoryQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(DeployHistoryQuery.safeParse({ limit: "201" }).success).toBe(false);
  });
  it("accepts an empty query and rejects an unknown key", () => {
    expect(DeployHistoryQuery.parse({})).toEqual({});
    expect(DeployHistoryQuery.safeParse({ brand_id: "brand-a" }).success).toBe(false);
  });
});

describe("the deploys fixture", () => {
  it("parses as a DeployHistoryResponse with four events", () => {
    const parsed = DeployHistoryResponse.parse(deploysFixture);
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events.map((e) => e.status)).toContain("failed");
    expect(parsed.unavailable).toEqual([]);
  });
});

describe("BrandRevisionsResponse", () => {
  it("accepts a brand with one current revision and a rollback target", () => {
    const parsed = BrandRevisionsResponse.parse({
      brand_id: "brand-a", current_revision_id: "brand-a_rev_2", rollback_target_revision_id: "brand-a_rev_1",
      revisions: [{
        revision_id: "brand-a_rev_2", revision: 2, template_version_id: "tv-1", form_artifact_id: "fa-1",
        bundle_form_version: "form@abcdef1", worker_version_id: null, created_by: "owner-1",
        created_at: "2026-10-20T01:00:00.000Z", is_current: true,
      }],
    });
    expect(parsed.revisions[0]!.is_current).toBe(true);
  });
  it("rejects revision 0", () => {
    expect(BrandRevisionsResponse.safeParse({ brand_id: "brand-a", current_revision_id: null, rollback_target_revision_id: null, revisions: [{ revision_id: "r", revision: 0, template_version_id: "tv-1", form_artifact_id: "fa-1", bundle_form_version: null, worker_version_id: null, created_by: "o", created_at: "2026-10-20T01:00:00.000Z", is_current: false }] }).success).toBe(false);
  });
});

describe("LifecycleBrandSummary.latest_install", () => {
  const base = { brand_id: "brand-a", account: "acc", hostnames: ["a.test", "www.a.test"], status: "live", current_revision_id: "r1", runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01" };
  it("stays valid without the field, with null, and with a row", () => {
    expect(LifecycleBrandSummary.parse(base).latest_install).toBeUndefined();
    expect(LifecycleBrandSummary.parse({ ...base, latest_install: null }).latest_install).toBeNull();
    expect(LifecycleBrandSummary.parse({ ...base, latest_install: { install_id: "inst-1", operation: "redeploy", status: "failed", started_at: "2026-10-20T01:00:00.000Z", finished_at: null, started_by: "owner-1" } }).latest_install?.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd packages/contracts test -- deploys`
Expected: FAIL, `DeployEvent` is not exported from `../src/index.js`.

- [ ] **Step 3: Write the fixture** `packages/contracts/fixtures/admin/deploys.response.json`

Four events newest first, `has_more: false`, `unavailable: []`: a `ready` install of `brand-a`, a `failed` redeploy of `brand-a` with a non-null `error`, a `ready` rollback of `brand-b` with both revision ids set, and an `audit` event with `action: "brand.profile.update"` and `status: "done"`.

- [ ] **Step 4: Add the `// spec brands` block to `packages/contracts/src/lifecycle.ts`**

Append after `LifecycleBrandSummary`, in the Interfaces order above, with one exception: declare `LatestInstall` immediately **before** `LifecycleBrandSummary`. A plain forward reference to a `const` declared later hits the temporal dead zone at module load, and `z.lazy` to work around it puts a lazy schema on the most-parsed object in the file for no gain. Add `export` to the existing `const InstallStatus` and add the one `latest_install: LatestInstall.nullable().optional()` field to `LifecycleBrandSummary`. `packages/contracts/src/index.ts` already re-exports `./lifecycle.js`, so no export line is needed.

- [ ] **Step 4b: Register the fixture in the coverage guard**

`packages/contracts/test/admin-api.test.ts:88` asserts that every file in `fixtures/admin/` appears in its `cases` list, so a new fixture there fails that test until it is registered. Import `DeployHistoryResponse` and append one entry to `cases`:

```ts
["deploys.response.json", DeployHistoryResponse],
```

This is the guard working as designed — it exists so no fixture goes unvalidated — and registering the fixture is what satisfies it. The alternative, moving the fixture out of `fixtures/admin/`, would break the path the spec pins and leave the new fixture with no coverage check at all. Append the entry at the end of the list, next to the `error.*` rows, so a lane adding its own fixture conflicts on one line at most.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/contracts test` and `bun run typecheck`
Expected: PASS, both green. Every existing contracts test still passes, because `latest_install` is optional.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/lifecycle.ts packages/contracts/fixtures/admin/deploys.response.json packages/contracts/test/admin-api.test.ts packages/contracts/test/deploys.test.ts
git commit -m "feat(contracts): deploy timeline, brand revisions and latest_install schemas (FUS-377)"
```

---

### Task 2: `GET /api/deploys`

**Files:**
- Create: `apps/web/src/server/deploys.ts`
- Modify: `apps/web/src/server/index.ts` (one `// spec brands` block, two lines, next to the other `handle*Route` calls)
- Test: `apps/web/test/deploys-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `DeployEvent`, `DeployHistoryQuery`, `DeployHistoryResponse`; `installOperation(kind, brandId, toRevisionId)` exported from `apps/web/src/server/lifecycle.ts:309`; `authorizePanel`; `callCore`; `decodePathSegment`.
- Produces: `export async function handleDeployRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined>` — the same shape as `handleLifecycleRoute`, returning `undefined` when the path is not its own. Task 3 adds its route to this same function.
- Produces: `export const DEPLOY_AUDIT_ACTIONS: readonly string[]` — the factory list, `["brand.create", "brand.duplicate", "brand.draft_update", "brand.profile", "brand.asset", "checklist.attest"]`, matched as the whole action or as a prefix followed by `.`.
- Produces: `export const CORE_DEPLOY_AUDIT_ACTIONS: readonly string[]` — the core list, `["brand.update", "brand.pause", "brand.resume"]`. Core writes only those three brand actions (`workers/core/src/admin/index.ts:272`), so filtering core by the factory list drops every core row and leaves the core source contributing nothing. Spec D4 amendment.

- [ ] **Step 1: Write the failing test** in `apps/web/test/deploys-api.test.ts`

Seed in `beforeEach`: templates `tpl-1` / `tv-1`, form artifact `fa-1` (as `apps/web/test/lifecycle-api.test.ts` does), brands `brand-a` and `brand-b`, revisions `brand-a_rev_1` and `brand-b_rev_1`, four `installs` rows and three `audit_log` rows. Cases:

```ts
it("refuses a request with no session", async () => { expect((await call("/api/deploys")).status).toBe(401); });

it("merges install rows and audit rows newest first", async () => {
  const body = DeployHistoryResponse.parse(await (await call("/api/deploys", { cookie: owner })).json());
  expect(body.events.map((e) => e.event_id)).toEqual([/* newest first, audit ids prefixed `audit-` */]);
  expect(body.unavailable).toEqual([]);
});

it("sorts by instant, not by timestamp text", async () => {
  // brand-b's install is stored as "2026-10-21T07:00:00+07:00" and brand-a's as "2026-10-21T01:00:00.000Z":
  // the same wall clock hour, brand-a one hour earlier as an instant.
  const body = DeployHistoryResponse.parse(await (await call("/api/deploys", { cookie: owner })).json());
  expect(body.events[0]!.brand_id).toBe("brand-b");
});

it("filters by brand, status and source", async () => { /* three calls, each asserting the returned event ids */ });

it("excludes install.start and upgrade audit rows, which the install rows already carry", async () => { /* no event has action "install.start" */ });

it("keeps an event for a brand with no factory row", async () => { /* a core audit row names brand-ghost; its event survives */ });

it("honours limit and reports has_more", async () => {
  const body = DeployHistoryResponse.parse(await (await call("/api/deploys?limit=2", { cookie: owner })).json());
  expect(body.events).toHaveLength(2);
  expect(body.has_more).toBe(true);
});

it("answers 422 for a bad query", async () => { expect((await call("/api/deploys?limit=0", { cookie: owner })).status).toBe(422); });

it("returns factory rows with unavailable core_audit when core fails", async () => {
  const env = makeEnv({ MOCK_CORE: undefined, CORE: undefined });
  const body = DeployHistoryResponse.parse(await (await call("/api/deploys", { cookie: owner, env })).json());
  expect(body.unavailable).toEqual(["core_audit"]);
  expect(body.events.length).toBeGreaterThan(0);
});

it("shows an employee every install row but only their own audit rows", async () => { /* employee sees both brands' installs; the owner's audit row is absent */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- deploys-api`
Expected: FAIL with 404 `not_found` on `/api/deploys`.

- [ ] **Step 3: Implement `handleDeployRoute` in `apps/web/src/server/deploys.ts`**

- Gate with `authorizePanel("installBrand", ctx.actor_role)`; 403 on failure, in the same shape `lifecycle.ts` uses.
- Parse `DeployHistoryQuery.safeParse(Object.fromEntries(url.searchParams))`; 422 with `{ error: "invalid", issues }` on failure.
- Installs query: `SELECT install_id, brand_id, kind, status, from_revision_id, to_revision_id, is_canary, started_by, started_role, started_at, finished_at, error FROM installs` plus `brand_id = ?` and `status = ?` when given, `ORDER BY started_at DESC, install_id DESC LIMIT ?` with `limit + 1`. `operation` from `installOperation`. Skipped entirely when `source === "audit"`.
- Factory audit query: `entity_type = 'brand'`, the action in `DEPLOY_AUDIT_ACTIONS`, `entity_id = ?` when `brand` is given, `actor_id = ?` for an employee, `ORDER BY julianday(created_at) DESC, id DESC LIMIT ?` with `limit + 1`. `event_id` is `audit-<id>`. Skipped when `source === "install"` or when `status` is given and is not `done`.
- Order every query by `julianday(<timestamp column>)`, not by the raw column. The `LIMIT limit + 1` cut must keep the newest instants, and text order can differ from instant order in both directions (spec D4b).
- Core audit: `callCore(env, ctx, { endpoint: "listAudit", query })` with `target_type=brand`, `limit`, `target_id` when `brand` is given and `actor_id` for an employee. A non-200 status, or a body `AuditListResponse` cannot parse, appends `"core_audit"` to `unavailable` and contributes no events. Entries whose action is outside `CORE_DEPLOY_AUDIT_ACTIONS` are dropped — the core list, not the factory one. Skipped under the same conditions as the factory audit query.
- Merge, sort by `Date.parse(started_at)` descending with `event_id` descending as the tie-break (Review Focus 1: comparing instants, not strings), slice to `limit`, and set `has_more` when the merged length before slicing exceeds `limit`.
- Parse the response with `DeployHistoryResponse` before returning it, so a shape error is a 500 here and never reaches the browser.

- [ ] **Step 4: Wire it into `apps/web/src/server/index.ts`**

Add, directly after the `handleLifecycleRoute` call:

```ts
// spec brands (FUS-377): cross-brand deploy timeline and per-brand revision history.
const deploys = await handleDeployRoute(request, env, url, path, ctx);
if (deploys) return deploys;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- deploys-api` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/deploys.ts apps/web/src/server/index.ts apps/web/test/deploys-api.test.ts
git commit -m "feat(web): GET /api/deploys merges install, factory audit and core audit rows (FUS-377)"
```

---

### Task 3: `GET /api/brands/:id/revisions` and one rollback-target helper

**Files:**
- Modify: `apps/web/src/server/deploys.ts` (second route in `handleDeployRoute`)
- Modify: `apps/web/src/server/lifecycle.ts` (extract the rollback-target query out of `rollback()` at line 279 into an exported helper and call it there)
- Test: `apps/web/test/revisions-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `BrandRevisionsResponse`; Task 2's `handleDeployRoute`.
- Produces: `export async function rollbackTargetRevisionId(db: D1Database, brandId: string, currentRevisionId: string | null): Promise<string | null>` in `apps/web/src/server/lifecycle.ts`, holding the query `rollback()` uses today: `SELECT to_revision_id FROM installs WHERE brand_id = ?1 AND kind IN ('install','upgrade','rollback') AND status = 'ready' AND to_revision_id IS NOT ?2 ORDER BY finished_at DESC LIMIT 1`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/revisions-api.test.ts`

```ts
it("refuses a request with no session", async () => { expect((await call("/api/brands/brand-a/revisions")).status).toBe(401); });

it("lists revisions newest first and marks the current one", async () => {
  const body = BrandRevisionsResponse.parse(await (await call("/api/brands/brand-a/revisions", { cookie: employee })).json());
  expect(body.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
  expect(body.revisions.filter((r) => r.is_current).map((r) => r.revision_id)).toEqual([body.current_revision_id]);
  expect(body.revisions[0]!.bundle_form_version).toBe("form@abcdef1");
});

it("names the revision a rollback would deploy", async () => {
  const body = BrandRevisionsResponse.parse(await (await call("/api/brands/brand-a/revisions", { cookie: employee })).json());
  expect(body.rollback_target_revision_id).toBe("brand-a_rev_2");
});

it("agrees with POST /api/brands/:id/rollback", async () => {
  const target = BrandRevisionsResponse.parse(await (await call("/api/brands/brand-a/revisions", { cookie: owner })).json()).rollback_target_revision_id;
  const started = await call("/api/brands/brand-a/rollback", { cookie: owner, method: "POST", body: {} });
  expect(started.status).toBe(202);
  const row = await env.FACTORY.prepare("SELECT to_revision_id FROM installs WHERE install_id = ?1").bind((await started.json() as { install_id: string }).install_id).first<{ to_revision_id: string | null }>();
  expect(row?.to_revision_id).toBe(target);
});

it("returns a null target for a brand with only one revision", async () => { /* brand-b */ });

it("answers 404 for an unknown brand and for a core-only brand with no factory row", async () => {
  expect((await call("/api/brands/brand-ghost/revisions", { cookie: employee })).status).toBe(404);
});

it("answers 400 for an undecodable path segment", async () => { expect((await call("/api/brands/%/revisions", { cookie: employee })).status).toBe(400); });
```

Adapt the asserted rollback status to whatever `POST /api/brands/:id/rollback` returns today; the point of the case is that both routes name the same revision.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- revisions-api`
Expected: FAIL with 404 `not_found` resource `route`.

- [ ] **Step 3: Extract `rollbackTargetRevisionId` in `apps/web/src/server/lifecycle.ts`**

Move the existing query out of `rollback()` into the exported helper and have `rollback()` call it. Behavior must not change: the same SQL, the same binds, the same null result.

- [ ] **Step 4: Implement the route in `apps/web/src/server/deploys.ts`**

Match `^/api/brands/([^/]+)/revisions$` on `GET`. Gate with `authorizePanel("installBrand")`. 400 when `decodePathSegment` returns null. 404 when `SELECT brand_id, current_revision_id FROM brands WHERE brand_id = ?1` finds nothing (Review Focus 3). Then `SELECT r.revision_id, r.revision, r.template_version_id, r.form_artifact_id, fa.bundle_form_version, r.worker_version_id, r.created_by, r.created_at FROM brand_revisions r LEFT JOIN form_artifacts fa ON fa.form_artifact_id = r.form_artifact_id WHERE r.brand_id = ?1 ORDER BY r.revision DESC LIMIT 100`, set `is_current` by comparing to `current_revision_id`, and read the target through `rollbackTargetRevisionId`. Parse with `BrandRevisionsResponse` before returning.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- revisions-api` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS. `apps/web/test/lifecycle-api.test.ts` still passes, which is the proof the extraction changed nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/deploys.ts apps/web/src/server/lifecycle.ts apps/web/test/revisions-api.test.ts
git commit -m "feat(web): GET /api/brands/:id/revisions with the shared rollback target (FUS-377)"
```

---

### Task 4: `latest_install` on the brands list

**Files:**
- Modify: `apps/web/src/server/lifecycle.ts` (`lifecycleBrandRows` at line 515 and `withRuntimeState` at line 501)
- Test: `apps/web/test/latest-install-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `LatestInstall` and the `LifecycleBrandSummary.latest_install` field; the existing `installOperation`.
- Produces: `latest_install` set on every row of `GET /api/lifecycle/brands` and of `GET /api/lifecycle/brands/:id`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/latest-install-api.test.ts`

```ts
it("carries the newest install of each brand", async () => {
  const { brands } = await (await call("/api/lifecycle/brands", { cookie: owner })).json() as { brands: LifecycleBrandSummary[] };
  const a = brands.find((b) => b.brand_id === "brand-a")!;
  expect(a.latest_install).toMatchObject({ install_id: "inst-a2", operation: "redeploy", status: "failed", started_by: "owner-1" });
});

it("breaks a started_at tie by install_id, descending", async () => {
  // inst-a3 and inst-a4 share started_at; inst-a4 wins.
  const { brands } = await (await call("/api/lifecycle/brands", { cookie: owner })).json() as { brands: LifecycleBrandSummary[] };
  expect(brands.find((b) => b.brand_id === "brand-a")!.latest_install!.install_id).toBe("inst-a4");
});

it("is null for a brand with no install row", async () => { /* brand-b */ });

it("is null for a core-only brand", async () => { /* a brand present only in the core runtime list, status unmanaged */ });

it("is set on the single-brand read too", async () => {
  const { brand } = await (await call("/api/lifecycle/brands/brand-a", { cookie: owner })).json() as { brand: LifecycleBrandSummary };
  expect(brand.latest_install?.install_id).toBe("inst-a4");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- latest-install-api`
Expected: FAIL, `latest_install` is `undefined`.

- [ ] **Step 3: Add the query and the field in `apps/web/src/server/lifecycle.ts`**

In `lifecycleBrandRows`, read the newest install per brand once:

```sql
SELECT install_id, brand_id, kind, status, to_revision_id, started_by, started_at, finished_at FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY brand_id ORDER BY started_at DESC, install_id DESC) AS rn FROM installs
) WHERE rn = 1
```

Build a `Map<string, LatestInstall>` from it, with `operation` from `installOperation(kind, brand_id, to_revision_id)`, and pass it to `withRuntimeState`, which sets `latest_install` to the map entry or `null`. The core-only rows appended after the merge loop get `latest_install: null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- latest-install-api` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS, all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/lifecycle.ts apps/web/test/latest-install-api.test.ts
git commit -m "feat(web): latest_install on the lifecycle brand rows (FUS-377)"
```

---

### Task 5: Client foundation — brand health, final URL, API methods

**Files:**
- Create: `apps/web/src/client/brand-health.ts`
- Create: `apps/web/src/client/final-url.ts`
- Modify: `apps/web/src/client/api.ts` (three methods appended)
- Test: `apps/web/test/brand-health.test.ts`

**Interfaces:**
- Consumes: Task 1's types; the existing `sortWorstProfitFirst` from `apps/web/src/client/screens/BrandStatsRow.tsx`.
- Produces, in `brand-health.ts`:
  - `export type BrandIssue = "install_failed" | "sync_error" | "install_running" | "no_domain" | "paused"` — also the severity order, worst first.
  - `export type BrandChip = "all" | "live" | "paused" | "failed" | "no_domain"`.
  - `export const BRAND_CHIPS: ReadonlyArray<{ id: BrandChip; label: string }>` — labels `ทั้งหมด (All)`, `ใช้งาน (Live)`, `หยุดชั่วคราว (Paused)`, `ติดตั้งล้มเหลว (Failed install)`, `ยังไม่มีโดเมนใช้งาน (No live domain)`.
  - `export type BrandSortMode = "issues" | "activity" | "az" | "profit"`.
  - `export const BRAND_SORTS: ReadonlyArray<{ id: BrandSortMode; label: string; ownerOnly: boolean }>` — labels `ปัญหาก่อน (Issues first)`, `กิจกรรมล่าสุด (Latest activity)`, `ชื่อโดเมน A-Z (Domain A-Z)`, `กำไรน้อยสุด (Worst profit)`; only `profit` is owner-only.
  - `export interface BrandHealth { issues: BrandIssue[]; severity: number; activityAt: string | null }`
  - `export function brandHealth(brand: LifecycleBrandSummary, runtime: Pick<BrandSummary, "status"> | undefined): BrandHealth`
  - `export function matchesBrandChip(health: BrandHealth, brand: LifecycleBrandSummary, chip: BrandChip): boolean`
  - `export function matchesBrandSearch(brand: LifecycleBrandSummary, query: string): boolean`
  - `export function sortBrands<T>(rows: T[], mode: BrandSortMode, read: (row: T) => { health: BrandHealth; domain: string; profit: number | null }): T[]`
- Produces, in `final-url.ts`: `export function finalUrl(hostnames: readonly string[]): string | null` and `export function siteUrl(hostnames: readonly string[]): string | null`.
- Produces, in `api.ts`: `api.deploys(query?: DeployHistoryQuery)` returning `DeployHistoryResponse`, `api.brandRevisions(brandId: string)` returning `BrandRevisionsResponse`, both parsed with the contract schema in the style of `api.latestUpgrade`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/brand-health.test.ts`

```ts
const brand = (over: Partial<LifecycleBrandSummary> = {}) => LifecycleBrandSummary.parse({
  brand_id: "brand-a", account: "acc", hostnames: ["a.test", "www.a.test"], status: "live",
  current_revision_id: "r1", runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...over,
});

describe("brandHealth", () => {
  it("has no issue for a live, synced, installed brand", () => { expect(brandHealth(brand(), { status: "live" }).issues).toEqual([]); });
  it("flags a failed factory status and a failed latest install", () => {
    expect(brandHealth(brand({ status: "failed" }), undefined).issues).toContain("install_failed");
    expect(brandHealth(brand({ latest_install: { install_id: "i", operation: "redeploy", status: "rolled_back", started_at: "2026-10-20T00:00:00.000Z", finished_at: null, started_by: "o" } }), { status: "live" }).issues).toContain("install_failed");
  });
  it("flags sync_error only while the factory status is live", () => {
    expect(brandHealth(brand({ runtime_sync_status: "sync_error" }), { status: "live" }).issues).toContain("sync_error");
    expect(brandHealth(brand({ status: "draft", current_revision_id: null, runtime_sync_status: "sync_error" }), undefined).issues).not.toContain("sync_error");
  });
  it("flags install_running from the factory status and from a queued install", () => { /* status installing; latest_install.status queued */ });
  it("flags no_domain when the brand has never installed", () => {
    expect(brandHealth(brand({ status: "draft", current_revision_id: null, runtime_sync_status: "queued" }), undefined).issues).toContain("no_domain");
  });
  it("flags paused from the core runtime row and from the factory status", () => {
    expect(brandHealth(brand(), { status: "paused" }).issues).toContain("paused");
    expect(brandHealth(brand({ status: "paused" }), undefined).issues).toContain("paused");
  });
  it("reads severity as the worst issue and activityAt from the latest install", () => {
    const health = brandHealth(brand({ status: "failed", latest_install: { install_id: "i", operation: "install", status: "failed", started_at: "2026-10-20T00:00:00.000Z", finished_at: null, started_by: "o" } }), { status: "paused" });
    expect(health.issues[0]).toBe("install_failed");
    expect(health.severity).toBe(0);
    expect(health.activityAt).toBe("2026-10-20T00:00:00.000Z");
  });
  it("reads severity 99 and a null activityAt for a healthy brand with no install row", () => { /* severity 99, activityAt null */ });
});

describe("matchesBrandChip", () => {
  it("counts a healthy live brand under live and not under failed", () => { /* all four chips over one healthy brand */ });
  it("puts a paused brand under paused and not under live", () => { /* a live factory row whose runtime is paused */ });
});

describe("matchesBrandSearch", () => {
  it("matches a hostname, the name and the id, case-insensitively", () => {
    expect(matchesBrandSearch(brand({ name: "Credit Genie" }), "A.TEST")).toBe(true);
    expect(matchesBrandSearch(brand({ name: "Credit Genie" }), "genie")).toBe(true);
    expect(matchesBrandSearch(brand(), "BRAND-a")).toBe(true);
    expect(matchesBrandSearch(brand(), "floatme")).toBe(false);
  });
  it("matches everything for a blank or whitespace query", () => { expect(matchesBrandSearch(brand(), "   ")).toBe(true); });
});

describe("sortBrands", () => {
  it("issues puts the worst severity first, then the newest activity, then the domain", () => { /* four rows, asserted order */ });
  it("activity puts a null activityAt last", () => { /* three rows, the null one last */ });
  it("az sorts by the apex hostname", () => { /* three rows */ });
  it("profit matches sortWorstProfitFirst, nulls last", () => { /* three rows, one null profit */ });
  it("does not mutate its input", () => { /* the input array order is unchanged */ });
});

describe("finalUrl and siteUrl", () => {
  it("builds the keyword URL from the apex hostname", () => {
    expect(finalUrl(["a.test", "www.a.test"])).toBe("https://a.test/?keyword={keyword}");
    expect(siteUrl(["a.test", "www.a.test"])).toBe("https://a.test");
  });
  it("answers null with no hostname", () => { expect(finalUrl([])).toBeNull(); expect(siteUrl([])).toBeNull(); });
  it("uses the first hostname even when core returns a www host first", () => {
    // Review Focus 4: a core-only brand's hostnames are whatever core returned.
    expect(finalUrl(["www.b.test"])).toBe("https://www.b.test/?keyword={keyword}");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- brand-health`
Expected: FAIL, `../src/client/brand-health` cannot be resolved.

- [ ] **Step 3: Implement the two modules and the three API methods**

`brand-health.ts` and `final-url.ts` hold no React and no `fetch`, so the test runs them directly in the `worker` project. `finalUrl` must keep the literal `{keyword}` unescaped: build the string, do not pass it through `URLSearchParams`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- brand-health` then `bun run typecheck`
Expected: PASS, green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/brand-health.ts apps/web/src/client/final-url.ts apps/web/src/client/api.ts apps/web/test/brand-health.test.ts
git commit -m "feat(web): brand health, chips, sorts and the Final URL helper (FUS-377)"
```

---

### Task 6: Brands list filter chips, sort and domain search

**Files:**
- Create: `apps/web/src/client/screens/BrandFilters.tsx`
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (the `tableRows` / `sortedRows` block at lines 421-429 and the `brands-head` JSX)
- Modify: `apps/web/src/client/screens/Brands.css`
- Test: `apps/web/test/brands-filter.ui.test.tsx`

**Interfaces:**
- Consumes: Task 5's `BRAND_CHIPS`, `BRAND_SORTS`, `brandHealth`, `matchesBrandChip`, `matchesBrandSearch`, `sortBrands`; the existing `EmptyState`.
- Produces: `export function BrandFilters({ chip, onChip, counts, sort, onSort, owner, search, onSearch }: { chip: BrandChip; onChip: (chip: BrandChip) => void; counts: Record<BrandChip, number>; sort: BrandSortMode; onSort: (mode: BrandSortMode) => void; owner: boolean; search: string; onSearch: (value: string) => void })`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/brands-filter.ui.test.tsx`

Reuse the `routes` / `vi.stubGlobal("fetch", ...)` harness from `apps/web/test/brands-page.ui.test.tsx`. Give the four lifecycle rows distinct health: `brand-cg` live and healthy, `brand-fm` with `latest_install.status: "failed"`, `brand-al` with a paused core runtime row, `brand-wd` with `status: "draft"` and `current_revision_id: null`.

```ts
it("sorts issues-first by default for both roles", async () => { /* FloatMe, Alpha Loans ... asserted row order for owner and for employee */ });
it("offers Worst profit to the owner only", async () => { /* the option exists for owner, is absent for employee */ });
it("keeps the worst-profit order when the owner picks it", async () => { /* the FUS-365 order */ });
it("sorts by latest activity and puts a brand with no install last", async () => { /* asserted order */ });
it("sorts by domain A-Z", async () => { /* asserted order */ });
it("filters to one chip and shows each chip's count", async () => { /* Failed install -> only FloatMe; the chip reads 1 */ });
it("filters by domain search, case-insensitively", async () => { /* "FLOAT" -> only FloatMe */ });
it("shows an empty state when a filter hides every brand and clears it", async () => { /* search "zzz", then the clear button restores four rows */ });
it("keeps the routed brand in the side panel while a filter hides its row", async () => {
  // Review Focus 5.
  render(<BrandLifecycle me={owner} routeBrandId="brand-wd" />);
  fireEvent.change(await screen.findByLabelText(/ค้นหาโดเมน/), { target: { value: "float" } });
  expect(screen.getByRole("heading", { level: 2, name: /Wizard Demo/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- brands-filter`
Expected: FAIL, no element is labelled `ค้นหาโดเมน`.

- [ ] **Step 3: Implement `BrandFilters` and wire it into `BrandLifecycle`**

Chips: a `div role="group" aria-label="ตัวกรองแบรนด์ (Brand filters)"` of buttons with `aria-pressed`, each showing its count. Sort: a `<select>` labelled `เรียงลำดับ (Sort)`, omitting the `profit` option when `owner` is false. Search: `<input type="search">` labelled `ค้นหาโดเมน (Search domain)`.

In `BrandLifecycle`: add `const [chip, setChip] = useState<BrandChip>("all")`, `const [sort, setSort] = useState<BrandSortMode>("issues")` and `const [search, setSearch] = useState("")`. Compute `health` per row inside the existing `tableRows` map, build the chip counts over the search-filtered rows, then replace the `sortedRows` line with search, chip and `sortBrands`. The side panel keeps reading `selected`, which comes from the full `brands` array, not from the visible rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- brands-filter` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS. `apps/web/test/brands-page.ui.test.tsx` needs its expected row order updated from worst-profit to issues-first; its comment at the top of the file names the old order and must be updated with it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/BrandFilters.tsx apps/web/src/client/screens/BrandLifecycle.tsx apps/web/src/client/screens/Brands.css apps/web/test/brands-filter.ui.test.tsx apps/web/test/brands-page.ui.test.tsx
git commit -m "feat(web): brands list filter chips, issues-first sort and domain search (FUS-377)"
```

---

### Task 7: Brand card — Copy Final URL, Open site, revision history

**Files:**
- Modify: `apps/web/src/client/screens/BrandLifecycle.tsx` (`LifecycleDetail` at line 516, its props, and the Rollback confirm in the parent)
- Modify: `apps/web/src/client/screens/Brands.css`
- Test: `apps/web/test/brand-final-url.ui.test.tsx`

**Interfaces:**
- Consumes: Task 5's `finalUrl`, `siteUrl` and `api.brandRevisions`; Task 1's `BrandRevisionsResponse`; the existing `showToast` and `confirm` in `BrandLifecycle`.
- Produces: `LifecycleDetail` gains the props `revisions?: BrandRevisionsResponse | null` and `onCopyFinalUrl: () => void`. The parent loads the revisions for the selected brand and passes the rollback target into the Rollback `ConfirmDialog` body.

- [ ] **Step 1: Write the failing test** in `apps/web/test/brand-final-url.ui.test.tsx`

```ts
it("copies https://<apex>/?keyword={keyword} and confirms with a toast", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  /* render, click คัดลอก Final URL */
  expect(writeText).toHaveBeenCalledWith("https://creditsgene.test/?keyword={keyword}");
  expect(await screen.findByRole("status")).toHaveTextContent("creditsgene.test");
});

it("shows the URL in a read-only input when the clipboard is missing", async () => {
  // Review Focus 2.
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  /* render, click */
  expect(await screen.findByDisplayValue("https://creditsgene.test/?keyword={keyword}")).toHaveAttribute("readonly");
});

it("shows the URL in a read-only input when the clipboard rejects", async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
  /* render, click: no unhandled rejection, the input appears, the toast is role="alert" */
});

it("opens the site at the apex in a new tab, safely", async () => {
  const link = await screen.findByRole("link", { name: /เปิดเว็บไซต์/ });
  expect(link).toHaveAttribute("href", "https://creditsgene.test");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link).toHaveAttribute("target", "_blank");
});

it("copies the core hostname for a brand with no factory domain", async () => { /* Review Focus 3: an unmanaged brand */ });

it("lists revisions newest first and marks the current one and the rollback target", async () => {
  /* three revisions; ใช้งานอยู่ on rev 3, เป้าหมายการย้อนกลับ on rev 2 */
});

it("names the rollback target in the Rollback confirm", async () => {
  /* click ย้อนกลับ; the dialog body holds brand-cg_rev_2 */
});

it("hides Copy Final URL and Open site when the brand has no hostname", async () => { /* neither control renders */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- brand-final-url`
Expected: FAIL, no button named `คัดลอก Final URL`.

- [ ] **Step 3: Implement the three additions in `LifecycleDetail`**

`.side-actions` gains the `เปิดเว็บไซต์ (Open site)` anchor and the `คัดลอก Final URL (Copy Final URL)` button, both omitted when `siteUrl(brand.hostnames)` is null. The copy handler awaits `navigator.clipboard?.writeText(url)` inside a `try`; on success it raises the `ok` toast naming the domain, and on a missing clipboard or a rejection it raises the `err` toast and reveals a read-only `<input>` holding the URL. A new `ประวัติเวอร์ชัน (Revision history)` section renders the `revisions` prop with the two markers. The parent loads `api.brandRevisions(selected.brand_id)` in the effect that already loads the checklist, tolerating a failure by passing `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- brand-final-url` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS. The other brands tests need the new `/api/brands/:id/revisions` route added to their stub map.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/BrandLifecycle.tsx apps/web/src/client/screens/Brands.css apps/web/test/brand-final-url.ui.test.tsx
git commit -m "feat(web): Copy Final URL, Open site and revision history on the brand card (FUS-377)"
```

---

### Task 8: The `/deploys` route

**Files:**
- Modify: `apps/web/src/client/router.ts` (the `Route` union and `STATIC`)
- Modify: `apps/web/src/client/components/AppShell.tsx` (`pageTitle`)
- Test: `apps/web/test/deploys-route.ui.test.tsx`

**Interfaces:**
- Produces: `{ view: "deploys" }` in `Route`, `"/deploys"` in `STATIC`, and `pageTitle.deploys = "ประวัติการติดตั้ง"`. `viewPath` needs no change: its `default` branch already returns `/deploys`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/deploys-route.ui.test.tsx`

```ts
it("parses /deploys and round-trips through routePath", () => {
  expect(parseRoute("/deploys")).toEqual({ view: "deploys" });
  expect(routePath({ view: "deploys" })).toBe("/deploys");
  expect(viewPath("deploys")).toBe("/deploys");
});
it("keeps a trailing slash and an unknown sub-path out of the view", () => {
  expect(parseRoute("/deploys/")).toEqual({ view: "deploys" });
  expect(parseRoute("/deploys/inst-1")).toEqual({ view: "not-found", path: "/deploys/inst-1" });
});
it("has a page title", () => { expect(pageTitle.deploys).toBeTruthy(); });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- deploys-route`
Expected: FAIL, `parseRoute("/deploys")` is `{ view: "not-found", path: "/deploys" }`.

- [ ] **Step 3: Add the route and the title**

One member in the `Route` union, one entry in `STATIC`, one key in `pageTitle`. `pageTitle` is `Record<View, string>`, so typecheck fails until the key is added — that is the intended coupling.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- deploys-route` then `bun run --cwd apps/web test` and `bun run typecheck`
Expected: PASS. `apps/web/test/router.ui.test.tsx` and `app-shell.ui.test.tsx` stay green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/router.ts apps/web/src/client/components/AppShell.tsx apps/web/test/deploys-route.ui.test.tsx
git commit -m "feat(web): /deploys route and page title (FUS-377)"
```

---

### Task 9: The deploy history screen

**Files:**
- Create: `apps/web/src/client/screens/Deploys.tsx`
- Create: `apps/web/src/client/screens/Deploys.css`
- Modify: `apps/web/src/client/App.tsx` (one import, one nav item, one render line)
- Modify: `apps/web/src/client/labels.ts` (only if `operationLabel` has to move out of `BrandLifecycle.tsx`)
- Test: `apps/web/test/deploys.ui.test.tsx`

**Interfaces:**
- Consumes: Task 5's `api.deploys`; Task 8's `deploys` view; the existing `DataTable`, `StatusBadge`, `EmptyState`, `Spinner`, `BrandLabel`, `useBrandLabels`, `InstallProgress`, `api.installDetail`, `api.lifecycleBrands`.
- Produces: `export function DeploysScreen({ me }: { me: Me })`.

- [ ] **Step 1: Write the failing test** in `apps/web/test/deploys.ui.test.tsx`

```ts
it("renders the timeline newest first with domain, operation, status, actor and duration", async () => {
  /* four events; the first row shows the domain of brand-a, "ติดตั้ง", a live badge, owner-1 and 4m */
});
it("falls back to the brand id for a brand the lifecycle list does not know", async () => {
  // Review Focus 4.
  expect(await screen.findByText("brand-ghost")).toBeInTheDocument();
});
it("filters by brand, by source and by status", async () => { /* three changes, each asserting the requested query string and the rows */ });
it("expands an install row to its receipts", async () => {
  /* click the row's expand control; api.installDetail is called once and the smoke step label appears */
});
it("expands an audit row to its changed fields", async () => { /* old and new values are shown */ });
it("shows the truncation hint when has_more is true", async () => { /* a hint naming the row count */ });
it("shows an empty state with no events", async () => { /* the EmptyState title */ });
it("shows an error and does not crash when the feed fails", async () => { /* 500 from /api/deploys -> role="alert" */ });
it("names the unavailable core audit source", async () => { /* unavailable: ["core_audit"] -> a visible note */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --cwd apps/web test -- deploys.ui`
Expected: FAIL, `../src/client/screens/Deploys` cannot be resolved.

- [ ] **Step 3: Implement `DeploysScreen` and wire it into `App.tsx`**

Columns in order: เวลา, แบรนด์ (`BrandLabel`), การทำงาน, สถานะ (`StatusBadge`), ผู้เริ่ม, ใช้เวลา, revision. The operation column reads the existing `operationLabel` map in `BrandLifecycle.tsx` for install rows — move that map into `apps/web/src/client/labels.ts` if it is not exported — and the raw `action` for audit rows. A row's expand control fetches `api.installDetail(event_id)` once and caches it in component state; an audit row renders its `old` / `new` fields, which come from the event's own data. Under the table: the `has_more` hint, a note naming any `unavailable` source, and one line linking to `/audit` for the full audit log. `App.tsx` gains the import, a nav item `{ id: "deploys", label: "ประวัติการติดตั้ง", show: true }` directly after `brands`, and `{view === "deploys" && <DeploysScreen me={me} />}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd apps/web test -- deploys.ui` then `bun run test` and `bun run typecheck` at the repo root
Expected: PASS, the whole workspace green. `apps/web/test/app.ui.test.tsx` and `app-shell.ui.test.tsx` may need the new nav item in their expectations.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/screens/Deploys.tsx apps/web/src/client/screens/Deploys.css apps/web/src/client/App.tsx apps/web/test/deploys.ui.test.tsx
git commit -m "feat(web): deploy history screen at /deploys (FUS-377)"
```

---

## Task order and parallelism

| Wave | Tasks | Why they can share a wave |
|---|---|---|
| 1 | T1 | Every other task consumes its types |
| 2 | T2, T4, T5 | `deploys.ts` + `index.ts`, `lifecycle.ts`, and the client modules are disjoint |
| 3 | T3, T6, T8 | T3 needs T2's handler; T6 needs T5; T8 touches only the router and the shell |
| 4 | T7 | Shares `BrandLifecycle.tsx` and `Brands.css` with T6 |
| 5 | T9 | Needs T8's view and T5's `api.deploys` |

## Acceptance criteria to evidence

| FUS-377 criterion | Evidence |
|---|---|
| Filter chips: live, paused, failed install, no live domain | `brands-filter.ui.test.tsx` "filters to one chip and shows each chip's count"; `brand-health.test.ts` `matchesBrandChip` cases |
| Sort issues-first, latest activity, A-Z | `brands-filter.ui.test.tsx` sort cases; `brand-health.test.ts` `sortBrands` cases |
| Search by domain | `brands-filter.ui.test.tsx` "filters by domain search, case-insensitively"; `brand-health.test.ts` `matchesBrandSearch` cases |
| Deploy history across brands, all install rows, rollbacks and config audit rows on one timeline | `deploys-api.test.ts` "merges install rows and audit rows newest first"; `deploys.ui.test.tsx` "renders the timeline newest first ..." |
| `started_by`, `started_at`, `finished_at`, receipts | `deploys-api.test.ts` field assertions; `deploys.ui.test.tsx` "expands an install row to its receipts" |
| Copy Final URL with the keyword param | `brand-final-url.ui.test.tsx` "copies https://<apex>/?keyword={keyword} ..."; `brand-health.test.ts` `finalUrl` cases |
| Open site | `brand-final-url.ui.test.tsx` "opens the site at the apex in a new tab, safely" |
| Revision history per brand with the rollback target shown | `revisions-api.test.ts` "names the revision a rollback would deploy" and "agrees with POST /api/brands/:id/rollback"; `brand-final-url.ui.test.tsx` "lists revisions newest first ..." |
| No Download menu | No task adds one; no artifact route is touched |

## Verification before the PR

- `bun run typecheck` and `bun run test` at the repo root green.
- Muse reviews the markup of the brands list and the deploys screen.
- `git fetch origin && git rebase origin/main`, then typecheck and test again.
