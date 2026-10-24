# Panel settings (spec 4, FUS-378) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Owner-only `/settings` page with one row per brand and a row drawer that edits AID, A/B test (form per arm, split %), flow gate, amount buckets, keyword default, prepop base and drain key, with a before/after review, 409 handling and an unsaved-change guard.

**Architecture:** One new panel server route fans out core `listBrands` + `getBrand` into one response. One pure client module holds all draft, validation, patch and diff logic. The router gains a leave guard. Two new screen files render the table and the drawer editor and save through the existing `PATCH /api/brands/:id` with `expected_updated_at`. No core change, no contracts change, no migration, no new dependency.

**Tech Stack:** Bun workspaces, TypeScript strict, Zod contracts, Cloudflare Workers, React 19, Vitest (`apps/web` projects `worker` for `test/**/*.test.ts`, `ui` for `test/**/*.ui.test.tsx`, `build` for `*.node.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-25-panel-settings-design.md`

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no `wrangler deploy`, no real external call, no secret in a file.
- No change under `packages/`, `workers/`, `spike/` or any migration folder. Reads go to core over `callCore`; writes go only through the existing `PATCH /api/brands/:id`.
- The settings in scope are exactly seven `BrandConfig` fields: `aid`, `ab_config`, `flow_gate_mode`, `amount_buckets`, `keyword_default`, `prepop_base`, `drain_key`. A patch from the Settings page never holds any other field.
- Validation uses the contract schemas from `@anjuna/contracts`: `LeadsGateAid`, `AbConfig`, `ExperimentId`, `FlowGateMode`, `AmountBuckets`, `Keyword`, `PrepopBase`, `DrainKey`.
- Known forms per A/B arm: `lite_v1` labelled `Lite (lite_v1)`, `full_v1` labelled `14 ขั้น (aurum-14-step)`. The stored arm id is never `aurum-14-step`.
- Flow gate labels come from `flowGateLabel` in `apps/web/src/client/labels.ts`.
- UI copy is Thai first with English in parentheses, using the exact strings in the spec.
- New server code goes in its own module with a `// spec settings` comment. Shared files (`apps/web/src/server/index.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/router.ts`, `apps/web/src/client/components/AppShell.tsx`, `apps/web/src/client/api.ts`, `apps/web/src/server/panel-roles.ts`) get the smallest possible addition. Never reformat or reorder them.
- `ConfigPanel.tsx` does not change (spec D9).
- Done per task: `bun run typecheck` at the repo root green plus `bun run --cwd apps/web test` green.

## Review Focus

1. **An existing A/B arm with an unknown id** (for example `promo_v2`). Expected: the editor keeps the id, labels it "ฟอร์มไม่รู้จัก, ใช้ Lite แทน (Unknown form, served as Lite) promo_v2", lets its weight change, and an unedited draft is not dirty. Tests in Tasks 2 and 5.
2. **Whitespace-only edits.** `" 123 "` for an AID of `123`, or `"1000, 2000"` for buckets `[1000,2000]`. Expected: not dirty, no patch field. Test in Task 2.
3. **Back button with unsaved edits.** Expected: the page stays on `/settings` with the draft until the owner confirms; on confirm the browser lands on the page they went back to, asked once. Test in Task 3.
4. **A 409 followed by a second save.** Expected: the second PATCH sends the reloaded `updated_at` and diffs against the reloaded values; the draft survives the reload. Test in Task 6.
5. **One brand whose `getBrand` fails.** Expected: an error row with the domain and no Edit button; the other rows render and stay editable. Tests in Tasks 1 and 4.

---

### Task 1: `GET /api/settings/brands` (server, Owner-only)

**Files:**
- Create: `apps/web/src/shared/settings.ts`
- Create: `apps/web/src/server/settings.ts`
- Modify: `apps/web/src/server/panel-roles.ts` (one entry `viewSettings: "owner"` with a one-line doc comment, appended after `manageBuilderKeys`)
- Modify: `apps/web/src/server/index.ts` (import + one `handleSettingsRoute` call next to the other `handle*Route` calls, with `// spec settings`)
- Modify: `apps/web/test/api.test.ts` (add `viewSettings: "owner"` to the `toEqual` in "panel-only actions follow the plan's matrix")
- Test: `apps/web/test/settings-api.test.ts`

**Interfaces:**
- Produces in `apps/web/src/shared/settings.ts`:
  - `export const SettingsRow = z.discriminatedUnion(...)` or a union of two strict objects: `{ brand_id: BrandId, hostname: Hostname, brand: BrandConfig, error: z.null() }` and `{ brand_id: BrandId, hostname: Hostname, brand: z.null(), error: z.literal("unavailable") }`. `export type SettingsRow`.
  - `export const SettingsBrandsResponse = z.strictObject({ rows: z.array(SettingsRow), generated_at: Timestamp })`. `export type SettingsBrandsResponse`.
- Produces in `apps/web/src/server/settings.ts`:
  - `export async function buildSettingsRows(summaries: Pick<BrandSummary, "brand_id" | "hostnames">[], getBrand: (brandId: string) => Promise<CoreResult>, limit = 6): Promise<SettingsRow[]>` — at most `limit` `getBrand` calls in flight; a non-2xx result or a thrown error gives the error row; rows sorted by `hostname` with `localeCompare`; `hostname` is `brand.hostnames[0]` for a loaded row, the summary's `hostnames[0]` for an error row.
  - `export async function handleSettingsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined>` — handles `GET /api/settings/brands` only: `authorizePanel("viewSettings", ctx.actor_role)` (403 via the same `forbidden` helper index.ts uses), core `listBrands` (non-2xx passed through as `fromCore` does), then `buildSettingsRows` with `callCore(env, ctx, { endpoint: "getBrand", params: { id } })`, answering 200 `{ rows, generated_at: new Date().toISOString() }`.
- `PANEL_ROLE_TABLE.viewSettings` = `"owner"`.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/settings-api.test.ts` (use `call`, `sessions`, `setupDatabases`, `resetState` from `./helpers`, as `deploys-api.test.ts` does)

```ts
it("an owner gets one parsed row per core brand, sorted by domain", async () => {
  const res = await call("/api/settings/brands", { cookie: owner });
  expect(res.status).toBe(200);
  const body = SettingsBrandsResponse.parse(await res.json());
  const listed = ((await (await call("/api/brands", { cookie: owner })).json()) as { brands: unknown[] }).brands;
  expect(body.rows).toHaveLength(listed.length);
  expect(body.rows.every((r) => r.error === null && r.brand !== null)).toBe(true);
  const hosts = body.rows.map((r) => r.hostname);
  expect(hosts).toEqual([...hosts].sort((a, b) => a.localeCompare(b)));
});
it("an employee gets 403 forbidden_role owner", async () => {
  const res = await call("/api/settings/brands", { cookie: employee });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "forbidden_role", required_role: "owner" });
});
it("buildSettingsRows turns one failed getBrand into an error row and keeps the rest", async () => {
  // b.test fails with 502, a.test and c.test load; rows come back a, b, c.
});
it("buildSettingsRows never has more than `limit` getBrand calls in flight", async () => {
  // 10 summaries, limit 3, a fake getBrand that counts concurrent calls; max seen === 3.
});
it("buildSettingsRows treats a thrown getBrand as an error row", async () => {});
```

Fill the last three bodies with a fake `getBrand` returning `{ status: 200, body: { brand } }` built from `BrandConfig.parse` of the `brand.get.response.json` fixture (or `{ status: 502, body: { error: "bad_gateway" } }`). Assert exact `error` values and `hostname` order.

- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project worker test/settings-api.test.ts` fails on the missing module.
- [ ] **Step 3: Implement** the two files, the role entry, the index.ts call, and the `api.test.ts` matrix entry.
- [ ] **Step 4: Run, expect PASS** — the same command, then `bun run --cwd apps/web test -- --project worker test/api.test.ts`.
- [ ] **Step 5: Commit** — `feat(web): owner-only settings read route (FUS-378)`

