# Plan: theme vars backfill (FUS-383)

Spec: `docs/superpowers/specs/2026-10-26-theme-vars-backfill-design.md`. Branch `fus-383-theme-vars-backfill`, one PR.

## Global Constraints

- AGENTS.md hard rules 1 to 7 bind every task. No deploy, no remote D1, no real external call.
- A sealed `template_versions` row is never updated. The backfilled map lives in `template_theme_vars` (factory 0011).
- Every map read for a brand config, a preview or the template detail uses `effectiveThemeVarsSql(alias) AS theme_vars_json`.
- Every map written passes `TemplateThemeVars` (names pass `ThemeVarName`). Every color reaches CSS only through `themeCss`.
- A brand or redeploy with no map change produces bytes and `config_json` identical to today.
- Shared files (`apps/web/src/server/index.ts`, `apps/web/src/client/App.tsx`, `apps/web/src/client/api.ts`, `packages/contracts/src/index.ts`) get the smallest addition. No reformatting, no reordering.
- UI copy is Thai first with English in parentheses.
- TDD per task. Coders run only the test files they touch, foreground, 5-minute timeout.

## Interfaces

```ts
// packages/factory-db/src/index.ts
/** SQL for a version's effective theme map: the owner's backfill (template_theme_vars) over the import-time column. */
export function effectiveThemeVarsSql(alias: string): string;
// returns `COALESCE((SELECT o.theme_vars_json FROM template_theme_vars o WHERE o.template_version_id = ${alias}.template_version_id), ${alias}.theme_vars_json)`
// alias must match /^[a-z_]+$/ (throw otherwise).

// packages/contracts/src/theme.ts
export const TemplateThemeVarsRequest = z.strictObject({ theme_vars: TemplateThemeVars });
export const TemplateThemeVarsResponse = z.strictObject({ template_version_id: z.string().min(1), theme_vars: TemplateThemeVars });
export const BrandThemeVarsResponse = z.strictObject({ brand_id: z.string().min(1), deployed: TemplateThemeVars.nullable(), template: TemplateThemeVars.nullable() });
/** True when every role is empty. */
export function isEmptyThemeVars(vars: TemplateThemeVars): boolean;

// apps/web/src/client/api.ts
detectTemplateThemeVars(id: string): Promise<TemplateThemeVarsResponse>   // POST /api/templates/:id/detect-theme-vars
saveTemplateThemeVars(id: string, vars: TemplateThemeVars): Promise<TemplateThemeVarsResponse> // PUT /api/templates/:id/theme-vars
brandThemeVars(brandId: string): Promise<BrandThemeVarsResponse>          // GET /api/brands/:id/theme-vars
```

## Task 1: store and contracts

Files:
- Create `packages/factory-db/migrations/0011_template_theme_vars_backfill.sql`. Header comment in the style of 0010 (why: sealed rows are immutable, TP-3; never lead data, never secrets). Body: the `CREATE TABLE IF NOT EXISTS template_theme_vars` of spec 2.1.
- Modify `packages/factory-db/src/index.ts`: append the file to `FACTORY_DB_MIGRATIONS`; add `effectiveThemeVarsSql`.
- Modify `packages/factory-db/test/factory-db.test.ts`. Tests:
  - `migration 0011 adds template_theme_vars`: insert a row for a sealed version succeeds; `'not json'` is rejected by CHECK; an unknown `template_version_id` is rejected by the foreign key (if FKs are on in the test D1; else assert the column set).
  - `effectiveThemeVarsSql prefers the backfill row`: a sealed version with NULL column and a backfill row reads the backfill; without a row it reads the column; the sealed row's UPDATE still aborts.
  - `effectiveThemeVarsSql rejects a bad alias`.
- Modify `packages/contracts/src/theme.ts`: the 3 schemas and `isEmptyThemeVars`. `index.ts` already re-exports `theme.js`; do not touch it.
- Modify `packages/contracts/test/theme.test.ts`. Tests: `TemplateThemeVarsRequest rejects a non-clean name`, `BrandThemeVarsResponse accepts nulls`, `isEmptyThemeVars`.

