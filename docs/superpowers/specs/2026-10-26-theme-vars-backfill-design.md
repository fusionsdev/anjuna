# Theme vars backfill, bake on redeploy, Settings warning (FUS-383)

Found live 2026-10-26 after v1.0.42. Follows the brand colors spec `2026-10-25-brand-colors-design.md` (FUS-381).

Linear: FUS-383. Lane brief: `H:/w/anjuna-wt/_briefs/FUS-383/lane.md`.

## 1. Problem

demo14 (`brand_64271eacddaa4bc1`, demo14.aduplift.ai) saved theme `{primary #16a34a, secondary #1e3a8a}` and was redeployed. The site serves no `<style id="brand-theme">`.

Read-only checks on the aduplift factory D1, 2026-10-26:

- The factory holds 11 template versions. All 11 are `sealed` and all 11 have `theme_vars_json` NULL. Every one was imported before migration 0010, so detection never ran.
- demo14's current revision runs `tv_willow-lake_v2` (R2 key `templates/willow-lake/301e7b66….zip`). Its `config_json` has no `theme_vars`.
- No live brand revision has `theme_vars`. `themeCss(theme, null)` returns null, so no brand can show colors.

Three gaps follow:

1. No path detects colors for an existing version. Detection runs only at import.
2. The Approve save path writes `theme_vars_json` only on a `certified` row. The trigger `template_versions_sealed_immutable` (factory 0001, TP-3) aborts every UPDATE of a sealed row, so a sealed version's column cannot be backfilled.
3. A plain redeploy copies `config_json` unchanged, so a newer map never reaches a live brand. Settings shows the ColorPair defaults (`#2563eb`, `#1e293b`) even when the template has no map, so the owner sees colors that do not apply.

## 2. Design

### 2.1 Backfill store (factory migration 0011)

A sealed row stays immutable (TP-3). The backfilled map goes into its own table:

