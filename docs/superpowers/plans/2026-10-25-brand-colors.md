# Brand colors Implementation Plan (FUS-381)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each brand picks a primary and a secondary color; the brand Worker writes them over the template's CSS variables.

**Architecture:** Pure helpers in `@anjuna/contracts` (`theme.ts`) build the CSS. Core stores the live theme in `brand_runtime.theme_json`; each template version stores its variable map in `template_versions.theme_vars_json`, baked into revision `config_json.theme_vars`. brand-runtime appends `<style id="brand-theme">` at the end of `<head>` on the index and legal pages.

**Tech Stack:** TypeScript strict, zod, Bun workspaces, Vitest, `@cloudflare/vitest-pool-workers`, HTMLRewriter, D1, React (apps/web).

**Spec:** `docs/superpowers/specs/2026-10-25-brand-colors-design.md`

## Global Constraints

- `HexColor`: input `#rrggbb` (any case), stored and output lowercase, regex `^#[0-9a-f]{6}$` after lowercasing. Nothing else passes.
- Variable names: `^--[a-z0-9-]{1,64}$`, `isBrandClean`, at most 8 per role.
- `darkenHex(hex)`: each channel `Math.round(c * 0.88)`. `darkenHex("#2563eb") === "#2157cf"`.
- CSS shape: `:root{<name>:<hex>;...}` with no trailing semicolon, order primary names, primary_dark names, secondary names. Wrapped as `<style id="brand-theme">…</style>`.
- No theme or no mapped name: inject nothing, bytes identical to today.
- Rule 3: the block depends only on settings. Rule 4: no "anjuna", "aurum", other brand ids, PostHog key or Sentry DSN in served bytes.
- Migrations as files only: `packages/leads-db/migrations/0016_brand_theme.sql`, `packages/factory-db/migrations/0010_template_theme_vars.sql`. No deploy, no remote D1.
- Shared files get the smallest possible addition; never reorder or reformat them.
- UI copy is Thai first with English in parentheses.
- Lane FUS-382 (Spec 7 polish) owns the Template Approve confirm and the `SettingsEditor` layout. B4 and C5 add only the mapping editor and the color fields. Rebase onto FUS-382 PRs that land first.

## Review Focus

1. A stored `theme_json` that is invalid JSON or has a bad hex: core serves `theme: null`, never 503 (Task A2 test `serves an invalid stored theme as null`).
2. Old core answers 400 to `include_theme`: the Worker still gets site text through the existing fallback (Task A4 test `falls back to site text only when core refuses include_theme`).
3. A template with `<head>` but variables mapped only for secondary: block holds only the secondary names (Task A1 test `themeCss writes only mapped roles`).
4. A PATCH with `theme: null` clears the column and audits the change; a PATCH with the same theme is a no-op (Task A3 tests).
5. A second install of an existing brand never overwrites `theme_json` set in Settings (Task A3 test `keeps theme_json on a later install`).

---

## PR A: contracts, core, brand-runtime (branch `fus-381-brand-colors`)

### Task A1: theme contract and `themeCss`

**Files:**
- Create: `packages/contracts/src/theme.ts`
- Modify: `packages/contracts/src/brand-draft.ts:106-110` (add `theme` to `BrandProfile`)
- Modify: `packages/contracts/src/index.ts` (one export line at the end)
- Test: `packages/contracts/test/theme.test.ts`

**Interfaces:**
- Produces:
  - `HexColor: z.ZodType<string>` (lowercases, then regex)
  - `BrandTheme = z.strictObject({ primary: HexColor, secondary: HexColor })`, `type BrandTheme`
  - `ThemeVarName` (regex + `isBrandClean`), `TemplateThemeVars = z.strictObject({ primary: z.array(ThemeVarName).max(8), primary_dark: …, secondary: … })`, `type TemplateThemeVars`
  - `EMPTY_THEME_VARS: TemplateThemeVars` (all empty arrays)
  - `darkenHex(hex: string): string`
  - `themeCss(theme: unknown, vars: unknown): string | null` (returns the `:root{…}` text only, no style tag)
  - `themeStyleTag(css: string): string` returns `<style id="brand-theme">${css}</style>`
  - `BrandProfile.theme: BrandTheme.optional()`