---

### Task 2: Settings draft module (pure client logic)

**Files:**
- Create: `apps/web/src/client/settings-draft.ts`
- Test: `apps/web/test/settings-draft.test.ts`

**Interfaces:**
- Consumes: `BrandConfig`, `BrandPatchRequest`, `FlowGateMode`, `AbConfig` and the schemas in Global Constraints; `flowGateLabel`.
- Produces:
  - `export const SETTINGS_FIELDS = ["aid", "ab_config", "flow_gate_mode", "amount_buckets", "keyword_default", "prepop_base", "drain_key"] as const; export type SettingsField = (typeof SETTINGS_FIELDS)[number];`
  - `export const SETTINGS_LABELS: Record<SettingsField, string>` — `aid: "AID (LeadsGate aid)"`, `ab_config: "A/B test"`, `flow_gate_mode: "เกต (Flow gate)"`, `amount_buckets: "ช่วงยอดเงิน (Amount buckets)"`, `keyword_default: "คีย์เวิร์ด (Keyword default)"`, `prepop_base: "Prepop base"`, `drain_key: "Drain key"`.
  - `export const KNOWN_FORMS = [{ id: "lite_v1", label: "Lite (lite_v1)" }, { id: "full_v1", label: "14 ขั้น (aurum-14-step)" }] as const;`
  - `export function formLabel(armId: string): string` — the known label, else `ฟอร์มไม่รู้จัก, ใช้ Lite แทน (Unknown form, served as Lite) <id>`.
  - `export type ArmDraft = { id: string; weight: string };`
  - `export type SettingsDraft = { aid: string; ab_on: boolean; experiment_id: string; arms: ArmDraft[]; flow_gate_mode: FlowGateMode; amount_buckets: string; keyword_default: string; prepop_base: string; drain_key: string };`
  - `export type SettingsValues = Pick<BrandConfig, SettingsField>;`
  - `export type SettingsPatch = Partial<Pick<BrandPatchRequest, SettingsField>>;`
  - `export type DraftErrors = Partial<Record<SettingsField | "experiment_id" | "arms", string>>;`
  - `export function draftFromBrand(brand: BrandConfig): SettingsDraft` — buckets joined with `", "`, keyword `null` → `""`, weights as strings, `ab_on = ab_config !== null`.
  - `export function abOnDefaults(): Pick<SettingsDraft, "experiment_id" | "arms">` — `{ experiment_id: "", arms: [{ id: "lite_v1", weight: "50" }, { id: "full_v1", weight: "50" }] }`.
  - `export function availableForms(arms: ArmDraft[], index: number): (typeof KNOWN_FORMS)[number][]` — known forms no other arm uses, plus the arm's own id when known.
  - `export function parseDraft(d: SettingsDraft): { ok: true; values: SettingsValues } | { ok: false; errors: DraftErrors }` — trims text; empty keyword → `null`; buckets split on `,`, trimmed, `Number`; weights must match `/^\d+$/`; arm weight sum ≠ 100 → `errors.arms = "รวม N% ต้องเป็น 100% (Weights must sum to 100)"`; duplicate ids or < 2 arms → `errors.arms`; then each value through its contract schema, the first issue message becoming the field error.
  - `export function isDirty(brand: BrandConfig, d: SettingsDraft): boolean` — compares the normalised draft (trimmed text, buckets re-joined from the split numbers, weights as numbers, arms order kept) with `draftFromBrand(brand)` normalised the same way; true for any difference, valid or not.
  - `export function buildPatch(brand: BrandConfig, d: SettingsDraft): SettingsPatch | null` — `null` when `parseDraft` fails; otherwise only fields whose value differs from `brand` by `JSON.stringify`.
  - `export function formatSetting(field: SettingsField, value: SettingsValues[SettingsField]): string` — `ab_config` null → `"ปิด (Off)"`, else `"<experiment_id>: <formLabel> <w>% / ..."`; `flow_gate_mode` → `flowGateLabel`; buckets → `", "` join; keyword null → `"—"`; others as is.
  - `export function diffRows(brand: BrandConfig, patch: SettingsPatch): { field: SettingsField; label: string; before: string; after: string }[]` — in `SETTINGS_FIELDS` order.
  - `export function redrawsVisitors(brand: BrandConfig, patch: SettingsPatch): boolean` — true when `ab_config` is in the patch and the experiment id changes or the test turns on or off.
  - `export function touchesMoney(patch: SettingsPatch): boolean` — true when `aid`, `prepop_base` or `drain_key` is in the patch.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/settings-draft.test.ts`, building `brand` from `BrandConfig.parse` of `packages/contracts/fixtures/admin/brand.get.response.json` (`.brand`) with overrides. Named tests:
  - `draftFromBrand then buildPatch on an untouched draft returns {}` and `isDirty` is false.
  - `whitespace-only edits are not dirty` — `aid: " <aid> "`, buckets `"1000 ,2000"` for `[1000,2000]`.
  - `buildPatch holds only changed fields` — change `drain_key` and `flow_gate_mode`; expect exactly those two keys.
  - `empty keyword becomes null` — brand keyword `"loans"`, draft `""` → `{ keyword_default: null }`.
  - `turning A/B off patches ab_config null`; `turning A/B on with abOnDefaults and experiment id "exp-1" patches lite_v1 50 / full_v1 50`.
  - `weights that do not sum to 100 fail with errors.arms and buildPatch returns null`.
  - `a duplicate arm id fails`; `a non-integer weight "33.5" fails`; `an empty experiment id with A/B on fails with errors.experiment_id`.
  - `invalid aid, prepop base, drain key and buckets each give their own error key`.
  - `an unknown arm id survives draftFromBrand and buildPatch unchanged` — brand arms `promo_v2` 60 / `lite_v1` 40; `formLabel("promo_v2")` is the unknown label; changing only its weight to 70/30 patches the full `ab_config` with `promo_v2` kept.
  - `availableForms hides a form another arm uses`.
  - `diffRows renders before and after with flowGateLabel and Off`.
  - `redrawsVisitors is true for a new experiment id and for on/off, false for a weights-only change`.
  - `touchesMoney is true only for aid, prepop_base and drain_key`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project worker test/settings-draft.test.ts`.
