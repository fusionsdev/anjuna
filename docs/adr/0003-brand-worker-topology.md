# ADR-0003: Brand Worker topology

- **Status:** Accepted
- **Date:** 2026-10-02
- **Brief refs:** BR-1, BR-2, BR-3, BR-10, BR-12, CO-2, CO-6, FA-1, §8, §9 (the brief's §8 lists this decision as "0006 (brand topology)")

## Context

Each brand is a static landing page plus the lead form on its own domain. Brands must not be linkable to each other or to the platform, and every visitor must see the same response (no cloaking). The 2026-10-02 spike proved a topology on real Cloudflare and hit two platform limits: a Worker fetching another Worker on the same zone gets **error 1042**, and a Custom Domain cannot attach while A/CNAME records exist on the hostname.

## Decision

1. **One Worker per brand,** with Custom Domains on the brand's apex and `www`. The script name is opaque. The Worker serves the static template and the form bundle from its own static assets with `run_worker_first = true`, so the Worker sees every path.
2. **Route allowlist with a uniform 404.** Only `/`, the legal pages, `/go`, `<formRoute>`, `<formRoute>/provider`, `/_f/*`, `/api/{leads,zip,telemetry,errors,health}` and the analytics proxy paths (ADR-0004) are served. Every other path returns the same 404. Admin, postback and drain routes never exist on brand domains.
3. **Core is one Worker on `core.aduplift.ai`** (Custom Domain). It owns D1 (ADR-0001), the postback and the drain (ADR-0002). Brand Workers have no D1 binding.
4. **Brand → core transport.**
   - Brand and core in the **same** Cloudflare account: Service Binding.
   - Brand in a **different** account: HTTPS to `core.aduplift.ai`.
   - In both cases the brand presents **one write-only credential per Cloudflare account** (a secret, never in git). Core's `/rpc/*` endpoints and its analytics forward endpoints (ADR-0004) require it and reject any `brand_id` that does not belong to the calling account. Service Bindings are never used across accounts.
   - Every brand Worker sets `compatibility_flags: ["global_fetch_strictly_public"]` so a `fetch` to core always goes out through the public edge and never hits error 1042.
5. **About 10 brand domains per Cloudflare account.** More brands means more accounts, each with its own credential, so one compromised credential or suspended account affects only its brands.
6. **The flow gate is action-based, never identity-based.** `/go` checks only what the visitor did: `requested_amount` is one of the brand's buckets and `zip` is 5 digits. Valid → 302 to `<formRoute>` with amount, ZIP, ad params and keyword; invalid, or direct access to the form route → 302 to `/` keeping ad params. No response varies by user agent, IP, ASN, referrer, gclid or bot detection. The `signed_cookie` mode (BR-3) is the same action-based gate with an HMAC cookie from core, built but off by default. The pause switch (BR-10) serves the same neutral page to everyone.
7. Brand Workers set `brand_id` and `hostname` from their own environment; the client never supplies them.

## Consequences

- Install is a Cloudflare API sequence per brand (assets → script → deploy → Custom Domain) run by the factory, with the spike's order: validate (zone active, token scopes, no A/CNAME on apex/www) → save rollback → … → attach Custom Domain → smoke e2e, with automatic rollback.
- A brand outage or rollback is isolated to one script; upgrades go canary first.
- Core is a single dependency for every brand. Click capture failure must not block the page; lead submit failure returns a retryable error.
- Cross-account calls pay one public HTTPS hop. That is accepted for isolation.
- Core needs a WAF skip rule for postback/drain paths (ADR-0002), not for `/rpc/*`, which is called only by Workers.