- [ ] **Step 1: Write the failing tests** in `theme.test.ts`:
  - `HexColor accepts #rrggbb in any case and lowercases`: `HexColor.parse("#2563EB") === "#2563eb"`.
  - `HexColor rejects short, named and functional colors`: `#fff`, `red`, `rgb(0,0,0)`, `#2563eb;}`, `#2563eg`, `""` all fail.
  - `darkenHex multiplies each channel by 0.88`: `#2563eb`→`#2157cf`, `#000000`→`#000000`, `#ffffff`→`#e0e0e0`, `#0f766e`→`#0d6861`.
  - `themeCss writes primary, dark and secondary in order`: theme `{primary:"#0f766e",secondary:"#1e293b"}`, vars `{primary:["--color-royal"],primary_dark:["--color-royal-dark"],secondary:["--color-ink"]}` → `:root{--color-royal:#0f766e;--color-royal-dark:#0d6861;--color-ink:#1e293b}`.
  - `themeCss writes only mapped roles`: vars with only `secondary:["--ink"]` → `:root{--ink:#1e293b}`.
  - `themeCss returns null without a theme or mapped names`: `(null, vars)`, `(theme, null)`, `(theme, EMPTY_THEME_VARS)` all null.
  - `themeCss returns null on an invalid hex or variable name`: theme primary `"#fff"`; var `"--x;}body{"`; var `"--anjuna-blue"`; 9 names in one role.
  - `BrandProfile accepts an optional theme and rejects a bad one`.
- [ ] **Step 2: Run** `bun run --cwd packages/contracts test -- theme` . Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `theme.ts` and the `BrandProfile` field. `themeCss` parses both inputs with `safeParse` and returns null on failure.
- [ ] **Step 4: Run** `bun run --cwd packages/contracts test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(contracts): brand theme schema and themeCss (FUS-381)`

### Task A2: core column and brandSettings RPC

**Files:**
- Create: `packages/leads-db/migrations/0016_brand_theme.sql`
- Modify: `packages/contracts/src/leads-rpc.ts:175-191` (`BrandSettingsRequest.include_theme: z.literal(true).optional()`, `BrandSettingsResponse.theme: BrandTheme.nullable().optional()`)
- Modify: `packages/leads-db/src/index.ts` (row type gets `theme_json: string | null`)
- Modify: `workers/core/src/rpc/runtime.ts` (select `theme_json`; `publicSettings(row, includeSiteText = false, includeTheme = false)`)
- Modify: `workers/core/src/rpc/index.ts:65` (pass `include_theme === true`)
- Test: `workers/core/test/rpc.test.ts`, `packages/leads-db/test/leads-db.test.ts`, `packages/contracts/test/leads-rpc.test.ts`

**Interfaces:**
- Consumes: `BrandTheme` (A1).
- Produces: column `brand_runtime.theme_json TEXT` with `CHECK (theme_json IS NULL OR json_valid(theme_json))`; RPC field `theme` present only when `include_theme: true`.

- [ ] **Step 1: Write the failing tests**:
  - leads-db `migration 0016 adds theme_json and refuses invalid JSON`.
  - contracts `brandSettings response accepts theme only as a valid BrandTheme or null`.
  - core rpc `returns theme only when include_theme is set` (stored `{"primary":"#0f766e","secondary":"#1e293b"}`; without the flag the key is absent).
  - core rpc `serves an invalid stored theme as null` (stored `{"primary":"#fff","secondary":"#000000"}` → `theme: null`, status 200).
- [ ] **Step 2: Run** `bun run --cwd workers/core test -- rpc`. Expected: FAIL.
- [ ] **Step 3: Implement.** Migration header comment follows 0011's style. `publicSettings` parses `theme_json` with `BrandTheme.safeParse(JSON.parse(...))` inside try, null on any failure.
- [ ] **Step 4: Run** tests of contracts, leads-db, core. Expected: pass.
- [ ] **Step 5: Commit** `feat(core): brand_runtime.theme_json and brandSettings theme (FUS-381)`

### Task A3: admin GET/PATCH and first-install theme

**Files:**
- Modify: `packages/contracts/src/admin-api.ts:194-260` (`BrandConfig.theme: BrandTheme.nullable()`, `BrandPatchRequest.theme: BrandTheme.nullable().optional()`, `"theme"` appended to `BRAND_PATCH_FIELDS`)
- Modify: `packages/contracts/src/lifecycle.ts:206-214` (`InitialRuntime.theme: BrandTheme.nullable().optional()`)
- Modify: `workers/core/src/admin/index.ts` (column list, `brandConfig`, patch candidate `["theme", "theme_json", …]`)
- Modify: `workers/core/src/lifecycle.ts:120-128` (INSERT writes `theme_json`; UPDATE untouched)
- Test: `workers/core/test/admin.test.ts`, `workers/core/test/lifecycle.test.ts`, `packages/contracts/test/admin-api.test.ts`
- Also fix any web/core fixture that builds a strict `BrandConfig` (add `theme: null`), found by `bun run test` at the root.

**Interfaces:**
- Consumes: `BrandTheme` (A1), column (A2).
- Produces: `BrandConfig.theme`, `BrandPatchRequest.theme`, `InitialRuntime.theme` (C uses all three).

