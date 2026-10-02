# Brand runtime — FUS-342 / T7

`createBrandWorker(config)` returns a Worker-compatible `{ fetch(request) }` handler. It serves one brand's certified assets and sends lead operations through the existing `LeadsRpc` Zod contracts. Nothing in this package deploys infrastructure or calls providers directly.

```ts
import { createBrandWorker, HttpsCoreClient } from "@anjuna/brand-runtime";

export default {
  fetch(request, env) {
    return createBrandWorker({
      brand_id: "b-000001",
      hostname: "example.com", // canonical apex, never taken from the submitted payload
      brand: "Example Brand",
      formRoute: "/request",
      amount_buckets: [500, 750, 1000, 1750, 3000, 5000],
      core: new HttpsCoreClient({ credential: env.CORE_TOKEN }),
      assets: env.ASSETS,
      ab_config: {
        experiment_id: "form1",
        variants: [{ id: "lite_v1", weight: 70 }, { id: "full_v1", weight: 30 }],
      },
    }).fetch(request);
  },
};
```

The default gate is `param`, the default variant is `lite_v1`, and the brand is active. `flow_gate_mode: "signed_cookie"` enables core-issued 30-minute handoffs. Network failures, timeouts, and core 5xx errors fall back to the same param validation; invalid/expired signatures and authorization errors redirect home. `onGateFallback(operation)` can emit an operational alert; the default logs `flow_gate_fallback` without visitor details. Core operations have a 3-second deadline, configurable as `coreTimeoutMs`.

The runtime validates settings against the existing amount and A/B schemas. Weights are integer percentages totaling 100. `_ab` contains the experiment ID and lowercase variant, and lasts 30 days. Existing assignments survive weight changes (including zeroing an arm); a new experiment ID or a removed arm triggers a new draw. With no experiment, `default_variant` is used without a cookie. Experiment IDs are sent to core only; the public `cfg` shape is unchanged.

`_vc` holds an opaque click-session ID for 30 days. `_vh` holds the signed handoff. All three cookies are host-only, HttpOnly, Secure, SameSite=Lax, Path=/. Click capture uses the contracts' V1 trigger and parameter lists and never prevents landing or `/go` responses during a core outage.

**Transport and live settings.** `ServiceBindingCoreClient(env.CORE, { credential })` and `HttpsCoreClient({ credential })` implement the same `CoreClient`. Both use the contract's authenticated JSON `/rpc/*` endpoints, validate request/response bodies, and prevent credential-bearing redirect following. HTTPS defaults to `https://core.aduplift.ai`. Only core stores real PostHog/Sentry credentials. A config loader, `createBrandWorker(() => loadSettings())`, can supply refreshed pause/gate/A/B settings without rebuilding the Worker. The loader must provide `core` and `assets` as well; this package does not invent a runtime-config RPC absent from T3.

The example reads `BRAND_CONFIG` from server environment JSON, `CORE_TOKEN` from a Worker secret, and optionally `CORE` from a same-account Service Binding. Do not put the token in Wrangler vars or the public config. There is no D1 binding.

**Assets and routing.** Copy `example/wrangler.jsonc` and replace the example host/config with the brand's values. Use its `run_worker_first` array (also exported as `RUN_WORKER_FIRST`): all routes reach the allowlist except published files under `/_f/assets/`, `/assets/`, `/_astro/`, and the two favicon paths. These public asset directories must contain only certified browser assets, never internal HTML, manifests with private data, source maps with secrets, or alternate 404 pages. The landing lives at `/index.html`, legal assets at `/<legal>/index.html`, and the form at `/_f/index.html`; their direct public URLs are rejected.

