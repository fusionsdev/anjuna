# Panel settings design (spec 4, FUS-378)

Source: ship order step 4 in `2026-10-23-panel-backlog-and-order.md` (backlog items 6 and 9, plus the debate addition "Settings unsaved-change warning"). Tracking issue: FUS-378. Builds on spec 1 (FUS-374), spec A (FUS-375), spec B (FUS-376) and spec C (FUS-377), all merged on main at 5ff7613.

## Scope

In scope, from the FUS-378 description:

1. A new `/settings` screen: one table, one row per brand, domain first.
2. Per-brand runtime settings that the brand config drawer (`ConfigPanel.tsx`) edits today: LeadsGate AID, A/B test (experiment id, arms with a form per arm, split % weights summing to 100), flow gate mode (labels "Keyword Param" / "Single Page Cookie"), amount buckets, keyword default, prepop base, drain key.
3. Edit in a row drawer, an unsaved-change warning on navigation, a before/after review dialog before save, optimistic concurrency through `expected_updated_at` with a clear 409 message, every save audited by the existing core PATCH path.
4. Role rules from `panel-roles.ts` and `BRAND_PATCH_FIELD_GROUPS`.
5. Reuse of `DataTable`, `ConfirmDialog` (`useConfirm`), `StatusBadge`, `Toast`, `BrandLabel`.

Out of scope (blocked, own governance specs): Cloudflare profiles, multi-network server post, LP wizard and contact data, the `aurum-14-step` form-variant rename, global defaults. Also out of scope here: the drain route fields (`google_ads_account`, `google_conversion_action`, `adkit_project`), the Microsoft Ads account, postback token rotation, site text, logo/favicon, Pause/Resume, Rollback and template moves. Those stay in the brand drawer.

## Baseline (origin/main 5ff7613)

- `ConfigPanel.tsx` is a per-brand drawer opened from the Brands screen. It saves each section on its own through `api.patchBrand(id, { ...body, expected_updated_at })`. A 409 reloads the brand and shows `ApiError.thai` for `conflict` ("ข้อมูลถูกแก้ไขโดยคนอื่นแล้ว กรุณารีเฟรช"). Only the A/B weights are editable; the experiment id and the arm ids are fixed. Flow gate changes ask `useConfirm` first. No section shows a before/after view.
- Core `PATCH /admin/brands/:id` (`patchBrand`) takes any subset of `BRAND_PATCH_FIELDS` plus `expected_updated_at`, answers 409 `{ error: "conflict", current_updated_at }` when stale, and writes one `brand.update` audit row with old and new values when something changed. The panel server re-checks field roles (`authorize("patchBrand", role, body)`) before it calls core.
- Field roles (`BRAND_PATCH_FIELD_GROUPS`): `keyword_default` is employee; `ab_config`, `amount_buckets`, `flow_gate_mode` and the money routing fields (`aid`, `prepop_base`, `drain_key`) are owner.
- `GET /api/brands` returns `BrandSummary` rows (no AID, buckets, keyword, prepop base or drain key). `GET /api/brands/:id` returns the full `BrandConfig`. Both are `min_role: "employee"` in core.
- A/B arms: `AbConfig = { experiment_id, variants: [{ id, weight }] }`, 2 to 8 arms, unique ids, weights sum to 100. The brand Worker draws an arm by weight and passes the arm id to the form as `cfg.variant` (`packages/brand-runtime/src/worker.ts:297`). The form maps `lite_v1` to the lite form and `full_v1` to the 14-step form (`apps/lead-form/src/lib/experiment.ts`); any other id falls back to lite. The arm id is therefore the form selector. The arm id must be brand clean, so the 14-step arm id is `full_v1`, never `aurum-14-step` (the V1 `form_variant` name, `V1_FORM_VARIANTS.FULL`).
- A returning visitor keeps their arm while the `_ab` cookie names the same `experiment_id` and an arm with that id still exists (`packages/brand-runtime/src/assignment.ts:10`). A new experiment id re-draws every visitor.
- The router (`router.ts`) sends every in-app navigation through `navigate()`; Back and Forward arrive as `popstate`. There is no navigation guard.
- `PANEL_ROLE_TABLE` is asserted key by key in `apps/web/test/api.test.ts` ("panel-only actions follow the plan's matrix").

## Decisions

### D1. The page is Owner-only

Every setting on the page except `keyword_default` is an owner field group. An employee table would be read-only money routing values the drawer hides from them today (`MoneySection` renders only for owner). So the page is Owner-only, like Users:

- `PANEL_ROLE_TABLE` gains `viewSettings: "owner"`.
- The sidebar shows "ตั้งค่า (Settings)" only to an owner.
- An employee who opens `/settings` directly sees the Owner-only `NotFound` card, the same one Users shows.
- The server route answers 403 `forbidden_role` to an employee.

