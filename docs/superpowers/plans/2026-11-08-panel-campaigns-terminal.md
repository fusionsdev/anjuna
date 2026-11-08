# T13 Implementation Plan: ad spend allocation, campaigns, AdKit Terminal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Google Ads spend between brands that share an account, let the owner create and enable Search campaigns from the panel under a baht cap, add an owner-only AdKit Terminal, and expose it through `/api/v1/ads`.

**Architecture:** Core owns the allocation logic (pure function plus D1 tables). The VPS `spend-sync.mjs` stays thin: it sends campaign level cost rows, core maps campaigns to brands and writes `ad_spend`. Campaign, Terminal and API actions are `adkit_jobs` rows (T9 queue) run by `adkit-executor.mjs` on the VPS. Workers never call AdKit.

**Tech Stack:** Bun workspaces, TypeScript strict, zod contracts, D1 migrations, Vitest (jsdom UI, Miniflare workers), plain Node 20 scripts on the VPS.

**Spec:** `docs/superpowers/specs/2026-11-08-panel-campaigns-terminal-design.md`

## Global Constraints

- One task = one branch = one PR from `main`. Done = task tests plus `bun run typecheck` and `bun run test` green. Never stage `AGENTS.md`; stage files by path.
- No deploy, no real AdKit write, no VPS contact in tests. AdKit tests use fixtures with an empty `PATH`.
- Money: cost is stored in the account currency. A sum never crosses currencies. Parts of a split add up to the whole to the smallest unit (2 decimals).
- Owner only: Terminal, campaign enable, caps, allocation settings. Enforce on the server (`apps/web/src/server/panel-roles.ts`), never only in the UI.
- Caps: `ads_cap_total_thb_day = 3000` and `ads_cap_brand_thb_day = 3000` by default, editable by the owner.
- Next free leads-db migration is 0022 (0021 is reserved by the open T12 PR 174). Next factory-db number: check `packages/factory-db/migrations`.
- No response may vary by user agent, IP or referrer. UI copy Thai, light theme tokens as in the 2026-11-07 plan.

## Review Focus

1. Brand parts of a split not summing to the account cost (expected: exact to 2 decimals for any weights, including zero clicks on every brand).
2. A campaign seen on two brands being given to one of them (expected: stays unmapped).
3. A brand cap above the total cap or a budget above either cap being enabled (expected: refused at draft and again at enable).
4. A job retried by the VPS creating a second campaign (expected: one, same idempotency key).
5. An employee reaching the Terminal, enable, caps or allocation routes (expected: 403 from the server).
6. A Terminal line that is not on the allowlist (expected: refused before a job row exists).

---

### Task 1: Allocation in core (PR A1)

**Files:**
- Create: `packages/leads-db/migrations/0022_spend_allocation.sql`, `workers/core/src/spend-allocation.ts`, `workers/core/test/spend-allocation.test.ts`
- Modify: `packages/contracts/src/spend.ts`, `workers/core/src/spend.ts`, `workers/core/src/index.ts` (route)
- Test: `workers/core/test/spend-allocation.test.ts`, `workers/core/test/spend.test.ts`