Keep `html_handling: "none"` so the binding does not redirect internal asset fetches, and `not_found_handling: "404-page"` with the supplied root `404.html` containing exactly `Not Found` (no newline). An excluded asset path does not fall back to the Worker when its file is missing, so the static 404 is needed for a uniform response body. The tests exercise the real Miniflare asset router, not just the handler. Published assets bypass the Worker even during pause; landing, form, and API responses remain paused identically for everyone. [Cloudflare asset routing](https://developers.cloudflare.com/workers/static-assets/binding/).

The runtime redirects `www` requests it receives to the configured HTTPS apex, preserving path/query. To canonicalize **asset paths that bypass the Worker** as well, the installer must provision a zone-level www-to-apex redirect rule. This cannot be expressed in the path-only `run_worker_first` array. Domain-level redirects are not supported in Workers `_redirects` files. No zone rule is deployed by this package. [Cloudflare redirects](https://developers.cloudflare.com/workers/static-assets/redirects/).

**Analytics forwarding.** Public proxy defaults match the config fixture: `/_t` (and its subpaths) for PostHog, `/_e` for the Sentry tunnel. Configure the client with a placeholder key/DSN, same-origin paths, and PostHog `disable_compression: true`; bundle the SDK as a static asset. `/api/telemetry` and `/api/errors` are also forwarded. Only POST is accepted. Compressed HTTP bodies are rejected; actual streamed byte caps are 256 KiB PostHog, 1 MiB Sentry, and 64 KiB each telemetry/errors. Successful forwarding returns an empty 204; core responses and headers are never reflected.

ADR-0004 defines the transport but T3 has no analytics-forward endpoint schema. `TransportOptions.analyticsPaths` therefore explicitly maps `posthog`, `sentry`, `telemetry`, and `errors` to paths agreed with core. The transport posts `{ brand_id, hostname, kind, path, content_type, body }`; `body` is the original text and `path` is the proxy suffix. Query strings, client authorization, cookies, IP and user agent are not forwarded here. No key or DSN swap happens in the brand Worker. The example accepts this path mapping via `CORE_ANALYTICS_PATHS`; missing mappings return neutral 503s instead of silently dropping events. Finalize this shared interface with T6 before enabling production analytics.

**Validation and acceptance evidence.** `bun run test` runs Vitest in Workers (including real HTMLRewriter and the provided `MockCoreClient`) and a separate Miniflare asset-router suite. All outbound requests in the router suite are blocked. `@anjuna/brand-runtime/testing` exports the in-memory mock; it has no network access and records typed RPC calls.

Verified from the repository root: `bun install`, `bun run build` (8 packages), `bun run typecheck` (8 packages), and `bun run test` all passed. Tests: 135 in this package, 383 total passed, 5 existing optional legacy source-provenance tests skipped because `V1_DIR` / `FORM_DIR` were not configured. No production deployment or external service validation was performed. These checks ran with Bun's generated workspace lockfile registration; that root-file change was restored to respect the package-only assignment.

| Criterion | Evidence |
| --- | --- |
| BR-1 allowlist, uniform 404, legal/static/API routes | `worker.test.ts`: `route allowlist`; `assets.test.ts`; `assets-routing.node.test.ts` |
| Array-based Worker-first routing, static quota bypass | `assignment.test.ts`: example configuration; `assets-routing.node.test.ts`: public bundles bypass runtime |
| www apex redirect | `worker.test.ts`: configured HTTPS apex; real asset-router navigation test; static-host rule is a factory prerequisite described above |
| BR-2 param gate and retained ad params | `worker.test.ts`: `param gate` |
| BR-3 signed gate, expiry, fail-open and timeout | `worker.test.ts`: `signed cookie gate` |
| BR-4/BR-5 keyword, XSS, cfg escaping, CTA inputs | `worker.test.ts`: `keyword and runtime config` |
| BR-6 click RPC, nonblocking failures, host-only cookie | `worker.test.ts`: `click capture` |
| BR-7 server identity, V1 payload, IP/UA consent evidence | `worker.test.ts`: `lead submit and continuation` |
| BR-8 valid/bogus provider hops, no-referrer | `worker.test.ts`: end-to-end fake submit/provider hop and unknown/expired token cases |
| BR-9 10,000 visitors within ±2%, sticky 30-day cookie | `assignment.test.ts`: weighted assignment, weight changes, new experiments, lowercase ID validation |
| BR-10 pause identical for all; AdsBot parity | `worker.test.ts`: `pause and visitor parity` |
| BR-11 capped same-origin analytics forwarded to core | `analytics.test.ts`; both transports in `core-client.test.ts` |
| BR-12 Service Binding / HTTPS, Bearer auth, compatibility flag | `core-client.test.ts`; example configuration assertion |
| Brand-clean response bodies | forbidden keyword reflection tests, runtime config schema, neutral errors, and sealed public assets; no existing contract shapes changed |

**Proposed (out of scope).** T6/T3 should define the shared analytics-forward contract and authenticated live brand-settings endpoint; T10 should supply those settings, map analytics endpoints, package the exact static 404, and provision the www zone redirect during its owner-gated install. Update the old `run_worker_first=true` wording in ADR-0003/BR-1 to match this brief's array requirement. Root `bun.lock` workspace registration must be regenerated by the integrator; it is outside the explicitly assigned package boundary.
