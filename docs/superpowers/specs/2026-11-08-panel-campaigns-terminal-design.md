# T13: ad spend allocation, campaigns and AdKit Terminal

Date: 2026-11-08. Owner: Kittipong. Builds on `2026-11-07-panel-redesign-design.md` and ADR 0005 (panel writes jobs, the VPS runs `adkit`, Workers hold no AdKit key). Visual reference: the canvas pages "แคมเปญ (V2)" and "AdKit Terminal" in https://claude.ai/artifact/JWFPvnaaMfBkMS1M54XAdU.

## Problems

1. Two brands can share one Google Ads account (production: PetVetPay and BisonCash on account 5381163935). `spend-sync.mjs` reads account level spend, so it gives the spend to the first brand and skips the others ("would count twice"). The second brand shows "—" and the first one carries a cost that is not only its own. Profit and cost per lead per brand are wrong for every shared account.
2. Campaigns are created outside the panel. The panel cannot say which brand a campaign belongs to.
3. There is no controlled way to run an `adkit` command from the panel.

## Part A: split ad spend between brands on one account

Rule: the spend of every account is split so that the brand rows add up to the account total, no cent lost, none counted twice.

### A1. Which brand owns a campaign (exact)

- New table `campaign_brand_map(account TEXT, campaign_id TEXT, brand_id TEXT, source TEXT CHECK (source IN ('create','click','manual')), first_seen TEXT, updated_at TEXT, PRIMARY KEY (account, campaign_id))`.
- `source = create`: the panel created the campaign for that brand (Part B), so it is known.
- `source = click`: core already stores `utm_campaign` on every click (`workers/core/src/rpc/clicks.ts`). The Final URL suffix of every brand becomes `?keyword={keyword}&utm_campaign={campaignid}` (Google substitutes `{campaignid}`). Core derives the map: a campaign id seen on at least 3 clicks of one brand, and on no other brand, maps to that brand. A campaign seen on two brands stays unmapped and is reported.
- `source = manual`: the owner assigns an unmapped campaign in the panel (Settings, tab "จัดสรรค่าโฆษณา"). Manual wins over click.
- Precondition for `click`: the Final URL suffix on the Google Ads campaigns or account must carry `utm_campaign={campaignid}`. The panel's "Copy Final URL" action (`apps/web/src/client/final-url.ts`) gains it. Changing the suffix inside Google Ads is an owner action, or a job in Part C. Until then rows fall to A2.

### A2. Cost by campaign, with an estimate as fallback

- `spend-sync.mjs` asks AdKit for `adkit manage google results --account <a> --level campaigns --breakdown hour --from <d> --to <d> --json` (supported: hour breakdown at campaign level). One call per account and date instead of one per brand.
- A campaign with a map row: its cost goes to that brand, `allocation = 'exact'`.
- A campaign without one: its cost is split across the brands on that account in proportion to their paid clicks in the same hour (`clicks` rows with a click id). No clicks in that hour: proportion of the 24 hour clicks, then equal split. `allocation = 'estimated'`. Setting `ads_allocation_mode` (`estimated` default, `exact_only`): in `exact_only` the unmapped cost goes to `ad_spend_unallocated` and no brand gets it.
- Rounding uses largest remainder on the smallest currency unit (satang), so the parts sum to the cost exactly.
- Schema (leads-db migration, next free number after 0021): `ALTER TABLE ad_spend ADD COLUMN allocation TEXT NOT NULL DEFAULT 'exact' CHECK (allocation IN ('exact','estimated'))`, plus `ad_spend_unallocated(account TEXT, date TEXT, hour INTEGER, cost REAL, currency TEXT, updated_at TEXT, PRIMARY KEY (account, date, COALESCE(hour,-1)))`. The existing unique key `(brand_id, date, hour, source)` stays, so a rerun overwrites.
- Backfill: after deploy run `spend-sync.mjs --from <30 days ago>` once. It is idempotent.
- Brands that are alone on their account behave as today: all spend is exact.

### A3. What the panel shows

- Brand rows and Home: an estimated number carries a "~" and the tooltip "ประมาณจากสัดส่วนคลิก". Exact numbers carry nothing. Account totals on Home add exact and estimated parts and are never rounded differently from the sum of the rows.
- Settings, tab "จัดสรรค่าโฆษณา" (owner): list of accounts shared by more than one brand, the unmapped campaigns with 7 day cost, a select to assign each to a brand, the current mode, and `ad_spend_unallocated` total.
- Alert rule "ค่าโฆษณายังไม่จัดสรร" when the estimated share of an account is above 20 percent of its 7 day cost.

