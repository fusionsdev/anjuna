# ADR-0002: LeadsGate prepop redirect and postback to core

- **Status:** Accepted
- **Date:** 2026-10-02
- **Brief refs:** BR-7, BR-8, CO-1, CO-3, CO-4, CO-6, FA-4, §7 Conversion flow (the brief's §8 lists this decision as "0005 (postback to core)")

## Context

The buyer is LeadsGate. V1 hands the visitor to LeadsGate with a prepop redirect, receives LeadsGate's postback and queues Google Ads offline conversions. An existing VPS drain (`drain.mjs`) reads those conversions and uploads them through AdKit. Earlier systems also routed traffic and postbacks through Voluum. Anjuna ports V1 and must not change the money path beyond what the new topology requires.

## Decision

1. **Handoff is prepop redirect only.** Core builds the LeadsGate prepop URL with V1 `buildUserRedirect` in `prepop_redirect` mode (lead fields as GET params, `aid`, `click_id` = `lead_id` without hyphens). There is **no server-side post** of the lead to LeadsGate and **no `LEADSGATE_ENDPOINT`** setting.
2. **The browser never receives the prepop URL in JSON.** `/api/leads` returns `redirect_url = <formRoute>/provider?c=<continuation>`. The brand Worker resolves the opaque continuation in core and answers with a 302 to the prepop URL and `Referrer-Policy: no-referrer`. An unknown or expired continuation returns 302 to `/`.
3. **Postback goes to core.** LeadsGate calls `GET https://core.aduplift.ai/api/postback?token&cid&payout&lead_id&type` (Sold and Reject entries per brand domain).
   - `token` is a per-brand postback secret; a mismatch returns 401.
   - `payout` is parsed as a number; invalid or negative becomes 0; it is **clamped to 230** (USD, V1 `MAX_PAYOUT_USD`).
   - Every accepted postback is written to `postback_events`.
   - Every `soldLead` postback with payout > 0 (after the 230 clamp) also inserts a `conversion_uploads` row, idempotent per lead, whether or not the lead has a click ID. This is V1 parity (owner decision 2026-10-02, overriding the click-ID condition in brief CO-3).
4. **Conversion delivery is the existing drain, unchanged.** `GET /api/conversions/pending` (leased rows including `brand` and `hostname`) and `POST /api/conversions/ack` (`uploaded` / `failed` / `deferred`, V1 backoff, `dead` after 6 attempts) keep the V1 contract byte-for-byte. The VPS `drain.mjs` → AdKit → Google Ads path is not modified; only its base URL changes to core.
5. **Voluum is retired.** No Voluum tracking links, postbacks or click IDs anywhere in Anjuna.
6. Postback and drain routes exist **only** on core, never on brand domains. Core has a WAF skip rule for `/api/postback` and `/api/conversions/*` (spike: Cloudflare returned 403 to non-browser user agents).

## 2026-10-08 — Brand-domain application page (V1 parity)

The default prepop base is `/apply` on the brand domain. This page hosts the LeadsGate form via `https://apikeep.com/form/applicationInit.js`, as V1's `public/apply.html` does. LeadsGate attributes traffic and configures Sold/Reject postback entries per domain where its form runs. The provider's `Referrer-Policy: no-referrer` redirect to `/apply` stays same-origin; the application page also sets no-referrer and noindex and is never cached.

The page forwards only shared `BUYER_FIELDS` and the attribution aliases, with fixed `template: "fresh"` applied last (audit C-02). Public brand settings do not carry `aid`, so the page accepts a digits-only URL `aid`, which core sets from trusted `brand_runtime.aid`. This validates its format; it does not authenticate a manually substituted numeric ID.

## Consequences

- One money path, identical to V1 in behavior; drain and AdKit need no code change.
- LeadsGate configuration per brand is an owner checklist item (FA-4): postback entries pointing at core and a "Test sold" that creates a `postback_events` row.
- Revenue per conversion cannot exceed 230 even if LeadsGate sends more; raising it is a deliberate code change.
- Leads without a click ID still get a `conversion_uploads` row, so revenue is recorded; the drain / Google Ads side simply cannot upload them.
- Real LeadsGate and drain calls are owner-gated (Wave 4); tests use fakes.

> **Note:** brief CO-3 (click-ID condition for `conversion_uploads`) should be updated to match decision 3.
