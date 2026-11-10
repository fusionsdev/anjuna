> Source: ChatPRD project "Anjuna", document 9f77da42-1d69-4e2d-b2be-f0547a0ea66e (updated 2026-10-01T18:31:45.942Z).
> Repository note (2026-10-02): code now lives in `fusionsdev/anjuna`, not `fusionops-v2`. Where this brief says fusionops-v2, read this repo. See docs/TASKS.md for the current task list.

# Anjuna — Product Brief for AI Development

**Version:** 1.0 · **Date:** 2026-10-02 · **Owner:** Product owner (builder + operator) **Repository:** `fusionops-v2` · **Code slug:** `anjuna` **Status:** Direction approved. A spike proved the full loop on real Cloudflare (2026-10-02). The Phase 0 GO/NO-GO items are still open (§10).

> **Naming.** *Anjuna* is the new platform. *AURUM* means only the legacy systems: V1 `fusion_formv_v1`, V2 core, `aurum-form`, `aurum-installer-v1` and `aurum-prebuilt-factory`. They are read only as sources for porting proven logic.

---

## 1\. Overview

Anjuna is a Cloudflare-native lead-generation platform for US consumer-finance traffic coming from Google Ads.

**Each brand** is a static landing page plus the Anjuna Form. Both are served by one Cloudflare Worker on the brand's own Custom Domain.

**A shared core Worker** on `core.aduplift.ai` owns all data and the money path:

```
ad click → landing (brand name in H1) → /go → Anjuna Form → submit → core (D1)
→ provider hop → LeadsGate prepop redirect → LeadsGate postback → conversion_uploads
→ pending/ack → external VPS drain → AdKit → Google Ads offline conversion

```

**An internal factory** (control panel + Cloudflare Workflows) creates, installs, upgrades, pauses and rolls back brands. The same product is also installed and operated for a second tenant, the maimax installation.

**Guiding principle.** V1 has handled about 1,000 production leads. Port V1 behavior as-is and change only what the new architecture requires. A theoretical edge case is not a requirement.

## 2\. Goals

1. Everything runs on Cloudflare: D1 for data, R2 for template artifacts, Workers + Workflows for compute.
2. A new brand goes live from Template + Domain + Keyword, with no code changes.
3. The proven V1 money path stays unchanged, and the drain contract stays byte-identical.
4. Nothing visibly links brands to each other: no host map in any bundle, no back-office routes on brand domains, no shared identifiers.
5. The landing H1 and the form header show the brand name. When the ad link carries a keyword, the page title, the meta description and the form header name show the brand's configured keyword. The ad's own keyword is recorded for reporting and never displayed to the visitor; it is still carried in a hidden form field and the form config.
6. Each brand can A/B test form variants with a configurable traffic split.
7. Operators can run many brands: bulk upgrade, pause, rollback, alerts and a funnel report.
8. The platform can be reinstalled in another Cloudflare account (the maimax installation) and operated from the same CI.

## 3\. Non-goals

* Server-post or API lead delivery to buyers. Prepop redirect is the only handoff.
* Multi-tenant data sharing between installations.
* Direct Google Ads API work from a Worker. Workers hold no AdKit key. The VPS drain host runs `adkit`, the panel writes jobs and the VPS executor runs them (ADR-0005).
* New loss-prevention frameworks beyond V1, such as payout matrices, receipt tables, live-state ladders or crash-test harnesses.
* Turnstile, and outreach by SMS or phone.
* A builder MCP. It is deferred until the first brand is live.
* Any cloaking, safe pages or identity-based gating.

## 4\. Users

| User | Needs |
| --- | --- |
| **Owner** | Approves templates, configures brands, runs install/upgrade/rollback, watches the funnel and alerts, operates the maimax installation. |
| **Employee** | Creates a brand from Domain + Keyword using a sealed template, and follows the add-brand checklist. |
| **Visitor (applicant)** | Gets a fast landing page and form on the same origin, and gives clear consent before being handed off to a lender partner. |
| **Google reviewer / AdsBot** | Sees exactly what visitors see: the same HTML for every user agent. |
| **External systems** | LeadsGate (prepop form + postback), the VPS drain → AdKit, and listmonk. |

## 5\. User stories

