# Brand colors: primary + secondary (FUS-381)

Owner request 2026-10-25. Each brand picks 2 colors, primary and secondary. The hover shade derives from primary. The picker lives in the wizard Template step and in Settings.

Linear: FUS-381. Source plan: `H:/w/anjuna-wt/_briefs/FUS-381/plan.md` (owner approved 2026-10-25).

## 1. Problem

No color field exists on main (8d63efb). Templates ship as prebuilt dist zips, so a color cannot be set at build time. Every template names its CSS variables differently. demo14.aduplift.ai (Astro + Tailwind v4, imported from bolt.new) declares `--color-royal: #2563eb` and `--color-royal-dark: #1d4ed8`, and its buttons use `bg-royal`. The Astro starter declares `--accent: #1f7a4d`.

## 2. Design

The brand Worker overrides the template's CSS variables at serve time. It appends one style element at the end of `<head>`:

```html
<style id="brand-theme">:root{--color-royal:#0f766e;--color-royal-dark:#0d6861;--color-ink:#1e293b}</style>
```

- The block depends only on brand settings. Every visitor gets the same bytes (AGENTS.md rule 3).
- A Settings save applies within the 60 second settings TTL. No redeploy.
- Tailwind v4 puts its variables in `@layer theme`. An unlayered `:root` rule beats any layered rule, and source order beats an earlier unlayered `:root` rule of equal specificity. The block therefore wins in both template styles.

### 2.1 Roles and variable map

- `theme` (per brand): `{ primary: "#rrggbb", secondary: "#rrggbb" }`. Both required when present. Null or absent means the template's own colors.
- `theme_vars` (per template version): `{ primary: string[], primary_dark: string[], secondary: string[] }`. Each entry is a CSS custom property name, `^--[a-z0-9-]{1,64}$`, brand clean, at most 8 names per role.
- `primary_dark` gets `darkenHex(primary)`: each RGB channel times 0.88, rounded. `#2563eb` gives `#2157cf`.
- No theme, or no mapped variable in any role, means nothing is injected. The served bytes then equal today's bytes.

### 2.2 Validation

- `HexColor` is `^#[0-9a-f]{6}$` after lowercasing a `#rrggbb` input. Short hex, names, `rgb()` and anything else fail.
- Contracts validate every theme value (draft profile, PATCH body, RPC response, initial runtime).
- `themeCss` validates the theme and every variable name again and returns null on any failure. No unvalidated byte reaches CSS.
- Core serves a stored `theme_json` that no longer parses as null (template colors), never as a 503. This matches `validOrNull` for site text.

### 2.3 Data flow

| Step | Where | What |
|---|---|---|
| Template import | `workers/template-mcp` | Detect candidate variables in the dist CSS, guess the map, store `template_versions.theme_vars_json` (factory migration 0010). |
| Template Approve | panel Templates screen | Show the guess. Admin corrects it before approving. |
| Draft | wizard Template step | `BrandProfile.theme` saved in the draft's `config_json.profile`. Preview applies the same `themeCss`. |
| Revision config | `apps/web/src/server/lifecycle.ts`, factory upgrade-all | `config_json.theme_vars` copied from the template version, the same way `text_defaults` is copied today (`withThemeVars`). |
| First install | factory install, core lifecycle | `initial_runtime.theme` = draft `profile.theme`. Core writes it to `brand_runtime.theme_json` on INSERT only. A later install never overwrites it. |
| Live edits | Settings | `patchBrand({ theme })` with `expected_updated_at`. Null resets to the template colors. |
| Serve | brand-runtime | `theme` from core live settings, `theme_vars` from the baked `BRAND_CONFIG`. `themeCss` result appended to `<head>`. |

`brand_runtime.theme_json` is the one live source of truth. Settings shows it.

### 2.4 Core RPC compatibility

`BrandSettingsResponse` is strict, so an old brand Worker fails on an unknown key. Core adds `theme` only when the request sets `include_theme: true`, the same way it handles `include_site_text`. A new brand Worker asks with both flags. A 400 (old core) falls back to `include_site_text` only, then to the bare request, as today.

When core is unreachable the Worker serves its `BRAND_CONFIG` fallback. That fallback carries no theme, so the page shows template colors. Site text behaves the same way today.

### 2.5 Pages that get the block

The index page and the 4 legal pages (`/privacy`, `/terms`, `/disclosures`, `/do-not-sell`). These are template pages and share the template CSS. The lead form (`/_f/index.html`) is the shared form app with its own variables. It gets no block in this feature (follow-up). A page with no `<head>` element gets no block.

## 3. Template variable detection

Input: every `.css` file in the dist zip plus `<style>` elements in `index.html`.

1. Candidates: custom properties declared with a 3 or 6 digit hex value. Names that contain `gray`, `grey`, `slate`, `zinc`, `neutral`, `stone`, `white` or `black` are dropped.
2. Primary: the candidate with the most `var(--name)` uses inside `background` or `background-color` declarations. Ties go to the first declared. No use means no primary.
3. Primary dark: a declared candidate named `<primary>-dark`, else `<primary>-hover`. None means an empty list.
4. Secondary: among the rest, the candidate with the most `var(--name)` uses inside `color` declarations. None means an empty list.
5. The result is a `TemplateThemeVars` with one name or none per role. The admin can add names on Approve.

Fixture: demo14's CSS. Expected: `primary: ["--color-royal"]`, `primary_dark: ["--color-royal-dark"]`. The starter's `--accent` is the primary of its own fixture.

## 4. Panel UI

- `ColorPair` component: 2 rows (primary, secondary). Each row has `<input type="color">` and a hex text field kept in sync, plus "ใช้สีของเทมเพลต (Use template colors)" which sets the value to null.
- Wizard Template step: `ColorPair` below the template picker. The draft saves `profile.theme`. The preview iframe reloads with the draft colors and the template version's `theme_vars`. A template with no mapped variable shows "เทมเพลตนี้ยังไม่รองรับการเปลี่ยนสี (This template has no color variables)" and disables the pickers.
- Settings: `ColorPair` in `SettingsEditor`. Save goes through the existing `patchBrand` with `expected_updated_at`.
- Templates Approve screen: the detected map per role, editable as a list of variable names, saved before Approve.

## 5. Rollout

Migrations ship as files only: core `packages/leads-db/migrations/0016_brand_theme.sql` and factory `packages/factory-db/migrations/0010_template_theme_vars.sql` (next free numbers on main 8d63efb). No deploy and no remote D1 in this lane. The owner deploys once after Spec 7: migrations, core, anjuna-web, then brand-runtime.

## 6. PRs

1. PR A `fus-381-brand-colors`: this spec and plan, contracts, core column and RPC/admin/lifecycle, brand-runtime injection.
2. PR B `fus-381b-template-theme-vars`: detection, factory 0010, `withThemeVars` bake, Approve mapping UI.
3. PR C `fus-381c-color-picker`: `ColorPair`, wizard step and preview, install `initial_runtime.theme`, Settings.

B and C start after A merges. C's preview task needs B's column and waits for B.

## 7. Acceptance (Linear FUS-381)

- A brand with a theme serves the style block at the end of `<head>` with the mapped variables set. A brand without a theme serves bytes identical to today.
- An invalid hex is rejected by the contract and by the runtime.
- Import detects `--color-royal` on the demo14 CSS fixture.
- The wizard preview and a Settings save show the chosen colors.
- `bun run typecheck` and `bun run test` green. No deploy, no remote D1.

## 8. Out of scope

- Lead form colors (`/_f/`).
- More than 2 brand colors, gradients, fonts.
- Colors in the core-outage fallback.