**Interfaces:**
- Produces tables: `campaign_brand_map(account, campaign_id, brand_id, source CHECK IN ('create','click','manual'), first_seen, updated_at, PRIMARY KEY (account, campaign_id))`; `ad_spend_unallocated(account, date, hour, cost, currency, updated_at, PRIMARY KEY (account, date, COALESCE(hour,-1), currency))`; `ALTER TABLE ad_spend ADD COLUMN allocation TEXT NOT NULL DEFAULT 'exact' CHECK (allocation IN ('exact','estimated'))`; settings key `ads_allocation_mode` (`estimated` default, `exact_only`).
- Produces: `splitCost(cost: number, weights: number[]): number[]` (largest remainder, 2 decimals, equal split when all weights are 0).
- Produces: `allocateSpend(input: { campaigns: { campaign_id: string; cost: number; clicks: number; impressions: number }[]; map: ReadonlyMap<string, string>; brandClicks: Readonly<Record<string, number>>; mode: "estimated" | "exact_only" }): { rows: { brand_id: string; cost: number; clicks: number; impressions: number; allocation: "exact" | "estimated" }[]; unallocated: number }`.
- Produces: `deriveCampaignMap(db: D1Database, now?: Date): Promise<number>` writing `source = 'click'` rows for campaigns seen on at least 3 clicks of exactly one brand; never overwrites `create` or `manual`.
- Produces route `POST /api/spend/campaign-ingest` (drain token, header only), body `{ account: string; currency: "THB" | "USD"; rows: { date: string; hour?: number | null; campaign_id: string; cost: number; clicks: number; impressions: number }[] }`.
- Consumes: `brand_runtime.google_ads_account` to list the brands of an account; `clicks.utm_campaign`, `clicks.brand`.