### A4. Tests that pin Part A

- Property test: for any set of campaigns, brands and click counts, the brand parts add up to the account cost to the satang.
- A mapped campaign never gets estimated parts. An unmapped campaign across PetVetPay and BisonCash with 3 and 1 clicks gives a 3 to 1 split.
- A brand with zero clicks gets 0, never NaN. Zero clicks on every brand gives an equal split.
- A campaign seen on two brands stays unmapped. Manual assignment overrides a click mapping.
- `exact_only` writes the unallocated table and no brand row.
- Re-running the same hour twice leaves the same rows.

## Part B: campaigns from the panel (V2)

- Scope v1: Google Search only, one daily budget, geo country or city, bid strategy `maximize_conversions` or `maximize_clicks`, keywords, Final URL with the suffix from A1. No Performance Max, no keyword research, no creative generation.
- Jobs on the T9 job queue (`adkit_jobs`): `campaign.draft.create`, `campaign.update_budget`, `campaign.pause`, `campaign.enable`. A draft is sent to AdKit with `publish` absent (AdKit keeps it as a draft). `campaign.enable` is the only job that spends money: owner only, or a key with scope `ads:enable` that the owner issued.
- Every job has an idempotency key `sha256(kind, brand, account, name)`. The campaign name carries the brand id (`<brand_slug>-search-<n>`), and the map row (`source = create`) is written when the draft job succeeds.
- Caps: settings `ads_cap_total_thb_day` and `ads_cap_brand_thb_day`. A budget above a cap is refused when the draft is made and again when it is enabled. Currency of budgets is the account currency, shown in baht.
- Screen: the mock "แคมเปญ (V2)". The enable dialog shows brand, domain, budget, geo, account and the cap left.

## Part C: AdKit Terminal (owner)

- Not a shell. A page that sends one `adkit manage ...` line as a job and shows the result when the VPS reports it (polling every 3 seconds, up to 2 minutes).
- Modes: read only (`accounts list`, `conversions list`, `results list`, `campaigns list`), draft (`campaigns create` without publish), publish (`conversions create`, `campaigns update status`) with a confirm dialog that shows the parsed payload.
- Parsed by the same argument checker as `adkit-executor.mjs` (allowlist, 162 malformed argv probes already tested). Anything outside it is refused before a job exists.
- Output is cut at 20 KB, click ids and tokens are masked, every run is an `adkit_jobs` row and an audit row with the requester.

## Part D: API additions

`/api/v1/ads/campaigns` (list, create draft), `/api/v1/ads/campaigns/{id}/budget`, `/api/v1/ads/spend?brand=&from=&to=` (with `allocation` per row). Scopes `ads:read`, `ads:draft`. `ads:enable` is never granted by default. A key without a scope gets 403.

## Out of scope

Performance Max, keyword research, creative generation, Microsoft Ads, automatic budget optimisation, splitting spend inside one campaign across brands (a campaign belongs to one brand).

## Decisions (owner, 2026-11-08)

1. Default `ads_allocation_mode` is `estimated`. Every brand always has a number, marked "~" while its campaigns are unmapped.
2. Yes: add `utm_campaign={campaignid}` to the account level Final URL suffix of the two Google Ads accounts. It is an AdKit write, done as a Part C job after the first AdKit write is approved by the owner in the panel.
3. Caps: 3,000 baht. Applied as `ads_cap_total_thb_day = 3000` and `ads_cap_brand_thb_day = 3000` (a brand cap above the total cap is refused). Both are editable by the owner in Settings. A cap limits what can be enabled, it is not a spend target. To be confirmed by the owner if a lower per brand cap is wanted.
4. Yes: Terminal and campaign enable are owner only. Employees get read only mode.

## Facts to verify while building

- `results --level campaigns --breakdown hour` returns a campaign id per row and the account currency (check with one real call on the VPS before coding).
- `{campaignid}` is substituted in the account Final URL suffix for Search campaigns (Google ValueTrack).
- Whether `ad_spend.source` needs a value for the campaign level path (today only `google`).

## PR slicing

1. A1 + A2 core side: migration, `allocateSpend()` pure function and tests, ingest route accepting `allocation`. No VPS change.
2. A2 VPS side: `spend-sync.mjs` campaign level, dry run, backfill.
3. A3: panel marks, Settings tab, alert rule, Final URL suffix.
4. B: campaign jobs and caps (core), then the Campaigns screen.
5. C: Terminal page.
6. D: `/api/v1/ads`.
Deploy order for 1 to 3: core, then panel, then the VPS script (an old core rejects the new `allocation` field).
