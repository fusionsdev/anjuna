# ADR-0004: Same-origin tracking

- **Status:** Accepted
- **Date:** 2026-10-02
- **Brief refs:** BR-1, BR-5, BR-6, BR-11, FO-3, FO-4, AGENTS.md hard rule 4 (the brief's §8 lists this decision as "0007 (same-origin tracking)")

## Context

Conversions need the Google click ID from the ad click attached to the lead. Product analytics (PostHog) and error reporting (Sentry) are needed on the landing page and form. Third-party script hosts, client-side keys and cross-site cookies would put platform identifiers into every brand's bytes, link brands together and are often blocked. Brand bytes must contain no PostHog key, no Sentry DSN and no other brand's identifiers.

## Decision

1. **Server-side click ledger.** On landing navigation and on `/go`, when the URL carries a click ID (`gclid`, `gbraid`, `wbraid`, `msclkid`), the brand Worker records the click in core (`click_sessions`, V1 behavior: click IDs, keyword, `utm_*`, brand, hostname). At lead submit core claims the click session once (V1 single-use claim) and copies its click IDs onto the lead.
2. **Neutral first-party click cookie.** The brand Worker sets a cookie with a short, neutral name holding only the opaque `click_session_id`: `HttpOnly; Secure; SameSite=Lax; Path=/`. No click IDs or PII are stored in the cookie, and client JavaScript cannot read it. The brand Worker reads it on `/api/leads` and passes it to core.
3. **Capture never blocks.** If core is slow or down, the page still loads without the cookie (short timeout, errors swallowed).
4. **PostHog through a first-party proxy path** on the brand domain. The client is configured with a placeholder key and `disable_compression`. The brand Worker only forwards the request (size-capped, no key swap) to core over the ADR-0003 transport: Service Binding in the same account, HTTPS + the per-account write-only credential across accounts. Core swaps the placeholder for the real project key server-side and forwards to PostHog.
5. **Sentry through a first-party tunnel path** on the brand domain. The client uses Sentry's `tunnel` option with a placeholder DSN. The brand Worker only forwards the envelope (size-capped, no DSN swap) to core over the same transport; core replaces the DSN in the envelope header server-side and forwards to Sentry.
6. **No keys in bundles or brand Workers.** The real PostHog key and Sentry DSN are secrets of core only. Brand Workers, the form bundle, templates and runtime config (`<script id="cfg">`) carry only the proxy paths and placeholders. The proxy paths are in the brand route allowlist (ADR-0003).
7. Tracking never changes what a visitor is served (ADR-0003 rule 6).

## Consequences

- Attribution survives ad blockers and third-party cookie limits because everything is same-origin.
- The CI identity scan (FO-4, TP-3) can fail a build on any PostHog key, Sentry DSN, "anjuna" or "aurum" string.
- The brand Worker carries proxy forwarding code but no extra secrets; it size-caps what it forwards.
- Core exposes the analytics forward endpoints and needs per-path size caps and rate limits on them; they require the per-account credential like `/rpc/*`.
- Clicks without a click ID are not ledgered; organic visits have no conversion path, as in V1.
- A/B assignment uses its own sticky first-party cookie (BR-9); it is not part of this decision.