- [ ] **Step 1: Write the failing tests**:
  - admin `GET returns theme null for a brand without one and the stored theme otherwise`.
  - admin `PATCH theme stores lowercase JSON, bumps updated_at and audits old and new`.
  - admin `PATCH theme null clears theme_json`.
  - admin `PATCH with the same theme changes nothing`.
  - admin `PATCH rejects an invalid hex with 400`.
  - admin `serves an invalid stored theme as null` in GET.
  - lifecycle `writes initial_runtime.theme on first install`.
  - lifecycle `keeps theme_json on a later install`.
- [ ] **Step 2: Run** `bun run --cwd workers/core test -- admin lifecycle`. Expected: FAIL.
- [ ] **Step 3: Implement.** GET parses `theme_json` the same safe way as A2 (share one helper in `rpc/runtime.ts`, exported as `parseStoredTheme(json: string | null): BrandTheme | null`).
- [ ] **Step 4: Run** root `bun run typecheck` and `bun run test`. Expected: green.
- [ ] **Step 5: Commit** `feat(core): admin theme field and first-install theme (FUS-381)`

### Task A4: brand-runtime injection (Opus seat)

**Files:**
- Modify: `packages/brand-runtime/src/config.ts:20-38` (`theme: BrandTheme.nullable().default(null).catch(null)`, `theme_vars: TemplateThemeVars.nullable().default(null).catch(null)`)
- Modify: `packages/brand-runtime/src/settings-cache.ts` (request chain)
- Modify: `packages/brand-runtime/src/worker.ts` (`serveHtml` extra `theme?: string`; index and legal pages pass it)
- Modify: `packages/brand-runtime/src/testing.ts` (mock returns `theme` only when asked)
- Test: `packages/brand-runtime/test/theme.test.ts`

**Interfaces:**
- Consumes: `themeCss`, `themeStyleTag`, `BrandTheme`, `TemplateThemeVars` (A1); RPC `include_theme` (A2).
- Produces: `BRAND_CONFIG.theme_vars` is read from the revision config (B writes it).

- [ ] **Step 1: Write the failing tests** in `theme.test.ts`:
  - `appends the theme block as the last child of head on the index page`: html contains `<style id="brand-theme">:root{--color-royal:#0f766e;--color-royal-dark:#0d6861;--color-ink:#1e293b}</style></head>`.
  - `adds the block to every legal page and not to the form page`.
  - `serves bytes identical to a brand without theme support when theme or vars are missing`: compare against the same worker config with neither field, for `/`, `/privacy`, `/request?requested_amount=750&zip=60601`; three cases (no theme, no vars, empty vars).
  - `serves identical bytes to different visitors` (different user-agent, cf-connecting-ip, referer, gclid).
  - `ignores an invalid live theme and serves the template colors`.
  - `asks core with include_site_text and include_theme`.
  - `falls back to site text only when core refuses include_theme` (mock 400 on the include_theme request; site text still applied; third request bare only after a second 400).
  - `applies a Settings change within the 60 second TTL`.
  - `keeps the block brand clean` (`isBrandClean` on the block).
  - `does not inject into a page without a head element`.
- [ ] **Step 2: Run** `bun run --cwd packages/brand-runtime test -- theme`. Expected: FAIL.
- [ ] **Step 3: Implement.** `rewriter.on("head", { element(e) { e.append(tag, { html: true }); } })` only when `themeCss` returns a string. Compute the tag once per request from settings.
- [ ] **Step 4: Run** `bun run --cwd packages/brand-runtime test` (both configs) and root `bun run typecheck`. Expected: green, existing site-text and worker tests unchanged.
- [ ] **Step 5: Commit** `feat(brand-runtime): inject brand theme style block (FUS-381)`

---

## PR B: template theme vars (branch `fus-381b-template-theme-vars`, after A merges)

### Task B1: detection

**Files:**
- Create: `workers/template-mcp/src/theme-vars.ts`
- Create: `workers/template-mcp/test/fixtures/demo14.css` (fetched public CSS of demo14.aduplift.ai, trimmed to the `:root`/`@layer theme` block and the `bg-*`/`text-*` rules)
- Test: `workers/template-mcp/test/theme-vars.test.ts`

**Interfaces:**
- Produces: `extractThemeVars(files: FileMap): TemplateThemeVars` (same `FileMap` as `extractTextDefaults`).

- [ ] Tests: `detects --color-royal and --color-royal-dark on demo14 CSS`; `detects --accent on the Astro starter`; `drops gray and neutral variables`; `returns EMPTY_THEME_VARS when no hex variable is used as a background`; `picks secondary from color declarations`; `breaks ties by declaration order`.
- [ ] Implement per spec section 3. Commit `feat(template-mcp): detect template theme variables (FUS-381)`.