1. As a **visitor**, I click an ad for "fast cash loans". The landing H1 shows the brand name, and the page title and description lead with the brand's configured keyword (for example "Loan Options"). I pick an amount and ZIP and continue to a form whose header shows that configured keyword. The words from the ad are never displayed on either page.
2. As a **visitor**, after I submit I land on the LeadsGate form with my details already filled in.
3. As the **owner**, when LeadsGate reports a sale with payout > 0, a conversion is queued with the original gclid, brand and hostname, and the drain uploads it through AdKit.
4. As an **employee**, I enter Domain + Keyword, pick a sealed template and click Install. The brand goes live after automatic smoke tests pass, or rolls back automatically if they fail.
5. As the **owner**, I set Brand X's form split to A 50% / B 50% and compare revenue per form view for each variant.
6. As the **owner**, I can pause a brand instantly, roll it back to its previous version, or upgrade all brands (canary first).
7. As the **owner**, I release once and CI deploys to my installation and then to maimax, each with its own account and secrets.

## 6\. Functional requirements

### 6.1 Brand Worker (`anjuna-brand-runtime`)

| ID | Requirement |
| --- | --- |
| BR-1 | **Routing.** Set `run_worker_first = true` for every path. Allowlist: `/`, legal pages, `/go`, `<formRoute>`, `<formRoute>/provider`, `<formRoute>/complete`, `/apply` (also `/apply/`, GET/HEAD only), `/_f/*`, `/api/{leads,zip,telemetry,errors,health}`, and the PostHog/Sentry proxy paths. Every other path returns the same 404. Admin, postback and drain routes never exist on brand domains. |
| BR-2 | **Flow gate,** `param` **mode (default).** `/go` checks that `requested_amount` is one of the brand's buckets and `zip` is 5 digits, then returns 302 to `<formRoute>` carrying amount, ZIP, ad params (`gclid`, `gbraid`, `wbraid`, `msclkid`, `utm_*`) and `keyword`. An invalid request, or direct access to the form route, returns 302 to `/` with the ad params kept. Every visitor gets the same response. |
| BR-3 | **Flow gate,** `signed_cookie` **mode.** Built but turned off. Core issues and verifies an HMAC handoff cookie that lasts 30 minutes. If core is unreachable, the gate fails open to `param` mode and an alert fires. A bad or expired signature returns 302 to `/`. The mode can be switched per brand without a redeploy. |
| BR-4 | **Keyword handling.** Clean `keyword`: text only, safe character set, title case, at most 60 characters. The cleaned ad keyword is recorded for click attribution and written to the runtime config JSON as `keyword`. It is never displayed to the visitor; it still rides in the CTA form's hidden `keyword` field (so `/go` can carry it to the form) and in the runtime config for reporting. HTMLRewriter replaces the text of `[data-kw]` with the brand display name on every request. When the ad link carries a keyword, the index `<title>` and meta description lead with the brand's configured keyword, and the runtime config carries that word as `label`. When the param is missing, `keyword` falls back to the configured keyword and `label` is null. |
| BR-5 | **Runtime config.** `<script type="application/json" id="cfg">` holds only brand name, amount, ZIP, keyword, label, formRoute, A/B variant and proxy paths. It never holds secrets, `brand_id` or data about other brands. |
| BR-6 | **Click capture.** On landing navigation and on `/go`, record the click in core (V1 `click_sessions` behavior) and set an HttpOnly first-party cookie with a neutral name. If click capture fails, the page still loads. |
| BR-7 | **Lead submit.** `/api/leads` forwards the V1 form payload to core. The brand Worker sets `brand_id` and `hostname` from its own environment; the client never supplies them. It returns `{status, lead_id, redirect_url}` with `redirect_url = <formRoute>/provider?c=<continuation>`. |
| BR-8 | **Provider hop.** Resolve the continuation in core, then return 302 to the LeadsGate prepop URL with `Referrer-Policy: no-referrer`. An unknown token returns 302 to `/`. |
| BR-9 | **A/B assignment.** Pick a variant by weighted random draw from the brand config. Store it in a sticky first-party cookie (30 days) together with `experiment_id`, and write the variant into the runtime config. Changing the weights affects only new visitors; a new `experiment_id` reassigns everyone. |
| BR-10 | **Pause switch.** A paused brand serves a neutral "temporarily unavailable" page for both the landing page and the form. Every visitor gets the same response. |
| BR-11 | **Analytics proxies.** PostHog goes through a first-party path: the client sends a placeholder key with `disable_compression`, and the server swaps in the real key. Sentry uses `tunnel`, and the server swaps the DSN in the envelope header. |
| BR-12 | **Transport to core.** Use a Service Binding when the brand is in the same account as core. Otherwise call `core.aduplift.ai` over HTTPS with a per-account write-only credential, and set `compatibility_flags: ["global_fetch_strictly_public"]`. |

