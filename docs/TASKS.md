# Anjuna — Task breakdown for multi-agent delivery

> **Name:** Anjuna is the new lead-gen platform (formerly drafted as "AURUM v3"). **AURUM** now refers only to the legacy systems (V1 `fusion_formv_v1`, V2 core, `aurum-form`, `aurum-installer-v1`, `aurum-prebuilt-factory`), which are read only as sources for porting logic.

**Date:** 2026-10-02 · **Repo:** `fusionsdev/anjuna` (greenfield; moved from `fusionops-v2` on 2026-10-02) · **Reference spike:** `spike/` in this repo (full loop proven on Cloudflare)

**Port sources (read-only, on GitHub):**
- V1 core: `fusionsdev/fusion_formv_v1`, branch `anjuna-port-base` = commit `8404ec2`.
- Form: `fusionsdev/aurum-form`, branch `anjuna-port-base` = commit `8ba11d3`.

Clone them read-only, for example `git clone --depth 1 -b anjuna-port-base https://github.com/fusionsdev/fusion_formv_v1 /tmp/v1`. Never push to them.

**Rules for every agent:**
1. **V1 parity.** Port V1 behavior from `fusion_formv_v1` branch `anjuna-port-base` (`8404ec2`) only. V1 has run about 1,000 leads in production. Do not invent new loss-prevention machinery.
2. **Buyer handoff is LeadsGate prepop redirect only.** No server-post and no `LEADSGATE_ENDPOINT`.
3. **No cloaking.** Nothing varies by UA, IP, ASN, referrer, gclid or bot detection.
4. **Brand bytes stay clean.** No cross-brand identifiers and no "anjuna" or "aurum" strings in anything a brand serves. Brand Worker script names are opaque.
5. **Infra stays on Cloudflare.** D1 for data, R2 for template artifacts, Workers + Workflows for compute.
6. **One task = one branch / worktree.** Each task must meet its acceptance criteria before merge, plus `bun run typecheck` and `bun run test` green.

Legend: **[P]** = can run in parallel with the other [P] tasks of the same wave · **Agent** = suggested CLI / role · **Blocks** = tasks that wait on this one.

---

## Wave 0 — Owner prerequisites (human, start now; nothing here is code)

| ID | Task | Needed by |
|---|---|---|
| O1 | Create the new clean Cloudflare account(s). Add zone `aduplift.ai` (core). | T10, T13–T16 |
| O2 | Create a scoped API token (Workers Scripts:Edit, Workers Routes/Custom Domains:Edit, DNS:Edit, D1:Edit, R2:Edit, Workflows:Edit, Pages:Read) and store it **only** in GitHub Actions secrets / `wrangler secret`, never in chat. | T10, T13–T16 |
| O3 | Add 1 throwaway test brand domain to the new account (active zone, no existing A/CNAME on apex/www). | T13, T15 |
| O4 | LeadsGate: confirm `aid` for the test brand, and add postback entries (Sold, Reject) for the test domain pointing at `https://core.aduplift.ai/api/postback?...`. | T13 |
| O5 | VPS drain: permission to point a copy of `drain.mjs` at core (peek mode first). | T14 |
| O6 | listmonk: instance URL + API user for the mailing list. | T8 |
| O7 | Maimax installation: its own Cloudflare account + scoped token (into a GitHub Environment), core domain, LeadsGate aid/postback, drain/AdKit target, listmonk. Same items as O1–O6, for that tenant. | T17, maimax go-live |

---

## Wave 1 — Foundations (all [P], no dependencies)

### T1 [P] ADRs + repo rules · Agent: droid
- **Do:** In `docs/adr/` write:
  - ADR-0001: D1 only for data. Note that R2 is allowed for template artifacts.
  - ADR-0002: LeadsGate prepop redirect + postback to core (Voluum retired).
  - ADR-0003: brand Worker topology. Brand Worker + Custom Domain; core on `core.aduplift.ai`; HTTPS with a per-account credential across accounts, Service Binding within the same account; `global_fetch_strictly_public`.
  - ADR-0004: same-origin tracking (click cookie + click ledger, PostHog/Sentry first-party proxy).

  Then make sure `AGENTS.md` agrees with the ADRs.
- **Accept:** ADRs merged and consistent with `docs/PRODUCT-BRIEF.md`. **Blocks:** none (docs).