- [ ] **Step 3: Implement** `apps/web/src/client/settings-draft.ts`.
- [ ] **Step 4: Run, expect PASS** — same command.
- [ ] **Step 5: Commit** — `feat(web): settings draft, validation and patch logic (FUS-378)`

---

### Task 3: `/settings` route and the router leave guard

**Files:**
- Modify: `apps/web/src/client/router.ts` (route union member `{ view: "settings" }`, `STATIC["/settings"]`, `setLeaveGuard`, guarded `navigate`, guarded `popstate` in `useRoute`)
- Modify: `apps/web/src/client/components/AppShell.tsx` (`pageTitle.settings = "ตั้งค่า (Settings)"`)
- Test: `apps/web/test/router-guard.ui.test.tsx`

**Interfaces:**
- Produces:
  - `export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void` in `router.ts`. Setting a guard records the current `pathname + search` as the guarded path.
  - `navigate(path, options)` keeps its signature and stays `void`. With a guard set and `path` ≠ current `pathname + search`, it awaits the guard and runs the existing navigation only on `true`. Without a guard, behaviour is unchanged and synchronous.
  - In `useRoute`, a `popstate` while a guard is set: read the target `pathname + search + hash`, `history.pushState(null, "", guardedPath)`, keep the route, await the guard, and on `true` run the unguarded navigation to the target (no second question).
  - `parseRoute("/settings")` → `{ view: "settings" }`; `viewPath("settings")` → `"/settings"`.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/router-guard.ui.test.tsx` (render a tiny component that shows `useRoute().view`):
  - `parseRoute and viewPath know /settings`.
  - `navigate without a guard changes the path at once`.
  - `a guard that answers false keeps the path and the view` — guard `vi.fn().mockResolvedValue(false)`, `navigate("/brands")`, await, path still `/settings`, guard called once.
  - `a guard that answers true navigates` — path becomes `/brands`.
  - `navigate to the current path does not ask the guard`.
  - `Back with a guard set restores /settings, asks once, and on true lands on the previous page` — push `/brands` then `/settings`, set guard, `history.back()` (dispatch `popstate` if jsdom does not), expect guard called once and final path `/brands`.
  - `Back with a guard answering false stays on /settings`.
  - `setLeaveGuard(null) removes the guard`.
  - Reset with `setLeaveGuard(null)` and `history.replaceState(null, "", "/")` in `afterEach`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/router-guard.ui.test.tsx`.
