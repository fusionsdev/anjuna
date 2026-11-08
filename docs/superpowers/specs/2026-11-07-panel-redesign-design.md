# Panel redesign: one-page brand flow with AdKit

Date: 2026-11-07. Owner: Kittipong. Visual reference (10 pages, light theme, accent `#F83808`): https://claude.ai/artifact/JWFPvnaaMfBkMS1M54XAdU

## Problem

1. The panel has 17 flat sidebar items. One brand's journey (create, template, deploy, domain, leads, sold, conversion upload, ad spend) is split across 8 of them.
2. Home shows `ad_spend.cost` with a "$" sign. The Google Ads accounts are all in THB, conversion values are in USD. Profit on Home (`−$12,271`) subtracts baht from dollars and is wrong by about 35 times.
3. 29 brands wait for "Test sold", 4 templates wait for approval. Each is a per-brand click today.
4. Step 4 of the new-brand wizard is four empty text fields (Google Ads account, conversion action, AdKit project, Microsoft account).
5. Templates cannot be deleted or grouped.

## Decisions (owner answered yes unless noted)

- Menu: Home, Brands, Templates, Traffic, Leads and conversions, Alerts, Settings. Later: Campaigns (V2), AdKit Terminal (owner).
- Home: incident banner, "needs fixing" list, "human tasks" list, 5 KPI tiles, brand rows with one state-based button, funnel strip, conversion queue. Default range today vs yesterday. Revenue and profit owner only, computed on the server.
- Four actions on Home through `ConfirmDialog`: confirm Test sold, approve template (owner), retry install, set drain route. The dialog names brand and domain.
- Click-loss warning shows only when "reached the site" is below 5 percent of paid clicks. Fixed in v1.
- Ad numbers per brand row show "—" when `ad_spend.updated_at` is older than 2 hours.
- Money: store the account currency. Show baht and dollars side by side. Profit and cost per lead in USD use a rate stored in settings (default 35 THB per USD).
- AdKit: Workers never hold an AdKit key. The VPS drain host runs `adkit`. The panel writes jobs to D1, the VPS executor claims them and posts results. Conversion actions are created with `--publish`. Campaigns are created as drafts and only an owner enables them. This replaces the non-goal at `docs/PRODUCT-BRIEF.md:46`, recorded in ADR 0005.
- Wizard step 4 has no free text. Project and account are selects filled from an AdKit directory that the VPS syncs hourly. The conversion action is created by a job. Microsoft Ads moves to settings (global, owner only).
- Every wizard field can be set through `/api/v1/*` with a scoped key. A key may create drafts. Only an owner or a key with scope `brand:generate` may run generate.
- Templates: categories stored apart from sealed rows. Hard delete only when no brand uses the template and it was never approved. Otherwise archive.
- Traffic gets a live strip (poll 15 s) and a Googlebot / AdsBot filter with an alert. Counting happens server side on the brand Worker as a log only. No response may vary by user agent.

## Out of scope

Campaign creation UI and AdKit Terminal (V2, separate spec). True real-time streaming. Verifying Googlebot by IP range. Rotating the leaked builder key (parked by owner).

## Facts to verify while building

- Which field of `adkit manage google results` carries currency, or whether it comes from `accounts list`.
- Why `/go` shows 0 while leads show 72 on production Home (click path not recorded on most brands).
- Whether AdKit's API key can call an HTTP endpoint directly (not needed for v1).