```sql
CREATE TABLE IF NOT EXISTS template_theme_vars (
  template_version_id TEXT PRIMARY KEY REFERENCES template_versions(template_version_id),
  theme_vars_json TEXT NOT NULL CHECK (json_valid(theme_vars_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- The effective map of a version is `template_theme_vars.theme_vars_json` when a row exists, else `template_versions.theme_vars_json`.
- `@anjuna/factory-db` exports `effectiveThemeVarsSql(alias)`, the SQL expression for the effective map of the row named by `alias`. Every reader selects it `AS theme_vars_json`, so the code after each query stays unchanged.
- Readers that switch to the effective map: `createDraft`, `updateDraft` and `redeploy` in `apps/web/src/server/lifecycle.ts`, the wizard preview in `apps/web/src/server/wizard.ts`, the template detail GET in `apps/web/src/server/templates.ts`, and `workers/factory/src/workflows/upgrade-all.ts`.
- The Approve path for a `certified` version is unchanged. It still writes the column.

### 2.2 Detect colors for an existing version

- template-mcp `TemplateImportService` gains `POST /detect-theme-vars` with body `{ template_version_id }`. It reads the version's `r2_key` from the factory D1, gets the zip from R2, runs `readZip` and `extractThemeVars`, and answers `{ template_version_id, theme_vars }`. It writes nothing. Unknown version: 404. Missing R2 object: 422 `template_zip_missing`.
- anjuna-web gains `POST /api/templates/:id/detect-theme-vars`, owner only (`approveTemplate`). It forwards to the binding and validates the answer with `TemplateThemeVarsResponse`. Transport failure or a bad answer: 502.
- Detection never saves. The owner reviews the proposed map first.

### 2.3 Save a map on a sealed version

- `PUT /api/templates/:id/theme-vars`, owner only (`approveTemplate`), body `TemplateThemeVarsRequest` `{ theme_vars }`.
- Only a `sealed` version is accepted. Any other status answers 409 `not_sealed` (a certified version saves through Approve).
- An unchanged effective map is a no-op 200 with no audit row.
- A changed map is one D1 batch: an upsert into `template_theme_vars`, then an `audit_log` row `template.theme_vars` (entity `template_version`, `before_json` the previous effective map or null, `after_json` the new map). This is the same audit action as the Approve save.
- The answer is `TemplateThemeVarsResponse` `{ template_version_id, theme_vars }`.

### 2.4 Bake on redeploy

- Every redeploy recomputes `config_json.theme_vars` from the effective map of the revision's template version (the current one, or the chosen `template_version_id`).
- The new revision gets a new `config_json` only when the `theme_vars` value changes. A redeploy whose map is unchanged copies `config_json` byte for byte, as today.
- A changed config uses the existing `readConfig` gate, so a profile edit that lands in between is refused with 409.
- upgrade-all and draft creation read the effective map too.

### 2.5 Brand theme save and the Settings warning

The brand Worker reads `theme_vars` from its baked `BRAND_CONFIG`, so only an install bakes a map. A Settings theme save writes `brand_runtime.theme_json` in core and cannot bake. Settings therefore tells the owner what the save will do.

- `GET /api/brands/:id/theme-vars` (`getBrand` rule, like `/site-text`) answers `BrandThemeVarsResponse` `{ brand_id, deployed, template }`.
  - `deployed`: `theme_vars` of the deployed revision's `config_json` (before the first install, the latest revision's), or null.
  - `template`: the effective map of that revision's template version, or null when absent, invalid or empty in every role.
- Settings, theme section:
  - `template` null: a warning replaces the ColorPair. "เทมเพลตของแบรนด์นี้ยังไม่มีแผนที่สี สีที่เลือกจะไม่แสดงบนเว็บ (This brand's template has no color map. Colors will not show on the site.)" plus "Owner: ตรวจหาสีในหน้าเทมเพลต แล้ว Redeploy (Detect colors on the Templates page, then redeploy)". No default colors are shown. A saved theme shows as text with "(ยังไม่มีผล / not applied)".
  - `template` set and not equal to `deployed`: the ColorPair plus a note "สีจะแสดงบนเว็บหลัง Redeploy (Colors show on the site after a redeploy)".
  - Equal, or the request fails: the ColorPair as today.

### 2.6 Templates screen

- An owner sees "ตรวจหาสี (Detect colors)" on the detail of an `awaiting_approval` or `approved` (sealed) version.
- Detect fills the 3 role inputs with the proposed names. The owner can edit them.
- `awaiting_approval`: Approve saves the map, as today.
- `approved`: "บันทึกแผนที่สี (Save color map)" calls the PUT route. The detail reloads and shows the saved effective map.
- A version with no detected primary shows "ไม่พบตัวแปรสี (No color variables found)" and leaves the inputs empty.

## 3. Rules

- Rule 3: the injected style still depends only on brand settings and the baked map.
- Rule 4: every saved name passes `ThemeVarName` (brand clean). `themeCss` validates again at serve time.
- Rule 5: R2 is only read for the sealed template zip. No lead data moves.
- Rule 7: migration 0011 ships as a file only. No deploy, no remote D1 write in this lane.

## 4. Rollout (main session)

1. Deploy (migration 0011, template-mcp, anjuna-web, factory).
2. Owner: Templates, `willow-lake v2`, Detect colors, check, Save color map. Repeat for other versions in use.
3. Owner: redeploy demo14. Expect `<style id="brand-theme">` with `--color-royal:#16a34a`.

## 5. Acceptance (Linear FUS-383)

- Detect on a sealed version returns the detector map from the R2 zip and writes nothing.
- Save on a sealed version stores the map in `template_theme_vars` with one audit row. The sealed row is unchanged.
- A plain redeploy after a save bakes the map into the new revision. A redeploy with no map change copies `config_json` unchanged.
- Settings shows the warning and no default colors when the template has no map.
- `bun run typecheck` and `bun run test` green. No deploy, no remote D1 write.

## 6. Out of scope

- Auto-redeploy on a Settings theme save. Settings shows the redeploy note instead.
- The wizard ColorPair defaults on a template with a map.
- Lead form colors (`/_f/`).