- [ ] **Step 3: Implement** in `router.ts` and `AppShell.tsx`. Keep the existing `samePage` and `ROUTE_EVENT` behaviour.
- [ ] **Step 4: Run, expect PASS** — same command, then the whole `ui` project (existing routing tests must stay green).
- [ ] **Step 5: Commit** — `feat(web): settings route and router leave guard (FUS-378)`

---

### Task 4: Settings table screen and nav entry

**Files:**
- Create: `apps/web/src/client/screens/Settings.tsx`
- Create: `apps/web/src/client/screens/Settings.css`
- Modify: `apps/web/src/client/api.ts` (one method)
- Modify: `apps/web/src/client/App.tsx` (nav item, owner gate, render)
- Test: `apps/web/test/settings.ui.test.tsx`

**Interfaces:**
- Consumes: `SettingsBrandsResponse`, `SettingsRow` (Task 1), `formatSetting`, `SETTINGS_LABELS` (Task 2), `viewPath("settings")` (Task 3), `PANEL_ROLE_TABLE.viewSettings`.
- Produces:
  - `api.settingsBrands: () => Promise<SettingsBrandsResponse>` — `GET /api/settings/brands`, parsed with `SettingsBrandsResponse.parse`.
  - `export function SettingsScreen({ me }: { me: Me }): JSX.Element` in `Settings.tsx`. Holds `rows: SettingsRow[] | null`, a load error, `editing: string | null` (brand id) and a `replaceRow(brand: BrandConfig)` helper that Task 6 uses. In this task the Edit button sets `editing` and nothing renders for it yet.
  - App.tsx: nav item `{ id: "settings", label: "ตั้งค่า (Settings)", show: roleAtLeast(me.role, PANEL_ROLE_TABLE.viewSettings) }` placed after `users`; render `SettingsScreen` for an owner, else the Owner-only `NotFound` card used by `users`.

