# Design export index: panel redesign

Exported reference design for the panel redesign (Wave 5, lane W02 owns
the implementation). Committed under `docs/design/magic-patterns-20261109/`
in full, 57 files (56 exported sources plus `INDEX.md`, ~230 KB).

**These are reference files, not built code.** Nothing in this folder is
imported by `apps/web`; do not copy it into source paths. The real
components live in `apps/web/src/client`. All implementing paths in this
README are planned per `PLAN.md` section D, lane W02, and are therefore
marked with the W02 task that owns them; they are relative to
`apps/web/src/client/` when not otherwise prefixed.

The exported copy under `docs/design/magic-patterns-20261109/` is also
**lint-exempt**: it is third-party reference source kept byte-for-byte as
exported, so it is excluded from markdown linting by the repo-root
`.markdownlint-cli2.jsonc` ignore list. Linting this README is still
expected.

## 1. State: screenshots missing

The export contains **zero screenshots** (0 PNG or any image files in the
folder). Acceptance E2 asks for screenshot pairs at 1280 and 375 px per
page attached to the implementing PRs. That checklist is pending the
owner (or a later lane) attaching renders; nothing in this repo can
produce them.

## 2. Pages: design file → implementing component

| Design page | Planned implementing path |
| --- | --- |
| pages/Home.tsx | screens/Home.tsx + screens/home/* (W02-2) |
| pages/Brands.tsx | screens/BrandLifecycle.tsx (W02-2) |
| pages/NewBrand.tsx | screens/BrandWizard.tsx + wizard/* (W02-2) |
| pages/Templates.tsx | screens/Templates.tsx (W02-3) |
| pages/Campaigns.tsx | screens/Campaigns.tsx (W02-3) |
| pages/Traffic.tsx | screens/Traffic.tsx + useTrafficTail hook (W02-4) |
| pages/Leads.tsx | screens/Leads.tsx + screens/Conversions.tsx (W02-3) |
| pages/Alerts.tsx | screens/Alerts.tsx (W02-3) |
| pages/AdkitTerminal.tsx | screens/AdkitTerminal.tsx (owner-only, W02-3) |
| pages/Settings.tsx | screens/Settings.tsx (W02-3) |

Expanded details for the pages whose design splits into parts:

- Home: `pages/Home.tsx` composes the banner, fix list, human tasks,
  KPI row, funnel and queue below; the page keeps
  `screens/Home.tsx` + `screens/home/`.
- NewBrand: the 5-step wizard keeps `screens/BrandWizard.tsx` for the
  page shell and `wizard/StepPanels.tsx` (+ `wizard/steps.ts`) for the
  steps; the design steps map to wizard rows in section 3.
- Traffic: the real-time tab additionally uses the `useTrafficTail`
  hook (port of the SSE client, W02-4); the design's dataset is mock.
- Leads: detail drawer is `screens/LeadDetail.tsx`; conversion queue
  numbers come from `home-metrics.ts`, not the design mock.

## 3. Shared components: design file → implementing component

| Design file | Planned implementing path |
| --- | --- |
| home/IncidentBanner.tsx | screens/home/IncidentBanner.tsx (W02-2) |
| home/FixListCard.tsx | screens/home/NeedsFixList.tsx (W02-2) |
| home/HumanTasksCard.tsx | screens/home/HumanTasks.tsx (W02-2) |
| home/KpiRow.tsx | planned screens/home/KpiRow.tsx (W02-2) |
| home/FunnelStrip.tsx | screens/Funnel.tsx (W02-2) |
| home/ConversionQueueCard.tsx | screens/home/ConversionQueueCard.tsx (W02-2) |
| brands/BrandTable.tsx | screens/home/BrandRows.tsx + DataTable (W02-2) |
| brands/BrandDetailPanel.tsx | screens/BrandLifecycle.tsx detail card |
| brands/StageDots.tsx | components/StageDots.tsx + lifecycle-state.ts (W02-2) |
| brands/RowMenu.tsx | components/RowMenu.tsx restyle (W02-2) |
| ui/Button.tsx | planned components/Button.tsx (W02-1) |
| ui/Chip.tsx | planned components/Chip.tsx (W02-1) |
| ui/SourceChip.tsx | planned components/SourceChip.tsx (W02-1) |
| ui/Card.tsx | planned components/Card.tsx (W02-1) |
| ui/PageHeader.tsx | planned components/PageHeader.tsx (W02-1) |
| ui/ScopeSubtitle.tsx | planned components/ScopeSubtitle.tsx (W02-1) |
| ui/Icon.tsx | planned components/Icon.tsx, lucide-react (W02-1) |
| layout/Sidebar.tsx | components/SidebarNav.tsx restyle (W02-1) |
| layout/MobileTopBar.tsx | components/AppShell.tsx mobile bar (W02-1) |
| layout/BrandScopeControl.tsx | components/BrandScopeControl.tsx (W02-1) |
| wizard/WizardStepper.tsx | planned wizard/Stepper.tsx (W02-2) |
| wizard/BrandInfoStep.tsx | wizard/StepPanels.tsx + steps.ts (W02-2) |
| wizard/TemplateStep.tsx | wizard/StepPanels.tsx + steps.ts (W02-2) |
| wizard/DomainStep.tsx | wizard/StepPanels.tsx + steps.ts (W02-2) |
| wizard/TrackingStep.tsx | wizard/StepPanels.tsx + steps.ts (W02-2) |
| wizard/WizardSummary.tsx | wizard/StepPanels.tsx + steps.ts (W02-2) |
| wizard/SelectField.tsx | wizard/StepPanels.tsx field (W02-2) |
| templates/CategoryList.tsx | screens/TemplateCategories.tsx (W02-3) |
| templates/TemplateTable.tsx | screens/Templates.tsx (W02-3) |
| templates/TemplateThumb.tsx | screens/Templates.tsx thumbnail (W02-3) |
| templates/BulkBar.tsx | screens/Templates.tsx bulk bar (W02-3) |

Notes on grouped rows:

- The brand-scope popover (`layout/BrandScopeControl.tsx`) also adds
  the `useBrandScope` hook at client root (following the
  `useBrandActions.ts` convention); design-side logic sample is
  `utils/brandScope.ts`. Default scope hides paused/retired/demo and
  persists via `user_prefs` (acceptance E3).
- `SectionTabs` in the plan's W02-1 list corresponds to the design's
  page-level tabs (Traffic, Leads, Settings paging), not a separate
  export file; it is a restyle of the existing
  `components/SectionTabs.tsx`.

Top-level files:

| Design file | Panel counterpart |
| --- | --- |
| App.tsx | App.tsx + router.ts + AppShell.tsx |
| index.css | styles/tokens.css + styles.css (W02-1) |
| tailwind.config.js | styles/tokens.css (W02-1) |
| index.tsx | main.tsx |
| package.json | root package.json (real deps, not these) |

The export runs Tailwind; the panel implements the same values as plain
CSS custom properties in `styles/tokens.css` (W02-1). App.tsx in the
design is a hash-less demo switch; the panel keeps `router.ts`.

Reference-only files (committed for the spec, not implemented as-is):

- `types/app.ts` — demo-model types; the panel types derive from
  `packages/contracts` plus client types where the UI needs more.
- `utils/format.ts` — `thb()`/`num()` samples; formatting stays in the
  client's existing helpers.
- `utils/brandScope.ts` — logic sample named in the note above.
- `data/*.ts` — **mock data only.** Every brand, lead, campaign,
  traffic and alert number in the export is fabricated demo content; no
  real tenant, lead or spend data may enter this folder.

## 4. Tokens (from index.css and tailwind.config.js, v9)

Colours:

- Canvas `#F6F6F4` (background), card `#FFFFFF`, ink `#111111` (text),
  sub `#46464C` (secondary text), line `#D9D9D4` (borders and inputs).
- Brand `#F83808` (hover `#E03206`, tint `#FFE9E2`, tint text
  `#C42A03`); ring and chart-1 use brand.
- States: ok `#0E7A4F` on `#E6F5EE`; warn `#805000` on `#FFF3DC`;
  bad `#B42318` on `#FDECEA` (also `--destructive`); info `#244D91` on
  `#E8F0FC`.
- Chart scale: 1 `#F83808`, 2 `#0E7A4F`, 3 `#2F5DA8`, 4 `#805000`,
  5 `#46464C`.
- Light theme only (`color-scheme: light` per W02-1; dark values move
  to an unused `tokens.dark.css`).

Shape, type, and sizing:

- Radius: `--radius` 1rem; `rounded-card` 16px.
- Fonts: sans and heading stack = IBM Plex Sans Thai, Inter,
  system-ui, sans-serif; mono = IBM Plex Mono. index.css also carries
  managed Geist / Geist Mono `@import` lines, but the Tailwind stack —
  and so the implementation — resolves to the IBM Plex set (E2 checks
  Thai renders in IBM Plex Sans Thai).
- Sizes: body 15px/1.65, secondary text 13px/1.55; page-headline and
  KPI values 28px; table header 13px semibold, rows 52px, zebra plus
  hover; sidebar 232px; page content max width 1128px; mobile top bar
  56px; buttons min height 44px.
- Global table look: `.table-head` th on canvas background; `.num`
  overrides at 28px for headline numbers.

## 5. Provenance

- Source: Magic Patterns artifact `794b3be9-5fb8-4a20-9f30-ea289e51c3bc`
  (v9, typography pass) on top of v8 (wizard, `56c8ffeb`) and v7
  (icons, `f27b79ff`), exported 2026-11-10; written verbatim, 2,558
  lines. v9 changed 13 files versus v8 (see `INDEX.md`).
- Files land exactly as exported (`INDEX.md` carries the per-file
  line counts and contents); only this README and the folder are
  W03-authored. If W02 tests prove a design value wrong, fix the
  source of truth in a follow-up export, not in a stray edit here.