- [ ] **Step 1: Failing tests** in `spend-allocation.test.ts`: `splitCost(100, [3, 1])` is `[75, 25]`; `splitCost(0.10, [1, 1, 1])` sums to `0.1`; `splitCost(5, [0, 0])` is `[2.5, 2.5]`; `allocateSpend` gives a mapped campaign `exact` and an unmapped one `estimated` 3 to 1 across two brands with 3 and 1 clicks; `exact_only` returns the unmapped cost in `unallocated` and no brand row; a property test over 200 random inputs asserts `sum(rows.cost) + unallocated === sum(campaign cost)` to 2 decimals; `deriveCampaignMap` ignores a campaign seen on two brands and keeps a `manual` row.
- [ ] **Step 2: Run** `cd workers/core && bunx vitest run test/spend-allocation.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the migration and the pure functions. Weights are `brandClicks`; if the account has no brand clicks in the hour use the 24 hour clicks, then equal.
- [ ] **Step 4: Implement the route** in `spend.ts` (`handleCampaignSpendIngest`): validate with a new `CampaignSpendIngestRequest` in contracts, load map and clicks, call `allocateSpend`, upsert `ad_spend` with `allocation` and `ad_spend_unallocated`. Test: same hour posted twice leaves the same rows; PetVetPay and BisonCash fixture sums to the posted cost.
- [ ] **Step 5: Run** `bun run typecheck && bun run test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(core): split account spend between brands (campaign map, estimate fallback)`.

### Task 2: VPS campaign level sync (PR A2)

**Files:**
- Modify: `scripts/drain/spend-sync.mjs`, `scripts/drain/README.md`
- Create: `scripts/test/fixtures/adkit-campaign-results-hour.txt`
- Test: `scripts/test/drain-spend-sync.test.ts`

**Interfaces:**
- Consumes: `POST /api/spend/campaign-ingest` (Task 1). Produces: `campaignResultsArgs(account: string, from: string, to: string, project?: string): string[]` returning `["manage","google","results","--account",a,"--level","campaigns","--breakdown","hour","--from",from,"--to",to,"--json", ...project]` and `campaignRowsFromAdkit(out: unknown): { campaign_id: string; date: string; hour: number | null; cost: number; clicks: number; impressions: number }[]`.

- [ ] **Step 1: Capture a real sample (read only, owner approved).** On maimax or hstgr run the call for one account and one date, mask account digits, save the shape as the fixture. Record which fields carry campaign id, date, hour, cost and currency in the PR body. If the shape differs from the signature above, adjust the signature and say so.
- [ ] **Step 2: Failing test:** an account shared by two brands calls the campaign path once per account and date (not once per brand), and a single-brand account keeps the existing account path; `--dry-run` posts nothing; a campaign without an id is skipped and counted.
- [ ] **Step 3: Implement.** Run `node scripts/drain/spend-sync.mjs --dry-run` against the fixture mode. Expected: the shared account prints campaign rows, 0 POSTs.
- [ ] **Step 4: Commit** `feat(drain): campaign level spend for accounts shared by several brands`. Deploy order after merge: core, panel, then this script (an old core rejects the new route with 404).

### Task 3: Panel marks, allocation tab, suffix (PR A3)

**Files:**
- Create: `apps/web/src/client/screens/AdAllocation.tsx`, `apps/web/test/ad-allocation.ui.test.tsx`
- Modify: `apps/web/src/client/final-url.ts`, `apps/web/src/client/screens/Home.tsx`, `apps/web/src/client/screens/BrandLifecycle.tsx`, `apps/web/src/server/index.ts`, `apps/web/src/server/panel-roles.ts` (role `adAllocation` owner), `workers/core/src/admin/alerts.ts` (verify path)
- Test: `apps/web/test/final-url.test.ts`, `apps/web/test/ad-allocation.ui.test.tsx`, `workers/core/test/alerts.test.ts`

**Interfaces:**
- Produces: `finalUrl(site: string | null): string | null` returning `${site}/?keyword={keyword}&utm_campaign={campaignid}` (braces literal).
- Produces admin routes `GET /admin/ad-allocation` (shared accounts, unmapped campaigns with 7 day cost, mode, unallocated total) and `PATCH /admin/ad-allocation/campaign` body `{ account, campaign_id, brand_id }` writing `source = 'manual'`; panel proxies `GET/PATCH /api/ad-allocation` owner only.
- Produces alert `ad_spend_unallocated` firing when estimated cost is above 20 percent of an account's 7 day cost.

- [ ] **Step 1: Failing tests.** `finalUrl("https://a.com")` equals `https://a.com/?keyword={keyword}&utm_campaign={campaignid}`; an estimated spend cell renders "~" with the title "ประมาณจากสัดส่วนคลิก"; an employee gets 403 on `/api/ad-allocation`; assigning a campaign changes the next read to `manual`; the alert fires at 21 percent and not at 20.
- [ ] **Step 2: Run, implement, run.** Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): estimated spend marks, allocation tab, campaignid in the Final URL suffix`.

### Task 4: Campaign jobs and caps in core (PR B1)

**Files:**
- Modify: `packages/contracts/src/adkit.ts`, `workers/core/src/adkit.ts`, `scripts/drain/adkit-executor.mjs`, `apps/web/src/server/settings.ts`
- Create: `workers/core/src/ads-caps.ts`, `workers/core/test/ads-caps.test.ts`
- Test: `workers/core/test/adkit.test.ts`, `scripts/test/adkit-executor.test.ts`

**Interfaces:**
- Produces: `checkBudget(input: { requested: number; capBrand: number; capTotal: number; enabledTotalToday: number; enabledBrandToday: number }): { ok: true } | { ok: false; reason: "brand_cap" | "total_cap" }` (baht per day).
- Produces job kinds `campaign.draft.create`, `campaign.update_budget`, `campaign.pause`, `campaign.enable` with payload `{ brand_id: string; account: string; project: string; name: string; daily_budget: number; bid_strategy: "maximize_conversions" | "maximize_clicks"; geo: { country: string } | { city_code: string }; keywords: string[]; final_url: string }` (draft) and `{ campaign_id: string }` (others). Idempotency key `sha256(kind|brand_id|account|name)`.
- Produces executor allowlist additions: `campaigns create` without `publish` (draft only), `campaigns update` with `status` only for `campaign.enable` and `campaign.pause`.

- [ ] **Step 1: Failing tests.** `checkBudget` refuses 3001 against caps 3000; refuses when `enabledTotalToday + requested` passes the total cap; a draft job above the brand cap is rejected with 422 before a row exists; `campaign.enable` by an employee key is 403; two posts with the same name give one job; the executor rejects `campaigns create --publish` and `campaigns delete`.
- [ ] **Step 2: Run, implement, run.** On a successful draft job core writes `campaign_brand_map` (`source = 'create'`). Expected: PASS.
- [ ] **Step 3: Commit** `feat(core): campaign draft and enable jobs with baht caps`.

### Task 5: Campaigns screen (PR B2)

**Files:**
- Create: `apps/web/src/client/screens/Campaigns.tsx`, `apps/web/src/client/screens/Campaigns.css`, `apps/web/test/campaigns.ui.test.tsx`
- Modify: `apps/web/src/client/router.ts` (`campaigns`), `apps/web/src/client/nav-groups.ts`, `apps/web/src/server/index.ts`, `apps/web/src/server/panel-roles.ts`

**Interfaces:**
- Consumes: Task 4 jobs. Produces routes `GET /api/ads/campaigns`, `POST /api/ads/campaigns/draft`, `POST /api/ads/campaigns/:id/enable` (owner), `POST /api/ads/campaigns/:id/pause`.

- [ ] **Step 1: Failing tests.** The enable dialog text contains brand name, domain, budget, geo, account and the cap left; an employee sees the list and the draft form, no enable button; a budget above the cap disables the submit with the Thai reason.
- [ ] **Step 2: Run, implement from the "แคมเปญ (V2)" canvas page, run.** Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): campaigns screen`.