Table: spec D3 columns, `DataTable` label `ตั้งค่าแบรนด์ (Brand settings)`, cells through `formatSetting`, mono columns for AID, prepop base and drain key. Error row per D3. Loading shows `Spinner`; a load failure shows an error card with `ApiError.thai` and a "ลองอีกครั้ง (Retry)" button that reloads. `Settings.css` only adds what the existing classes lack; the page must not scroll sideways at 375 px.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/settings.ui.test.tsx` (stub `fetch` as `deploys.ui.test.tsx` does):
  - `renders one row per brand with domain, AID, A/B summary, flow gate label, buckets, keyword, prepop base and drain key` — two brands, one with A/B `lite_v1` 60 / `full_v1` 40 and `signed_cookie`; expect `"Single Page Cookie"`, `"14 ขั้น (aurum-14-step) 40%"`, `"ปิด (Off)"` for the other.
  - `an error row shows the domain and "โหลดไม่สำเร็จ (Could not load)" and has no Edit button` while the other row has one.
  - `a failed load shows the error card and Retry reloads`.
  - `the sidebar shows Settings to an owner and not to an employee` (render `App` with `/api/me` stubbed per role, as `app-shell.ui.test.tsx` does).
  - `an employee opening /settings sees the Owner-only card and no request goes to /api/settings/brands`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/settings.ui.test.tsx`.
- [ ] **Step 3: Implement** the screen, CSS, API method and App wiring.
- [ ] **Step 4: Run, expect PASS** — same command, then the whole `ui` project.
- [ ] **Step 5: Commit** — `feat(web): settings table screen (FUS-378)`

---

### Task 5: Row drawer editor (fields, A/B arms, validation)

**Files:**
- Create: `apps/web/src/client/screens/SettingsEditor.tsx`
- Modify: `apps/web/src/client/screens/Settings.tsx` (render the editor for `editing`; close sets `editing` to null — no guard yet)
- Test: `apps/web/test/settings-editor.ui.test.tsx`