Commit: `feat(factory): template theme vars backfill store (FUS-383)`.

## Task 2: template-mcp detect endpoint

Files:
- Modify `workers/template-mcp/src/import-service.ts`: accept `POST /detect-theme-vars` with body `z.strictObject({ template_version_id: z.string().min(1).max(128) })`. Read `r2_key` from `template_versions`; 404 `{ error: "not_found" }` when no row; `env.ARTIFACTS.get(r2_key)`; 422 `{ error: "template_zip_missing" }` when absent; `readZip` then `extractThemeVars`; answer `TemplateThemeVarsResponse`. An `InputError` from `readZip` answers 422 with its code. No D1 or R2 write.
- Modify `workers/template-mcp/test/import-service.test.ts`. Tests:
  - `detect-theme-vars returns the detector map for a stored zip` (fixture zip with a hex custom property used as a background; put it in R2 under the row's `r2_key`; assert map and that `template_versions` is unchanged).
  - `detect-theme-vars on demo14 CSS finds --color-royal` (reuse the existing demo14 CSS fixture used by `theme-vars.test.ts`).
  - `detect-theme-vars answers 404 for an unknown version and 422 for a missing zip`.
  - `detect-theme-vars rejects a bad body with 422`.

Commit: `feat(template-mcp): detect theme vars of a stored version (FUS-383)`.

## Task 3: web template routes

Files:
- Modify `apps/web/src/server/templates.ts`:
  - `POST /api/templates/:id/detect-theme-vars`: `authorizePanel("approveTemplate")` else 403 owner; decode id (404); no `TEMPLATE_MCP` 502; fetch `https://template-mcp/detect-theme-vars`; 200 answer parsed with `TemplateThemeVarsResponse` (bad body 502); 404 and 422 passed through; transport error or other status 502.
  - `PUT /api/templates/:id/theme-vars`: owner only; body `TemplateThemeVarsRequest` (bad JSON 400 `invalid_json`, invalid 422 `invalid_theme_vars`); read status and effective map (`effectiveThemeVarsSql("v")`); no row 404; status not `sealed` 409 `not_sealed`; same JSON as effective 200 no-op; else one batch: `INSERT INTO template_theme_vars (...) VALUES (...) ON CONFLICT(template_version_id) DO UPDATE SET theme_vars_json = excluded.theme_vars_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, then the audit row `template.theme_vars` (before = previous effective JSON or null). Answer `TemplateThemeVarsResponse`.
  - Detail GET: select `${effectiveThemeVarsSql("v")} AS theme_vars_json` in place of `v.theme_vars_json`.
  - `GET /api/brands/:id/theme-vars`: `authorize("getBrand")`; the same revision pick as `/site-text`; `deployed` = parsed `config_json.theme_vars` (TemplateThemeVars or null); `template` = effective map of that revision's `template_version_id`, null when invalid or `isEmptyThemeVars`. Unknown brand: `{ brand_id, deployed: null, template: null }` as `/site-text` does with defaults.
- Modify `apps/web/test/templates-api.test.ts`. Tests:
  - `detect-theme-vars forwards to the template MCP for an Owner and refuses an Employee`.
  - `detect-theme-vars answers 502 on transport failure or a bad body`.
  - `saving theme vars on a sealed version writes the backfill row and one audit row, sealed row unchanged`.
  - `saving the same theme vars again writes no audit row`.
  - `saving theme vars refuses a certified version with 409 and an invalid map with 422`.
  - `detail shows the backfilled map over the column`.
- Create `apps/web/test/brand-theme-vars-api.test.ts`. Tests: `reports deployed and template maps`, `template is null when the version has no map`, `deployed is null before a map is baked`.

Commit: `feat(web): detect and save theme vars on sealed templates (FUS-383)`.

## Task 4: bake on redeploy and effective readers

Files:
- Modify `apps/web/src/server/lifecycle.ts`:
  - `createDraft`, `updateDraft`, `redeploy` template queries: `${effectiveThemeVarsSql("template_versions")} AS theme_vars_json`.
  - `redeploy` without `template_version_id`: read the current revision (`template_version_id`, `config_json`) and the effective map of that version. `next = withThemeVars(current.config_json, effective)`. When `JSON.stringify(parse(next).theme_vars ?? null) !== JSON.stringify(parse(current).theme_vars ?? null)`, set `newConfig = next` and `readConfig = current.config_json`; else leave both null. Update the comment above `redeploy`.
- Modify `apps/web/src/server/wizard.ts`: the preview query uses `${effectiveThemeVarsSql("tv")} AS theme_vars_json`.
- Modify `workers/factory/src/workflows/upgrade-all.ts`: the target query uses `${effectiveThemeVarsSql("template_versions")} AS theme_vars_json`.
- Tests:
  - `apps/web/test/brand-edit-api.test.ts`: `plain redeploy bakes a backfilled map`, `plain redeploy with an unchanged map copies config_json byte for byte`, `plain redeploy refuses with 409 when the profile changed after the map was read` (simulate by changing `config_json` between read and batch is hard; acceptable: assert the batch is gated by checking `readConfig` path with a stale-config setup the existing template-change test uses).
  - `apps/web/test/brand-draft-api.test.ts`: `draft config carries the backfilled theme_vars`.
  - `workers/factory/test/workflows.test.ts`: `upgrade-all bakes the backfilled target map`.

Commit: `feat(web): bake the effective theme map on redeploy (FUS-383)`.

## Task 5: panel UI

Files:
- Modify `apps/web/src/client/api.ts`: the 3 methods (smallest addition, next to `approveTemplate` and `siteTextDefaults`).
- Modify `apps/web/src/client/screens/Templates.tsx` (`TemplateDetail`):
  - Owner and status `awaiting_approval` or `approved`: button "ตรวจหาสี (Detect colors)". It calls `detectTemplateThemeVars` and fills the 3 role inputs. An empty result shows "ไม่พบตัวแปรสี (No color variables found)". An error shows a `note neg` line.
  - Owner and `approved`: the inputs become editable and "บันทึกแผนที่สี (Save color map)" validates with `TemplateThemeVars` (same error text as Approve) and calls `saveTemplateThemeVars`. Success shows "บันทึกแล้ว Redeploy แบรนด์เพื่อให้สีมีผล (Saved. Redeploy brands to apply)" and the ledger shows the saved map.
  - Employee view unchanged.
- Modify `apps/web/src/client/screens/SettingsEditor.tsx` (and `Settings.tsx` only if the fetch belongs there): load `brandThemeVars(brand.brand_id)` once per open brand. Render per spec 2.5. While loading or on error, render today's ColorPair.
- Tests:
  - `apps/web/test/templates.ui.test.tsx` (or the existing Templates UI test file): `owner detects colors on a sealed version and saves the map`, `detect with no variables shows the empty note`, `employee sees no detect button`.
  - `apps/web/test/settings-editor.ui.test.tsx`: `warns and hides the color pickers when the template has no color map`, `shows the redeploy note when the deployed map differs`, `shows the color pickers alone when maps match`.

Commit: `feat(web): detect colors button and Settings color map warning (FUS-383)`.

## Review Focus

- T1: the sealed trigger still aborts; FK and CHECK hold; alias guard.
- T2: no write anywhere; zip limits from `readZip` still apply; 404 versus 422.
- T3: owner only on both template routes; the sealed row is never updated; audit row only on change, in the same batch; before_json is the previous effective map.
- T4: an unchanged map leaves `config_json` byte identical (existing redeploy tests stay green); `readConfig` gate on every changed config; form-artifact redeploy also refreshes the map.
- T5: no default colors shown when `template` is null; Thai-first copy; no layout change outside the theme section and the color variables block.

## Verification before push (orchestrator)

`bun run typecheck` at root; tests of `packages/contracts`, `packages/factory-db`, `packages/leads-db`, `workers/template-mcp`, `workers/factory`, `apps/web`. CI runs the full suite.