### T2 [P] D1 schemas · Agent: codex
- **Do:**
  - **`packages/leads-db`.** Port the V1 `db/schema.sql` plus migrations 001–010 from `anjuna-port-base`. Add:
    - `brand_runtime` (brand_id, account, hostnames, drain key, postback token hash, aid, prepop base, amount buckets, `flow_gate_mode`, `paused`, A/B config JSON, keyword default);
    - `mailing_outbox`;
    - `experiment_id` / `variant` / `keyword` columns on clicks and leads.
  - **`packages/factory-db`:** templates, template_versions, certifications, form_artifacts, brands, brand_revisions, installs, install_receipts, audit_log.
  - **`packages/auth-db`:** better-auth schema on D1, with roles `owner` and `employee`.
- **Accept:** migrations apply on an empty D1 locally; `conversion_uploads` is column-identical to V1. **Blocks:** T6, T8, T9, T10, T12.

### T3 [P] Contracts (`packages/contracts`) · Agent: codex
- **Do:** Zod schemas + golden fixtures for:
  - the drain contract (`GET /api/conversions/pending`, `POST /api/conversions/ack`), byte-compatible with V1 `drain/drain.mjs`, including `brand` and `hostname`;
  - LeadsRpc: `recordClick`, `submitLead` (V1 form payload shape), `resolveContinuation`, `zip`, `issueHandoff`/`verifyHandoff`;
  - the brand runtime config JSON;
  - the postback query;
  - the template contract.
- **Accept:** golden tests pass against V1 fixtures. **Blocks:** T6, T7, T10, T11.

### T4 [P] Anjuna Form (`apps/lead-form`) · Agent: cursor
- **Do:** Port `aurum-form/src` from `anjuna-port-base` (`8ba11d3`), using spike `form-app/` as the reference. Changes:
  1. Delete `BRAND_BY_HOST`; the brand comes from the runtime config.
  2. Put `<span data-kw>` in the header, fed from `cfg.keyword`.
  3. Build with Vite `base: '/_f/'`.
  4. Read the A/B variant from `cfg.variant` instead of `experiment.ts` randomness.
  5. Remove `ads-conversion` (gtag) and `gate-interest`.
  6. Point PostHog/Sentry at proxy paths with placeholder key/DSN.
  7. CI uploads the build to R2 as `form@sha` with a SHA-256 manifest.
- **Accept:** a grep of the bundle finds no brand domain, no "anjuna" or "aurum" and no PostHog key or Sentry DSN; `ui_e2e.py` from the spike passes against a local brand Worker. **Blocks:** T10.

### T5 [P] Landing template starters · Agent: cursor
- **Do:**
  - **Astro starter:** `KeywordSlot` component, CTA form `data-cta` → `/go`, legal pages, `<style is:global>`.
  - **React component:** `KeywordSlot` for vinext static export and React SPA templates, reading `cfg.keyword`.
  - **Contract doc** for builders (OpenDesign / Bolt / v0).
- **Accept:** both starters build to static `dist/`; H1 contains `<span data-kw>` in Astro output. **Blocks:** T11.

---

## Wave 2 — Runtime (after T2 + T3)

### T6 Core Worker (`workers/core`) · Agent: codex (port) + claude (review)
- **Do:** Port from V1 `functions/api/[[path]].ts` on `anjuna-port-base`:
  - lead validation, consent evidence, state gate NY/AR/VT/WV, V1 dedupe (lead_id + email/phone), click claim, `buildUserRedirect` prepop;
  - postback handler (token, payout clamp 230, `postback_events`, `conversion_uploads`);
  - pending/ack lease and backoff;
  - zip lookup; admin endpoints.

  Add on top of V1:
  - `/rpc/*` with a per-account credential **and** a check that `brand_id` belongs to that account;
  - continuation tokens.
- **Deploy notes:** Custom Domain `core.aduplift.ai`; WAF skip rule for `/api/postback` and `/api/conversions/*` (the spike saw 403 from Cloudflare on some UAs).
- **Accept:** contract tests from T3 pass; spike `e2e.py` passes against core + a test brand Worker. **Blocks:** T7 (integration), T10, T13, T14.