**Interfaces:**
- Consumes: everything in Task 2's Produces list.
- Produces:
  - `export function SettingsEditor(props: { brand: BrandConfig; draft: SettingsDraft; onDraft: (d: SettingsDraft) => void; onReview: () => void; onClose: () => void; banner: { kind: "conflict" | "error"; text: string } | null; saving: boolean }): JSX.Element` — a controlled drawer. The parent (Settings.tsx) owns `draft` so Task 6 can guard and reload it.
  - Drawer: `.drawer-wrap` / `.scrim` / `aside.drawer`, `aria-label` = `แก้ไขตั้งค่า <domain> (Edit settings)`, title = domain, Close button "ปิด (Close)", scrim click and Escape call `onClose`.
  - Fields per spec D5 with `aria-label` = the `SETTINGS_LABELS` text (A/B parts: `"เปิด A/B test (A/B test on)"`, `"Experiment id"`, `"ฟอร์มแขน <n> (Arm <n> form)"`, `"น้ำหนักแขน <n> (Arm <n> weight)"`). Errors from `parseDraft` render under their field with `aria-invalid`.
  - A/B per spec D4: switch on fills `abOnDefaults()` when the draft has no arms; "เพิ่มแขน (Add arm)" adds the first `availableForms` entry with weight `"0"`; "ลบ (Remove)" only while arms > 2; unknown-id arms show `formLabel(id)` as text, not a select; the total line `รวม N%` with class `error` when ≠ 100.
  - Button "ตรวจและบันทึก (Review and save)" calls `onReview`; disabled when `!isDirty(brand, draft)`, when `buildPatch` returns null, or while `saving`.
  - `banner` renders at the top of the drawer with `role="alert"`.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/settings-editor.ui.test.tsx` (render `SettingsEditor` with a small stateful wrapper that keeps `draft`):
  - `Review and save is disabled until a field changes`.
  - `an invalid drain key shows its error, sets aria-invalid and disables Review and save`.
  - `the flow gate select offers Keyword Param and Single Page Cookie`.
  - `turning A/B on shows two arms lite_v1 50 and full_v1 50 and requires an experiment id`.
  - `the arm form select offers only forms no other arm uses`.
  - `weights 60 and 30 show "รวม 90%" as an error and disable Review and save`.
  - `Remove is hidden at two arms`.
  - `an unknown arm id shows its label as text and its weight stays editable`.
  - `Close, the scrim and Escape call onClose`.
  - `the banner renders with role alert`.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/settings-editor.ui.test.tsx`.
- [ ] **Step 3: Implement** `SettingsEditor.tsx` and the minimal Settings.tsx wiring.
- [ ] **Step 4: Run, expect PASS** — same command plus `test/settings.ui.test.tsx`.
- [ ] **Step 5: Commit** — `feat(web): settings row editor with form per A/B arm (FUS-378)`

---

### Task 6: Review dialog, save, 409 and unsaved-change guard

**Files:**
- Modify: `apps/web/src/client/screens/Settings.tsx`
- Test: `apps/web/test/settings-save.ui.test.tsx`

