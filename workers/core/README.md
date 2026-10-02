# Core Worker — FUS-341, T6a/T6b/T6c

The public Worker serves `GET /api/health`, `GET|POST /api/postback`,
`GET /api/conversions/pending`, `POST /api/conversions/ack`, and the seven
authenticated `POST /rpc/*` methods. Every other
path/method returns the same `404 Not Found`. Health is exactly `{"ok":true}`.
Lead submission, continuations, signed handoffs and live brand settings are documented in
[RPC.md](RPC.md). Analytics forwarding and admin handlers are separate tasks.

## Configuration and authentication

`wrangler.jsonc` pins `anjuna-core`, the AdUplift account and Custom Domain
`core.aduplift.ai`. Both D1 IDs are placeholders. It disables workers.dev and
preview URLs. `LEADS` and `FACTORY` use their packages' migration directories.
`DRAIN_TOKEN` is a Worker secret; no secret value is in configuration.

- RPC middleware identifies the account by the SHA-256 hash of its bearer
  credential in `account_credentials`. Comparisons use Workers'
  `crypto.subtle.timingSafeEqual`. `ownsBrand` checks account ownership. A route
  exercising both exists in the test worker; every production RPC also checks ownership.
- Postback joins the cleaned `cid` to `leads.click_id`, then `leads.brand` to
  `brand_runtime.brand_id`. **T6c integration:** core writes the trusted
  opaque brand ID into `leads.brand`. Neither the callback's buyer `lead_id` nor
  its other parameters select a brand. A token for another brand cannot authorize
  a known lead. Query-token precedence and Authorization fallback retain V1 behavior.
- An unknown/missing `cid` still requires a configured brand token. After token
  verification it retains V1's `ignored/unknown_click` or `400 Invalid postback`
  response, with no database writes. This preserves authenticated unmatched callback
  behavior while replacing V1's global postback secret with per-brand hashes.
- Drain authentication is header-only and preserves V1's trimming/prefix behavior.
- The public entrypoint never routes `/admin/*`, including requests with an
  internal-looking hostname or spoofed headers. The panel must bind to named
  entrypoint `AdminService` and use an internal URL such as
  `https://core.internal/admin/...`. That entrypoint also rejects the public
  hostname. It currently has no handlers. Named entrypoints are reached through
  explicit Service Bindings ([Cloudflare documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)).

Migration `0006_account_credentials.sql` is the brief's authorized leads-db addition.
The package's migration manifest and existing table-list assertions register it;
no existing table or contract shape changes.

## V1 parity

Port source: `fusionsdev/fusion_formv_v1`, branch `anjuna-port-base`, commit
`8404ec27d95985b4eb3ff980a833a1b2f2fbeb05`, `functions/api/[[path]].ts`.

The postback batch retains V1's conversion enqueue, per-event dedup and sold-status
guard. A paid sale queues even without click IDs. A paid replay after a zero sale
queues the conversion while retaining the original event and duplicate response.

Pending/ack retain V1's SQL: atomic claims, 30-minute stale leases, bounded crash
reclaims, five-minute exponential retry backoff, dead after six failed attempts,
and deferral without consuming an attempt. T3 encoders determine response bytes.
V1's HTTP parsing treats an absent `limit` as 1 (`Number(null)` then clamping);
core preserves this without changing `PendingQuery`'s standalone schema default.
The drain always sends an explicit limit.

## Acceptance evidence

Run from the repo root: `bun install`, `bun run build`, `bun run typecheck`,
`bun run test`. The core suite uses real Miniflare D1 databases with both migration
sets and blocks outbound Worker fetches. No deployment is part of these scripts.

| Criterion | Evidence |
| --- | --- |
| Worker config, minimal health, uniform allowlist | `skeleton and authentication` tests |
| Hashed account auth, ownership and rotation | Missing/wrong credential cases and account/brand/rotation test |
| Per-brand postback auth | Missing/wrong/other-brand token cases and unset/malformed hash test |
| Drain auth and Service Binding-only admin | Header-only drain cases; named entrypoint and spoofed-host tests |
| All 10 V1 postback fixtures | `postback V1 goldens` executes each fixture via both GET and POST (20 cases) |
| Conversion idempotency and no-click sales | Concurrent/repeated callback test and zero-to-paid replay test |
| Atomic writes and monotonic sold status | Batch rollback test and late newLead/rejectLead test |
| V1 drain wire bytes | Unmodified `packages/contracts/test/v1/drain.mjs` against a local relay to core; exact pending/ack request/response bytes |
| Peek and empty-queue behavior | Actual drain validate-only and empty-queue tests |
| Lease/backoff/dead/deferred behavior | `pending/ack leases and retries` and mixed-ack golden tests |
| No user-agent gating | Health and postback UA matrix, including AdsBot and curl |

The drain child process receives only test configuration and an empty PATH, so it
cannot execute AdKit. An empty routing map defers Google rows and absent Microsoft
configuration fails the Microsoft row locally, exactly as in T3's goldens.

The golden pending fixture includes an orphan conversion. D1 foreign keys prevent
creating one through normal writes, so the test hides its parent behind a temporary
view. This exercises V1's missing-lead fallback without changing the conversion
table or disabling its constraints. Test transport responses are consumed fully.

### Verification on 2026-10-02

An isolated WSL copy passed `bun install --frozen-lockfile`, `bun run build`,
`bun run typecheck`, and `V1_DIR=/mnt/h/w/_v1 bun run test --env-mode=loose`:
**312 passed, 2 skipped**, including **61 core tests**. The two optional skipped
tests require the separate form-source checkout; all three V1 core provenance
checks ran. The final test run used no Turbo cache.

Native Windows build/typecheck and dependency restoration passed. Native core test
runs encountered `connect EADDRINUSE` while four pre-existing workerd processes
held about 14,000 bound sockets. Those processes were left untouched; Linux
validation used the same source files and lockfile in an isolated filesystem.

## Proposed (out of scope)

- If the drain needs a human routing label instead of the stored opaque brand ID,
  agree an explicit mapping with its owner. T6c follows the brief's `brand = brand_id` join.
- Wire the panel's Service Binding to `AdminService` when implementing admin handlers.
- Reconcile the T3 standalone missing-limit default with V1's actual HTTP boundary
  if the owner wants to revise that shared helper. Existing fixture shapes remain unchanged.

## Cron Triggers (CO-7, FA-5)

`wrangler.jsonc` declares two crons; `src/cron.ts` dispatches on the exact string and ignores any other.

- `*/5 * * * *` **mailing**: `syncOutbox` (up to 5 batches of 50 per run; the rest waits for the next trigger), then
  `syncSuppressions` back into `suppressions`. A listmonk outage throws, so the run shows as failed; rows stay pending
  with backoff and no lead is lost. It skips with a log line, and makes no request, until the secrets `LISTMONK_URL`,
  `LISTMONK_USER`, `LISTMONK_TOKEN` and `LISTMONK_LIST_MAP` (JSON `{"<brand_id>": <list id>}`) are all set and valid.
- `*/15 * * * *` **alerts**: `runAlerts` as of the scheduled time. The notifier (console for now) only receives the report
  when some alert is `warn` or `alert`. Submit error counts need Analytics Engine, so that source is empty (always ok) until then.