### Task 6: AdKit Terminal (PR C)

**Files:**
- Create: `apps/web/src/client/screens/AdkitTerminal.tsx`, `apps/web/test/adkit-terminal.ui.test.tsx`, `workers/core/src/adkit-terminal.ts`
- Modify: `apps/web/src/client/router.ts`, `apps/web/src/client/nav-groups.ts`, `apps/web/src/server/index.ts`

**Interfaces:**
- Produces: `parseTerminalLine(line: string, mode: "read" | "draft" | "publish"): { ok: true; argv: string[]; mode: string } | { ok: false; reason: string }` reusing the executor's allowlist module so panel and VPS agree. Route `POST /api/adkit/terminal` (owner) creating a `terminal.run` job; `GET /api/adkit/jobs/:id` for the result (output cut at 20 KB, click ids and tokens masked).

- [ ] **Step 1: Failing tests.** `parseTerminalLine("manage google accounts list", "read")` is ok; `"manage google campaigns create ..."` in `read` mode is refused with "สลับเป็นโหมดร่าง"; `"rm -rf /"`, `"manage google platform-api-request ..."` and a line with `;`, `&&`, a pipe or a backtick are refused; an employee gets 403; the result view polls every 3 seconds and stops at 2 minutes.
- [ ] **Step 2: Run, implement, run.** Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): AdKit Terminal (allowlisted jobs, owner only)`.

### Task 7: `/api/v1/ads` (PR D)

**Files:**
- Modify: `apps/web/src/server/api-v1.ts`, `packages/factory-db` (key scopes if stored as an enum), `apps/web/test/api-v1.test.ts`

**Interfaces:**
- Produces `GET /api/v1/ads/campaigns`, `POST /api/v1/ads/campaigns` (draft), `POST /api/v1/ads/campaigns/{id}/budget`, `GET /api/v1/ads/spend?brand=&from=&to=` (each row has `allocation`). Scopes `ads:read`, `ads:draft`; `ads:enable` exists but is never granted by default.

- [ ] **Step 1: Failing tests.** A key without `ads:draft` gets 403 on POST; a key with `ads:draft` cannot enable; `spend` returns `allocation` per row and never the USD profit to a non-owner key.
- [ ] **Step 2: Run, implement, run.** Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): /api/v1/ads`.

---

## Self-review

- Spec coverage: allocation (T1 to T3), campaigns (T4, T5), Terminal (T6), API (T7), owner decisions as constants (Global Constraints), Final URL suffix (T3), VPS path (T2).
- Order and deploy: T1 core, T3 panel, T2 VPS script last; T4 core before T5 panel. The Final URL suffix write into Google Ads (decision 2) runs as a Terminal job after T6, not in code.
- Unverified: the shape of `results --level campaigns --breakdown hour` (Task 2 step 1 captures it first), the alerts file path (Task 3), the factory-db migration number (check before Task 7 if key scopes need a column).