**Interfaces:**
- Consumes: `diffRows`, `redrawsVisitors`, `touchesMoney`, `buildPatch`, `isDirty`, `draftFromBrand` (Task 2); `setLeaveGuard` (Task 3); `SettingsEditor` (Task 5); `api.patchBrand`, `api.brand`, `ApiError`; `useConfirm`, `Toast`; `answerConfirm` from `apps/web/test/confirm.ts`.
- Behaviour (spec D6, D7, D8):
  - `onReview`: `useConfirm` with the D6 title, a before/after table from `diffRows`, the re-draw line when `redrawsVisitors`, the money line and `tone: "danger"` when `touchesMoney`, confirm label "บันทึก (Save)". Cancel: nothing sent, draft kept.
  - Confirm: `api.patchBrand(id, { ...patch, expected_updated_at: base.updated_at })` with `saving` true. 200 → `replaceRow(response.brand)`, close the drawer, clear the guard, `Toast` "บันทึกแล้ว (Saved)" or "ไม่มีค่าที่เปลี่ยน (Nothing changed)" when `changed` is empty. 409 `conflict` → keep the draft, set the D7 conflict banner, `api.brand(id)` becomes the new base and replaces the table row. Other errors → banner with `ApiError.thai`.
  - Guard: while `isDirty(base, draft)`, `setLeaveGuard(askDiscard)` and a `beforeunload` listener (`preventDefault()`, `returnValue = ""`); cleared when clean, on save, on discard and on unmount. `askDiscard` is the D8 `useConfirm` dialog. Drawer close and Edit on another row call `askDiscard` first while dirty.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/settings-save.ui.test.tsx` (stub `fetch`; render `SettingsScreen`):
  - `the review dialog lists before and after for each changed field` — change AID and flow gate; dialog shows both labels with old and new values and the money line.
  - `Cancel in the review sends no PATCH and keeps the draft`.
  - `Save sends only the changed fields plus expected_updated_at` — assert the PATCH body equals `{ drain_key: "dk_new", expected_updated_at: "<loaded updated_at>" }`.
  - `success replaces the row, closes the drawer and shows "บันทึกแล้ว (Saved)"`.
  - `an empty changed list shows "ไม่มีค่าที่เปลี่ยน (Nothing changed)"`.
  - `a new experiment id adds the returning-visitors line`.
  - `409 keeps the draft, shows the conflict banner, reloads the brand, and the next save sends the reloaded updated_at` — first PATCH 409 `{ error: "conflict" }`, GET returns `updated_at` T2 and a changed `aid`; the second review diffs against the new `aid`; the second PATCH body has `expected_updated_at: T2`.
  - `a 403 shows the ApiError.thai banner and keeps the drawer`.
  - `closing the drawer while dirty asks to discard; Cancel keeps the draft; Discard closes`.
  - `opening another row while dirty asks to discard`.
  - `sidebar-style navigate("/brands") while dirty asks; Cancel stays on /settings` (call `navigate` from the test).
  - `a beforeunload listener exists only while dirty` — dispatch a cancelable `beforeunload` event: `defaultPrevented` true when dirty, false after Discard.
- [ ] **Step 2: Run, expect FAIL** — `bun run --cwd apps/web test -- --project ui test/settings-save.ui.test.tsx`.
- [ ] **Step 3: Implement** in `Settings.tsx`.
- [ ] **Step 4: Run, expect PASS** — same command, then `bun run typecheck` and `bun run --cwd apps/web test`.
- [ ] **Step 5: Commit** — `feat(web): settings review, save, conflict and unsaved guard (FUS-378)`

---

## Task order and parallelism

Sequential, T1 to T6, one coder at a time in one worktree. T4 needs T1 to T3; T5 needs T2 and T4; T6 needs all.

## Acceptance criteria to evidence

| AC | Evidence |
|---|---|
| AC1 Owner-only | `settings-api.test.ts` "an employee gets 403 forbidden_role owner"; `settings.ui.test.tsx` sidebar and Owner-only card tests; `api.test.ts` matrix |
| AC2 Rows and columns | `settings-api.test.ts` "one parsed row per core brand, sorted by domain"; `settings.ui.test.tsx` "renders one row per brand ..." |
| AC3 Partial failure | `settings-api.test.ts` buildSettingsRows error-row tests; `settings.ui.test.tsx` error row and failed load tests |
| AC4 Editor and validation | `settings-draft.test.ts`; `settings-editor.ui.test.tsx` |
| AC5 Review dialog | `settings-save.ui.test.tsx` review and Cancel tests |
| AC6 Patch body and success | `settings-save.ui.test.tsx` "Save sends only the changed fields ..." and success test |
| AC7 409 | `settings-save.ui.test.tsx` 409 test |
| AC8 Unsaved guard | `router-guard.ui.test.tsx`; `settings-save.ui.test.tsx` guard and beforeunload tests |
| AC9 Audit | existing `api.test.ts` "changes A/B weights, buckets, flow gate and money-path settings" and "the panel never writes brand/config audit rows itself (core does)"; core writes `brand.update` |
| AC10 Green | `bun run typecheck`, `bun run test` output in the PR |

## Verification before the PR

- `git fetch && git rebase origin/main`, then `bun run typecheck` and `bun run test` at the repo root.
- Optional local check with mock core: `/settings` as owner at desktop and 375 px; edit, review, save; Back with unsaved edits.
