Export v9 (typography) from artifact 794b3be9
Export v8 (wizard 5 steps) from artifact 56c8ffeb
Export v7 (icons) from artifact f27b79ff, 2026-11-10

# Magic Patterns export: panel redesign 2026-11-10

Source: artifact `794b3be9-5fb8-4a20-9f30-ea289e51c3bc` (v9, full re-export of 56 files) on top of v8 (`56c8ffeb`, wizard) and v7 (`f27b79ff`, icons). 56 files, 2,558 lines, written verbatim. Missing files: none. v9 changed 13 files versus v8: index.css, tailwind.config.js, Chip, SourceChip, Card, PageHeader, Sidebar, KpiRow, FunnelStrip, ConversionQueueCard, WizardSummary, NewBrand, Traffic (TrackingStep changed one class, same byte size).

| File | Lines | Renders / contains |
|---|---:|---|
| index.tsx | 9 | React 18 root mount of `App` into `#root`, imports index.css |
| App.tsx | 39 | Page switch (10 PageIds), sidebar + mobile top bar, brand scope state, `lang="th"` shell, max width 1128px |
| package.json | 14 | Deps: react 18.3.1, react-router-dom 6.30.2, lucide-react 0.577.0, framer-motion, date-fns, tailwind-merge |
| index.css | 42 | v9: font imports, Tailwind layers, CSS tokens (sub #46464c, line #d9d9d4), body 15px/1.65, global table rules (th 13px semibold on canvas, 52px rows, zebra, hover), `.text-secondary`, `.table-head`, `.table-cell`, 28px `.num` overrides |
| tailwind.config.js | 22 | v9: Tailwind theme: canvas/ink, sub #46464C, line #D9D9D4, brand #F83808, ok/warn/bad/info pairs, `rounded-card` 16px, IBM Plex Sans Thai stack, fontSize body 15px and secondary 13px |
| types/app.ts | 68 | Types: PageId, Tone, StageStatus, BrandState, BrandScope, ChecklistStep, Brand, Template, Category |
| utils/format.ts | 7 | `thb()` and `num()` formatters, null renders as em dash |
| utils/brandScope.ts | 34 | Default scope, `isBrandInScope`, legacy alias map (aurum, skratch, vetcare, lending, deercreek), `scopeSummary` text |
| data/navigation.ts | 23 | 9 nav items with lucide icons, badges (brands 3, templates 4, alerts 2), owner tag on AdKit Terminal |
| data/brands.ts | 227 | 7 stage labels, 5 home brand ids, 27 mock brands (9 explicit, 12 generated active, 6 retired) with checklist and AdKit metrics |
| data/home.ts | 38 | Home mock data: 4 fix items, 4 human tasks, 5 KPIs, 5 funnel steps, 4 conversion queue stats |
| data/templates.ts | 29 | 6 categories, 3 status filters, 10 mock templates |
| data/wizard.ts | 25 | 5 wizard step labels, 3 AdKit projects, 2 Ads accounts, 2 existing conversion actions, 5 API endpoints |
| data/operations.ts | 116 | Mock data for campaigns, traffic rows, web errors, leads, conversions, alerts, alert rules, AdKit jobs, settings sections, trend buckets, breakdowns, bot rows, live sessions, recent events |
| data/icons.ts | 6 | New in v7: lucide icon maps `eventTypeIcon` (7), `kpiIcon` (14), `ruleIcon` (8), `sectionIcon` (18); imports Bug and Radio unused |
| components/ui/Icon.tsx | 28 | New in v7: `Icon` wrapper for lucide icons, sizes text/nav/banner (16/18/20px), tones sub/brand/current, `aria-hidden` |
| components/ui/Button.tsx | 6 | Button, 4 variants (primary, secondary, ghost, danger), 2 sizes, min height 44px |
| components/ui/Chip.tsx | 28 | v9: pill chip in 6 tones at 13px with leading-none, optional dot, optional lucide `icon` at 14px |
| components/ui/SourceChip.tsx | 3 | v9: one-line data-source label, 13px, Database icon 14px |
| components/ui/Card.tsx | 7 | v9: white card with 1px shadow, header px-6 py-4 with 3px brand bar before an 18px title, source chip pushed right, body default p-6 |
| components/ui/PageHeader.tsx | 17 | v9: h1 28px semibold tracking -0.01em, subtitle 15px, right-side actions, optional 40px brand-tint icon square |
| components/ui/ScopeSubtitle.tsx | 8 | Subtitle text plus scope summary chip and "แก้ไข" button |
| components/layout/Sidebar.tsx | 14 | v9: 232px sidebar, nav items 15px (active semibold), Icon nav size, dividers before traffic and adkit, user footer (fern@aduplift.ai, Owner); drawer on mobile |
| components/layout/MobileTopBar.tsx | 8 | Sticky 56px bar below lg: menu button, logo, compact BrandScopeControl |
| components/layout/BrandScopeControl.tsx | 45 | Scope popover: hide unused toggle, show test toggle, search, grouped brand checkboxes by state, clear and apply |
| components/brands/StageDots.tsx | 28 | 7 stage dots (done, warn, fail, pending) with aria label |
| components/brands/RowMenu.tsx | 64 | Row kebab menu: open site, edit, view leads, pause (danger); closes on outside click and Escape |
| components/brands/BrandTable.tsx | 12 | Brand table (desktop) and card list (mobile): name, stage dots, spend, leads, CPL, Ads chip, action button, optional menu; test brands get FlaskConical chip |
| components/brands/BrandDetailPanel.tsx | 15 | Sticky detail card: header with state chip, 4-step setup checklist with per-step icons (Globe, Webhook, BadgeCheck, Route) and fix buttons, read-only AdKit metrics grid |
| components/home/IncidentBanner.tsx | 29 | Warning banner: 4 failed conversions, 3 leads pending over 24h, buttons to queue and alerts |
| components/home/FixListCard.tsx | 57 | "ต้องแก้" list of 4 fix items with action buttons; retry shows spinner 1.6s |
| components/home/HumanTasksCard.tsx | 36 | 4 human task rows with counts, each navigates to a page |
| components/home/KpiRow.tsx | 12 | v9: 5 KPI cards (p-5, shadow) with 13px labels and 28px values; icons Coins, Users, Calculator, BadgeCheck, TrendingUp; owner tag on revenue/profit |
| components/home/FunnelStrip.tsx | 8 | v9: 5-step funnel, 13px labels, 28px values, bars and step-to-step percentages |
| components/home/ConversionQueueCard.tsx | 47 | v9: 4 queue stats at 28px and a 13px reconciliation line (19 sold = 15 sent + 4 failed + 0 queued) |
| components/wizard/WizardStepper.tsx | 10 | v8: 5-step pill stepper with step icons; done steps are buttons that call `onStepClick`, active step has `aria-current` |
| components/wizard/SelectField.tsx | 37 | Labeled native select with chevron and hint |
| components/wizard/TrackingStep.tsx | 104 | Wizard step 4 (v9 space-y-6): AdKit project and Ads account selects, currency lock, conversion action radio cards (new vs existing) |
| components/wizard/WizardSummary.tsx | 44 | v9: sticky summary checklist (13px values) plus "สร้างผ่าน API" list of 5 endpoints |
| components/wizard/BrandInfoStep.tsx | 26 | Wizard step 1 form: name, domain, keywords, phone, email, address |
| components/wizard/TemplateStep.tsx | 26 | Wizard step 2: pick from 6 approved templates, choose 1 of 4 color pairs |
| components/wizard/DomainStep.tsx | 15 | Wizard step 3: DNS zone check card, A record and SSL tiles, recheck button |
| components/templates/CategoryList.tsx | 44 | Category nav with counts, archive divider, "เพิ่มหมวด" button on lg |
| components/templates/TemplateThumb.tsx | 12 | 64x48 placeholder thumbnail with brand color block |
| components/templates/BulkBar.tsx | 59 | Dark bulk action bar: move to category, archive, delete (disabled when in use), clear |
| components/templates/TemplateTable.tsx | 24 | Template table (desktop) and list (mobile): checkbox, thumb, category select, status chip, version, brand count, action |
| pages/Home.tsx | 93 | Home with Home icon header: incident banner, fix list, human tasks, KPI row, funnel, conversion queue, brand table for 5 home brands |
| pages/Brands.tsx | 131 | Brands list with Store icon header, state tabs, BrandTable with row menus, BrandDetailPanel for the selected brand, create button |
| pages/NewBrand.tsx | 46 | v8+v9: 5-step wizard renders all steps (BrandInfoStep, TemplateStep, DomainStep, TrackingStep, ReviewStep), stepper click-back, save draft, 7-row summary, "สร้างเว็บไซต์" owner button; 28px h1, space-y-6 |
| pages/Templates.tsx | 169 | Templates with LayoutTemplate icon header: category list, status filter chips, bulk bar, TemplateTable with selection, approve action |
| pages/Campaigns.tsx | 66 | Campaign table (5 rows) with status chips, budget, keywords, final URL, job id and job log timeline; Megaphone header |
| pages/Traffic.tsx | 369 | v9 (reformatted, 28.5 KB): Traffic with tab icons: Google bots now, live sessions feed with StageChip/EventIcon/DeviceIcon helpers and Empty state, hourly/daily trend, breakdowns, bots 24h, recent events (200), per-brand traffic, web errors; 13/15px text, 28px KPI values |
| pages/Leads.tsx | 21 | Leads table with detail (timeline, email, phone) and conversion queue table; gclid chips use MousePointerClick/MousePointerBan |
| pages/Alerts.tsx | 30 | Alerts list (open/closed) with per-rule icons, 8 alert rule toggles, send history with Telegram chip |
| pages/AdkitTerminal.tsx | 29 | Owner-only AdKit job list with status chips and expandable log lines; Terminal header |
| pages/Settings.tsx | 32 | Settings sections with icon nav: general, Telegram, LINE, rules sent, daily summary, per-brand caps, users, email list, blocked emails, edit history, Builder keys |

Pages total 986 lines. After v8, `pages/NewBrand.tsx` imports all 7 wizard components.