### 6.2 Core (`anjuna-core`, repurposed `workers/callback-ingest`)

| ID | Requirement |
| --- | --- |
| CO-1 | **Lead handling (V1 port).** Port from `fusion_formv_v1@8404ec2 functions/api/[[path]].ts`: validation for both lite and full forms, consent evidence, state gate (`STATE_MODE=block`, `UNSUPPORTED_STATES=NY,AR,VT,WV`), V1 dedupe on the client `lead_id` (`leads.lead_id` primary key), single-use click claim, and `buildUserRedirect` in `prepop_redirect` mode. A duplicate submit hands off the current validated applicant, as V1 does. Email and phone are normalised but are not a dedupe key in V1. |
| CO-2 | **RPC.** `/rpc/*` endpoints (`recordClick`, `submitLead`, `resolveContinuation`, `zip`, `issueHandoff`, `verifyHandoff`) require the per-account credential. Core rejects any `brand_id` that does not belong to the calling account. |
| CO-3 | **Postback (V1).** `GET /api/postback?token&cid&payout&lead_id&type`, with a per-brand token and payout clamp. A valid postback with an unknown `cid` returns 200 with `status: ignored`, `reason: unknown_click`, without writing a postback event or conversion. Matched postbacks are written to `postback_events`, deduped by `(lead_id, event_type)`. When the type is `soldLead` and payout > 0, a row is also inserted into `conversion_uploads`, deduped by `lead_id`. Advertising click IDs (`gclid`, `gbraid`, `wbraid`, `msclkid`) are nullable; a Google click ID is not required to enqueue the conversion. |
| CO-4 | **Drain (V1, frozen).** `GET /api/conversions/pending` returns leased rows including `brand` and `hostname`. `POST /api/conversions/ack` accepts uploaded / failed / deferred, applies backoff, and marks a row dead after 6 attempts. |
| CO-5 | **Admin.** The V1 admin endpoints (leads, conversions, CSV), used only by the control panel. |
| CO-6 | **Domain and WAF.** Custom Domain `core.aduplift.ai`. Add a WAF skip rule for `/api/postback` and `/api/conversions/*`, because in the spike Cloudflare returned 403 to some non-browser user agents. |
| CO-7 | **Mailing outbox.** A `mailing_outbox` row is written in the same batch as the lead. A cron every 5 minutes upserts these into listmonk (one list per brand; attributes: phone, brand, state, amount, consent_version) and retries on failure. Unsubscribes, bounces and complaints sync back into `suppressions`. Phone numbers are stored only, never used for outreach. |

### 6.3 Anjuna Form (`anjuna-form`)

| ID | Requirement |
| --- | --- |
| FO-1 | Port `aurum-form/src@8ba11d3`: lite_v1 with 3 steps; keep the full variant for A/B tests. |
| FO-2 | Delete `BRAND_BY_HOST`; the brand comes from the runtime config. The header shows `cfg.label` when it is set, else the brand name. It never shows `cfg.keyword`. |
| FO-3 | Build with Vite `base: "/_f/"`. Read the A/B variant from `cfg.variant`. Remove the gtag `ads-conversion` code and `gate-interest`. Send PostHog and Sentry through the proxies. |
| FO-4 | The bundle contains no brand domain, no "anjuna" or "aurum" strings, and no PostHog key or Sentry DSN. CI builds it once per version and stores it in R2 as `form@sha` with a SHA-256 manifest. |

### 6.4 Templates

| ID | Requirement |
| --- | --- |
| TP-1 | Static export only: Astro (SSG), vinext/Next.js `output: 'export'`, or React (Vite SPA). We never build templates and never run template server code. |
| TP-2 | **Template contract.** Every template must have:• exactly one `<KeywordSlot default="…">` (renders `<span data-kw>`) inside the H1;• a CTA form `data-cta` that sends `requested_amount` + `zip` to `/go`;• real legal pages: privacy, terms, do-not-sell, disclosures;• no "Personal Loan(s)" wording;• no PII inputs;• no external scripts or analytics;• tokens only in HTML or JSON;• Astro styles marked `is:global`. |
| TP-3 | **Certification.** Lint, identity scan, and Browser Rendering screenshots on desktop and mobile. The owner then seals the version: it becomes immutable, is identified by SHA-256 and is stored in R2. |
| TP-4 | **Recommended tools.** OpenDesign (local, agent-driven) or Bolt.new, both targeting Astro. v0 (Next.js static export) as a second choice. Stitch or Magic Patterns for design exploration. Lovable is not recommended because it produces an SPA. |