### T7 [P] Brand runtime (`packages/brand-runtime`) · Agent: claude
- **Do:** Productionize spike `brand-worker/src/index.ts`:
  - **Routing:** route allowlist with a uniform 404; `run_worker_first`; `www` redirect.
  - **Flow gate:** `param` mode (default) and `signed_cookie` mode (built, off by default, fail-open if core is unreachable).
  - **Keyword:** insertion into `[data-kw]` (text-only, title case, ≤60 chars) plus `cfg.keyword`; CTA hidden ad-param inputs.
  - **Clicks:** click cookie with a neutral name.
  - **A/B:** server-side weighted variant from `brand_runtime`, sticky cookie for 30 days, `experiment_id`.
  - **Pause switch:** show a "temporarily unavailable" page when the brand is paused.
  - **Proxies:** PostHog proxy (server-side key swap; `disable_compression`); Sentry tunnel (server-side DSN swap).
  - **Transport to core:** HTTPS to `core.aduplift.ai` with `global_fetch_strictly_public`, or Service Binding when in the same account.
- **Accept:** Miniflare tests for routing, the gate in both modes, keyword XSS, A/B split (10k visitors within ±2%, sticky), and AdsBot UA parity. **Blocks:** T10.

### T8 [P] Mailing list → listmonk · Agent: droid
- **Do:**
  - Write a `mailing_outbox` row in the same batch as the lead.
  - Cron every 5 minutes upserts subscribers into listmonk (email key; name; attribs: phone, brand, state, amount, consent_version), one list per brand, with retry and backoff.
  - Reverse-sync unsubscribes, bounces and complaints into `suppressions` (V1 `suppress-to-d1.mjs` logic).
  - Phone numbers are stored only, never used to send.
- **Accept:** a listmonk outage leaves rows pending and loses no leads; duplicates are not re-added; suppressed emails are skipped. **Blocks:** none.

### T9 [P] Alerts + funnel report data · Agent: opencode
- **Do:**
  - **Alerts:** a `conversion_uploads` row pending longer than N hours; a brand with leads but no postbacks in 24 hours; submit error rate; reject rate per brand.
  - **Funnel queries:** click → /go → form view → submit → sold → revenue, by brand × keyword × A/B variant (Analytics Engine plus D1).
- **Accept:** each alert fires on a synthetic trigger; queries return correct numbers on fixtures. **Blocks:** T12 (report UI).

---

## Wave 3 — Factory (after Wave 2)

### T10 Anjuna Factory: install / rollback / bulk-upgrade Workflows · Agent: claude (lead) + codex
- **Do:** Cloudflare Workflows, each step idempotent and recorded in `install_receipts`, following the order proven in the spike:
  1. **Validate:** zone active, token scopes present, no A/CNAME on apex/www.
  2. **Save the rollback record.**
  3. **Render:** tokens; per-brand salt by renaming `/_f/assets/*` chunks, rewriting references and adding a salt comment.
  4. **Upload:** assets session, then script upload with bindings and secrets.
  5. **Deploy** the version.
  6. **Attach** Custom Domains for apex + www.
  7. **Smoke:** spike `e2e.py` checks against the live brand.
  8. **Receipt.**

  Also build:
  - `rollback-brand`: redeploy the previous `version_id`, or detach the Custom Domain on a first install;
  - `upgrade-all`: one canary brand first, then the rest.
- **Accept:** install on the O3 test domain reaches READY; a re-run creates nothing new; rollback works; a deliberately failing step rolls back automatically. **Blocks:** T13, T15, T16.

### T11 [P] Template certification + seal · Agent: cursor
- **Do:**
  - Import a static `dist` ZIP into R2.
  - Lint against the template contract: `KeywordSlot` in H1, CTA → `/go`, legal pages, no "Personal Loan", no external scripts, no PII inputs, tokens only in HTML/JSON.
  - Identity scan; Browser Rendering screenshots for desktop and mobile.
  - Owner seals the version: immutable, SHA-256.
- **Accept:** the T5 starters pass; a template with an external script or a missing `KeywordSlot` is rejected with a repair message. **Blocks:** T10 (uses sealed templates), T16.

### T12 [P] Control panel (`apps/web`) · Agent: cursor (UI) + claude (review)
- **Do:** better-auth with Owner/Employee roles. Screens:
  - brands and config (amount buckets, keyword default, A/B weights, `flow_gate_mode`, pause);
  - install / rollback / upgrade-all buttons with receipts;
  - add-brand checklist: drain route, LeadsGate postback entries, Test sold, Final URL suffix `keyword={keyword}`;
  - funnel report;
  - alerts;
  - mailing status.