An employee keeps editing the keyword default in the brand drawer, unchanged.

### D2. One server route returns every brand's full config

`GET /api/settings/brands` (new module `apps/web/src/server/settings.ts`, `// spec settings`):

1. `authorizePanel("viewSettings", role)`; 403 for an employee.
2. Core `listBrands`. A non-2xx result is passed through as `fromCore` does today (status and `AdminError` body, 502 `bad_gateway` when core is unreachable). The screen shows an error card with a retry button.
3. Core `getBrand` for each listed brand, at most 6 calls in flight.
4. Answer `{ rows: SettingsRow[], generated_at }`, rows sorted by domain A to Z (`brand.hostnames[0]`, or the summary's `hostnames[0]` for an error row). A row is `{ brand_id, hostname, brand: BrandConfig, error: null }` or `{ brand_id, hostname, brand: null, error: "unavailable" }` when that one `getBrand` failed. One failed brand does not fail the page.

The response schema lives in `apps/web/src/shared/settings.ts` (panel-only, like `shared/brand-edit.ts`). No contracts change, no core change, no migration.

Why a server fan-out and not N browser requests: one Owner gate on the server for the read, one round trip from the browser, and the per-row failure shape is tested once.

### D3. Table columns

`DataTable`, label "ตั้งค่าแบรนด์ (Brand settings)". Columns, in order:

1. แบรนด์ (Brand): `BrandLabel` with `domain = hostnames[0]`.
2. สถานะ (Status): `StatusBadge` with `statusBadgeTone` / `statusLabel`.
3. AID (`aid`), monospace.
4. A/B: "ปิด (Off)" when `ab_config` is null; else the experiment id and each arm as "<form label> <weight>%".
5. เกต (Flow gate): `flowGateLabel`.
6. ช่วงยอดเงิน (Amount buckets): comma list.
7. คีย์เวิร์ด (Keyword default): value or "—".
8. Prepop base, monospace.
9. Drain key, monospace.
10. แก้ไขล่าสุด (Updated): `updated_at`.
11. An "แก้ไข (Edit)" button.

An error row shows the domain, a red "โหลดไม่สำเร็จ (Could not load)" badge in the status cell, "—" in the value cells, and no Edit button. At 375 px the table scrolls inside `.data-table`; the page itself does not scroll sideways.

### D4. Form per arm

Known forms, in one client constant:

| Arm id | Label |
|---|---|
| `lite_v1` | `Lite (lite_v1)` |
| `full_v1` | `14 ขั้น (aurum-14-step)` |

The label names the V1 form variant so the owner recognises it. The stored arm id stays `full_v1`. Renaming either id is the blocked form-variant rename.

The A/B editor:

- A switch "เปิด A/B test (A/B test on)". Off saves `ab_config: null`. On from off pre-fills arms `lite_v1` 50 and `full_v1` 50 and an empty experiment id.
- Experiment id input, validated with `ExperimentId`. Required when on.
- One line per arm: a form select and a weight input (whole number, 0 to 100). The select offers the known forms that no other arm uses, plus the arm's own value.
- "เพิ่มแขน (Add arm)" appears while a known form is unused; "ลบ (Remove)" appears while there are more than 2 arms.
- An existing arm whose id is not a known form keeps its id and shows "ฟอร์มไม่รู้จัก, ใช้ Lite แทน (Unknown form, served as Lite) <id>". Its form cannot be changed; its weight can; it can be removed.
- A running total "รวม N%" in red when not 100. The whole draft is invalid while the total is not 100, ids repeat, or fewer than 2 arms remain.
- The full `AbConfig` is re-validated with the contract schema before the patch is built.

### D5. Row drawer editor and validation

"แก้ไข (Edit)" opens a right-side drawer (the existing `.drawer` styles) titled with the domain. Fields:

| Field | Input | Validation (contract schema) | Empty input |
|---|---|---|---|
| AID | text | `LeadsGateAid` | invalid |
| A/B | D4 | `AbConfig` | switch off = null |
| Flow gate | select with the two labels | `FlowGateMode` | n/a |
| Amount buckets | text, comma separated | `AmountBuckets` after parse to integers | invalid |
| Keyword default | text | `Keyword` | null (template default) |
| Prepop base | text | `PrepopBase` | invalid |
| Drain key | text | `DrainKey` | invalid |

Each invalid field shows its message under the input and sets `aria-invalid`. Text values are trimmed before validation and comparison.

"ตรวจและบันทึก (Review and save)" is disabled while any field is invalid or nothing differs from the loaded brand.

The patch holds only fields whose value differs from the loaded `BrandConfig`, compared by value (`JSON.stringify` for arrays and `ab_config`). It never holds a field outside the seven in scope.

### D6. Before/after review dialog

Pressing "ตรวจและบันทึก" opens `useConfirm` with:

- title `บันทึกการเปลี่ยนแปลงของ <domain>? (Save changes?)`;
- body: a table, one row per changed field, columns field label, before, after; values rendered as in the table cells;
- an extra line when the experiment id changes or A/B turns on or off: "ผู้เข้าชมเดิมจะถูกสุ่มแขนใหม่ (Returning visitors are drawn again)";
- an extra line when a money routing field (AID, prepop base, drain key) changes: "ค่านี้เปลี่ยนเส้นทางเงินของแบรนด์ทันที (This changes the brand's money routing at once)", and the dialog tone is `danger`;
- confirm label "บันทึก (Save)".

Cancel sends no request and keeps the drawer and the draft.

### D7. Save, 409 and audit

On confirm, `api.patchBrand(id, { ...patch, expected_updated_at: loaded.updated_at })`:

- 200: the table row takes `response.brand`, the drawer closes, a `Toast` says "บันทึกแล้ว (Saved)". When `changed` is empty the toast says "ไม่มีค่าที่เปลี่ยน (Nothing changed)".
- 409 `conflict`: the drawer stays open with the draft intact. A red banner in the drawer says "มีคนแก้ไขแบรนด์นี้หลังจากคุณเปิด โหลดค่าล่าสุดแล้ว ตรวจการแก้ไขแล้วบันทึกอีกครั้ง (Someone changed this brand after you opened it. The latest values are loaded; review your edits and save again.)". The editor reloads the brand with `api.brand(id)` and makes it the new base, so the next review diffs against the latest values and sends the new `updated_at`. The table row also takes the reloaded brand.
- Any other error: the drawer stays open and shows `ApiError.thai`.

Audit: core writes one `brand.update` row with old and new values for every save that changes something (`workers/core`, and `mock-core.ts` in tests). The panel writes no audit row of its own, matching "the panel never writes brand/config audit rows itself (core does)" in `api.test.ts`.

### D8. Unsaved-change warning

A draft is dirty when its patch (D5) is non-empty, valid or not.

`router.ts` gains a leave guard:

```ts
/** A screen with unsaved edits registers one; null clears it. Resolves true when leaving is fine. */
export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void;
```

- `navigate(path)`: with a guard set and `path` different from the current path, it awaits the guard and navigates only on `true`.
- Back and Forward: on `popstate` with a guard set, `useRoute` puts the guarded path back with `history.pushState`, keeps the current route, awaits the guard, and on `true` navigates to the path the user went to without asking again.
- Reload, tab close and an external link: the Settings screen adds a `beforeunload` listener while dirty (`preventDefault()` and `returnValue = ""`).

Inside Settings, closing the drawer (Close, scrim, Escape) and opening another row's editor ask the same question while dirty. The question is a `useConfirm` dialog: title "ทิ้งการแก้ไขที่ยังไม่บันทึก? (Discard unsaved changes?)", confirm "ทิ้งการแก้ไข (Discard)", tone `danger`.

The guard is registered only while dirty and cleared on save, discard and unmount.

### D9. The brand drawer stays

`ConfigPanel.tsx` keeps working unchanged. It still owns the fields this spec leaves out (D-scope) and the employee keyword edit. Both editors write through the same PATCH with `expected_updated_at`, so an edit in one makes a stale save in the other answer 409. Follow-up (not this spec): drop the A/B, buckets, flow gate, AID, prepop and drain key sections from the drawer and link to `/settings` once the owner has used the table.

## Acceptance criteria

1. AC1 Owner-only: the sidebar shows Settings to an owner only; an employee opening `/settings` sees the Owner-only card; `GET /api/settings/brands` answers 403 to an employee.
2. AC2 One row per brand, sorted by domain, domain first, with AID, A/B summary, flow gate label, amount buckets, keyword default, prepop base, drain key and updated time.
3. AC3 One brand's failed `getBrand` gives an error row while the others render; a failed `listBrands` gives an error card with retry.
4. AC4 The row editor edits the seven settings with contract-schema validation; each A/B arm picks its form from `lite_v1` / `full_v1`; the weights must sum to 100; save is disabled when invalid or unchanged.
5. AC5 The review dialog lists before and after for each changed field; Cancel sends no request.
6. AC6 The PATCH body holds only the changed fields plus `expected_updated_at`; success updates the row and shows a toast.
7. AC7 A 409 shows the conflict banner, reloads the latest values, keeps the draft and sends the new `updated_at` on the next save.
8. AC8 With unsaved edits, sidebar navigation, Back, drawer close and opening another row ask before discarding; Cancel keeps the draft and the page; a `beforeunload` listener exists only while dirty.
9. AC9 Every save that changes a value produces one core `brand.update` audit row (existing core PATCH path).
10. AC10 `bun run typecheck` and `bun run test` green.