### 6.5 Factory and control panel (`anjuna-factory`, `anjuna-web`)

| ID | Requirement |
| --- | --- |
| FA-1 | `install-brand` **Workflow.** Every step is idempotent and writes a receipt. Steps run in the order proven in the spike:1. Validate: zone active, token has the needed scopes, no A/CNAME record on apex or [www](http://www).2. Save the rollback record.3. Render: tokens, runtime config hooks, per-brand bundle salt (chunk rename).4. Upload assets.5. Upload the script with bindings and secrets.6. Deploy.7. Attach Custom Domains for apex and [www](http://www).8. Run the smoke e2e.9. Write the receipt.If any step fails, the Workflow rolls back automatically. |
| FA-2 | `rollback-brand` redeploys the previous `version_id`, or detaches the Custom Domain if this was the first install. `upgrade-all` upgrades one canary brand first, then the rest. |
| FA-3 | **Control panel.** better-auth with Owner and Employee roles. Screens:• brands and config (buckets, keyword default, A/B weights, `flow_gate_mode`, pause);• install / rollback / upgrade, with receipts;• add-brand checklist;• funnel report;• alerts;• mailing status.Every change is audit-logged. |
| FA-4 | **Add-brand checklist.**• Brand route added to the VPS drain (`BRAND_ROUTING_JSON`).• LeadsGate postback entries (Sold, Reject) pointing at core.• LeadsGate "Test sold" creates a `postback_events` row.• Final URL suffix `keyword={keyword}` set on the campaign. |
| FA-5 | **Alerts.**• A conversion pending longer than N hours.• A brand with leads but no postbacks in 24 hours.• Submit error rate.• Reject rate per brand. |
| FA-6 | **Funnel report.** click → /go → form view → submit → sold → revenue, broken down by brand × keyword × A/B variant. |

### 6.6 Tenants (maimax installation)

| ID | Requirement |
| --- | --- |
| TN-1 | `tenants/<name>.config.ts`, validated with Zod: core domain, account IDs, LeadsGate aid and prepop base, drain URL, listmonk URL, alert channel. Secrets appear only as names, never as values. |
| TN-2 | A `bootstrap` command (an alchemy stage per tenant) creates D1, R2, Workers, Workflows and the core Custom Domain in that tenant's account, runs migrations and seeds the owner login. |
| TN-3 | A CI deploy matrix with one GitHub Environment per tenant. Each release deploys to the owner first and maimax second, with a smoke test after each. One tenant's token cannot touch the other tenant's account. |

## 7\. Key flows

**Visitor**

1. Ad URL `…/?keyword=fast%20cash%20loans&gclid=…`.
2. Brand Worker records the click with the ad keyword and writes the brand name into the H1.
3. CTA → `/go` (validate) → 302 to `/request?...`.
4. Anjuna Form, 3 steps.
5. `POST /api/leads` → core commits the lead → returns `redirect_url`.
6. `/request/provider?c=…` → 302 to the LeadsGate prepop form.

**Conversion**

1. LeadsGate postback → core `/api/postback`.
2. Core writes `postback_events`, and `conversion_uploads` when the type is soldLead, payout > 0 and the lead has a Google click ID.
3. Drain calls `pending` → uploads through AdKit → calls `ack`.

**Install**

1. Employee enters Domain + Keyword and picks a sealed template.
2. The `install-brand` Workflow runs, then the smoke test.
3. Result is READY, or the Workflow rolls back automatically.
4. Employee completes the checklist.

## 8\. Technical architecture

```
Owner/Employee ─► anjuna-web ─► anjuna-factory (Workflows: install / rollback / upgrade-all)
                                   │ Cloudflare API (per-account token): assets → script → deploy → Custom Domain
                                   ▼
brand Worker × N  (account A or B, ~10 brands per account)
   landing (static template) + /_f/ Anjuna Form + /go + /api/* allowlist
   │ Service Binding (same account) or HTTPS + per-account credential (other account)
   ▼
anjuna-core @ core.aduplift.ai  (D1 leads, cron: mailing, alerts)
   ▲ LeadsGate postback          ▲ VPS drain (pending/ack) → AdKit → Google Ads

```

**Storage**

* **D1** `leads`**:** the V1 schema and migrations 001–010, ported. Adds `brand_runtime`, `mailing_outbox`, and `experiment_id` / variant / keyword columns. `conversion_uploads` stays identical to V1.
* **D1** `factory`**:** templates, versions, certifications, form_artifacts, brands, revisions, installs, receipts, audit_log.
* **D1** `auth`**:** better-auth.
* **R2:** sealed templates, form artifacts, screenshots.
* **Analytics Engine:** telemetry and the funnel.

**Infrastructure**

* New, clean Cloudflare account(s). The old account is not used.
* Repository `fusionops-v2`: bun 1.3.13, turbo, alchemy, worker-kit, contracts, vitest.
* New ADRs: 0004 (D1), 0005 (postback to core), 0006 (brand topology), 0007 (same-origin tracking).

## 9\. Lessons from the 2026-10-02 spike (must be honored)

| Finding | Requirement |
| --- | --- |
| A Worker that fetches another Worker on the same zone gets **error 1042**. | Use `global_fetch_strictly_public` and a Custom Domain for core, or a Service Binding. |
| A Custom Domain cannot attach while A/CNAME records exist. | The install token needs DNS Edit, and the validate step must check for these records. |
| Changing a domain that is already live is risky. | Follow the order validate → save rollback → detach Pages → delete CNAME → attach Custom Domain → e2e, with automatic rollback. |
| Cloudflare returned 403 to a non-browser user agent. | Add a WAF skip rule on the postback and drain paths. |
| Astro scopes styles to each component. | The template contract requires `<style is:global>` for shared styles. |
| The real AURUM form worked after only 3 changes. | Apply FO-2 and FO-3. |
| The e2e scripts (`e2e.py` for 30 API checks, `ui_e2e.py` for a headless form fill) caught every issue. | Reuse them as install smoke tests. |

## 10\. Phase 0 — GO/NO-GO (must pass before the first production brand)

| \# | Check | Pass when |
| --- | --- | --- |
| G1 | Real LeadsGate prepop + "Test sold" postback to core | LeadsGate echoes our `click_id` in `cid`; the postback is not blocked by Cloudflare; a conversion row is created. |
| G2 | Real `drain.mjs` against core | pending/ack works unchanged, and one real AdKit upload succeeds. |
| G3 | Brand in account B → core in account A | Submit and postback work, no 1042 error, and the credential cannot write for a brand outside its account. |
| G4 | V1 validation port | V1 golden fixtures pass (state gate, consent, dedupe). |

## 11\. Delivery plan (tasks T1–T17; each gets its own Feature Implementation Spec)

| Wave | Tasks (parallel) | Depends on |
| --- | --- | --- |
| 0 — Owner | O1 new account + `aduplift.ai` · O2 scoped token in CI secrets · O3 test domain · O4 LeadsGate aid + postback entries · O5 drain access · O6 listmonk · O7 the maimax equivalents | — |
| 1 | T1 ADRs + AGENTS.md · T2 D1 schemas · T3 Zod contracts + V1 golden fixtures · T4 Anjuna Form · T5 template starters (Astro + KeywordSlot) | — |
| 2 | T6 core (V1 port) · T7 brand runtime · T8 mailing → listmonk · T9 alerts + funnel data | T2, T3 |
| 3 | T10 install/rollback/upgrade-all Workflows · T11 template certification + seal · T12 control panel · T17 tenant bootstrap + CI matrix | Wave 2 |
| 4 | T13 real LeadsGate (G1) · T14 real drain (G2) · T15 cross-account (G3) · T16 first production brand | Wave 3 + O1–O5 |

**Critical path:** T2/T3 → T6 → T10 → T13 → T16.

## 12\. Success metrics

* A new brand goes from Domain + Keyword to live in under 15 minutes, with zero code changes.
* Conversions uploaded per sold lead with a Google click ID match V1 or better. No conversion stays pending longer than N hours without an alert.
* Zero cross-brand identifiers in any brand response, checked by an automated grep in the smoke tests.
* Brand responses are identical for AdsBot and browser user agents, checked by an automated parity test.
* One release deploys to both installations with no manual steps.

## 13\. Open questions

| \# | Question | Owner |
| --- | --- | --- |
| Q1 | Which alert channel (Telegram, email, …)? | Owner |
| Q2 | Retention periods for PII and consent evidence | Owner + counsel |
| Q3 | Does LeadsGate support a per-brand sub-id or aid (to avoid linking brands)? | Owner → LeadsGate |
| Q4 | Which SMTP provider for listmonk, once sending starts? | Deferred |
| Q5 | Exact "pending too long" threshold N | Owner |