### Task B2: factory column and import store

**Files:**
- Create: `packages/factory-db/migrations/0010_template_theme_vars.sql` (`ALTER TABLE template_versions ADD COLUMN theme_vars_json TEXT CHECK (theme_vars_json IS NULL OR json_valid(theme_vars_json))`; take the next free number on main at task start)
- Modify: `workers/template-mcp/src/submit.ts`, `workers/template-mcp/src/certifier.ts` (store `JSON.stringify(extractThemeVars(files))` next to `text_defaults_json`, both the new-version and rejected-resubmit paths)
- Test: `packages/factory-db/test/*`, `workers/template-mcp/test/submit.test.ts`

- [ ] Tests: `migration 0010 adds theme_vars_json`; `submit stores detected theme vars`; `resubmit of a rejected version refreshes theme vars`.
- [ ] Commit `feat(factory): store template theme vars (FUS-381)`.

### Task B3: bake into revision config

**Files:**
- Modify: `packages/contracts/src/theme.ts` (`withThemeVars(configJson: string, themeVarsJson: string | null): string`, mirror of `withTextDefaults`)
- Modify: `apps/web/src/server/lifecycle.ts:149-159,205-214,347-355`, `workers/factory/src/workflows/upgrade-all.ts:186-197` (select `theme_vars_json`, wrap with `withThemeVars`)
- Test: `packages/contracts/test/theme.test.ts`, existing lifecycle and upgrade-all tests

- [ ] Tests: `withThemeVars sets valid vars and removes invalid or empty ones`; web `draft config carries the template theme_vars`; factory `upgrade-all refreshes theme_vars to the target version`.
- [ ] Commit `feat(factory): bake template theme vars into revision config (FUS-381)`.

### Task B4: Approve mapping UI

**Files:**
- Modify: `apps/web/src/client/screens/Templates.tsx` (mapping editor for pending versions)
- Modify: `apps/web/src/server/` template review route (accept `theme_vars` with the approve action, validated by `TemplateThemeVars`)
- Modify: `apps/web/src/client/api.ts` (smallest addition)
- Test: `apps/web/test/*templates*`

- [ ] Tests: `approve saves corrected theme vars`; `approve rejects an invalid variable name`; `screen shows the detected map`.
- [ ] Commit `feat(web): template theme var mapping on approve (FUS-381)`.

---

## PR C: color picker (branch `fus-381c-color-picker`, after A merges)

### Task C1: `ColorPair`

**Files:** Create `apps/web/src/client/components/ColorPair.tsx`; test `apps/web/test/color-pair.test.tsx`.
**Interfaces:** `ColorPair(props: { value: BrandTheme | null; onChange(next: BrandTheme | null): void; disabled?: boolean })`. Default shown values when null: `#2563eb` / `#1e293b`.
- [ ] Tests: `color input and hex field stay in sync`; `invalid hex text keeps the last valid value and shows an error`; `use template colors sends null`.
- [ ] Commit `feat(web): ColorPair component (FUS-381)`.

### Task C2: wizard Template step and draft

**Files:** `apps/web/src/client/wizard/StepPanels.tsx:78`, `apps/web/src/client/screens/BrandWizard.tsx`, draft save in `apps/web/src/server/wizard.ts` only if it filters profile keys.
- [ ] Tests: `template step saves profile.theme in the draft`; `reset saves the draft without theme`; `pickers are disabled with the no-variables note when the template maps none`.
- [ ] Commit `feat(web): brand colors in wizard Template step (FUS-381)`.

### Task C3: preview colors (needs PR B merged)

**Files:** `apps/web/src/server/wizard.ts:132-217` (`previewHtml` appends `themeStyleTag(themeCss(profile.theme, theme_vars))` at the end of head).
- [ ] Tests: `preview carries the draft theme block`; `preview without theme is unchanged`.
- [ ] Commit `feat(web): wizard preview shows brand colors (FUS-381)`.

### Task C4: first install carries the theme

**Files:** `workers/factory/src/receipt.ts` (`deriveAuthoritativeRuntime` or install step adds `theme: profile?.theme ?? null` to `initial_runtime`), `workers/factory/src/workflows/install.ts`.
- [ ] Tests: `install sends the draft theme in initial_runtime`; `install without theme sends null`.
- [ ] Commit `feat(factory): first install writes the brand theme (FUS-381)`.

### Task C5: Settings

**Files:** `apps/web/src/client/screens/SettingsEditor.tsx:94-151`, `apps/web/src/client/settings-draft.ts`.
- [ ] Tests: `settings shows the stored theme`; `save sends theme with expected_updated_at`; `reset sends theme null`; `409 keeps the edited colors`.
- [ ] Commit `feat(web): brand colors in Settings (FUS-381)`.