- **Accept:** Employee can create and install a brand from Domain + Keyword; Owner-only actions are guarded; every config change is audit-logged. **Blocks:** T16.

### T17 [P] Tenant bootstrap + managed deploy (maimax installation) · Agent: claude + codex
**Context:** the owner also operates a second, fully separate installation for maimax. Maimax has its own Cloudflare account, LeadsGate (aid, postback token), drain/AdKit, Google Ads, listmonk and data. The owner builds and operates it. This is the same product installed twice, **not** multi-tenant: no shared D1, no `tenant_id`, nothing that could route maimax leads or conversions into the owner's systems.
- **Do:**
  - `tenants/<name>.config.ts`, validated with Zod: core domain, account IDs, LeadsGate `aid` + prepop base, drain URL, listmonk URL, alert channel. Secrets are referenced by name only.
  - `bootstrap` command (alchemy stage per tenant): create D1 (`leads`, `factory`, `auth`), R2, Workers, Workflows and the core Custom Domain in that tenant's account; run migrations; seed the owner login.
  - CI deploy matrix: one GitHub Environment per tenant holding that tenant's Cloudflare token and secrets. A release tag deploys core + control panel to each tenant in turn (owner first, maimax second), with the smoke test after each.
  - Each tenant's brand installs (T10) run with that tenant's token only.
- **Accept:**
  - Bootstrap on an empty test account produces a working core + control panel.
  - The same release deploys to two tenants with separate state; a cross-tenant grep finds no shared IDs or secrets.
  - A tenant's token cannot touch the other tenant's account.
- **Blocks:** maimax go-live.

---

## Wave 4 — GO/NO-GO with real systems (needs O1–O5)

| ID | Task | Agent | Accept |
|---|---|---|---|
| T13 | **Real LeadsGate loop** on the test brand: real prepop URL, then LeadsGate "Test sold" → core `/api/postback`. | claude + owner | LeadsGate echoes our `click_id` in `cid`; the postback is **not** blocked by Cloudflare (WAF/BIC); a `conversion_uploads` row is created. |
| T14 | **Real drain** `drain.mjs` against core (peek first, then one real upload). | owner + codex | pending/ack works unchanged; the AdKit upload succeeds. |
| T15 | **Cross-account brand:** brand in account B → `core.aduplift.ai` in account A. | claude | Submit and postback work; no error 1042; the credential cannot write for a brand outside its account. |
| T16 | **First production brand** launched with a real template. | owner | Full e2e green; owner approval recorded. |

**Deferred (after the first brand is live):** builder MCP (remote McpAgent), SMTP sending for listmonk.

---

## Parallelism map

```
Wave 0 (owner) ─────────────────────────────────────────────┐
Wave 1:  T1 ┐  T2 ┐  T3 ┐  T4 ┐  T5 ┐      (5 agents at once)│
Wave 2:        T6 ◄─T2,T3   T7 ◄─T3   T8 ◄─T2   T9 ◄─T2     │ (4 agents)
Wave 3:        T10 ◄─T4,T6,T7   T11 ◄─T3,T5   T12 ◄─T2,T9   T17 ◄─T2,T6 │ (4 agents)
Wave 4:        T13–T16 ◄─T10 + O1–O5 ◄───────────────────────┘
```
Critical path: T2/T3 → T6 → T10 → T13 → T16.

---

## Linear mapping (project P-FUS-17 "Anjuna", team Fusionfx)

| Task | Issue | Task | Issue | Task | Issue |
|---|---|---|---|---|---|
| O1 | FUS-329 | T1 | FUS-336 | T10 | FUS-345 |
| O2 | FUS-330 | T2 | FUS-337 | T11 | FUS-346 |
| O3 | FUS-331 | T3 | FUS-338 | T12 | FUS-347 |
| O4 | FUS-332 | T4 | FUS-339 | T13 | FUS-349 |
| O5 | FUS-333 | T5 | FUS-340 | T14 | FUS-350 |
| O6 | FUS-334 | T6 | FUS-341 | T15 | FUS-351 |
| O7 | FUS-335 | T7 | FUS-342 | T16 | FUS-352 |
|  |  | T8 | FUS-343 | T17 | FUS-348 |
|  |  | T9 | FUS-344 |  |  |

Labels: `anjuna`, `owner-task` (O-items), `scope:proposed` (out-of-brief work; owner approval required).
Brief: ChatPRD project "Anjuna" → "Anjuna — Product Brief for AI Development".
