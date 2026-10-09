# T6c lead RPC and live settings — FUS-341

`src/index.ts` registers `rpcRoutes` from `src/rpc/` through `createCoreHandler`.
All seven methods require the existing per-account bearer credential and `ownsBrand`.
Methods carrying a hostname also check it against the owned brand's configured hostnames.
No admin implementation, deployment, provider call or drain modification is included.

## Configuration and evidence

Core defaults to the form's `FORM_SITE_ID=form-default`, `FORM_VERSION=2026-01`,
`CONSENT_VERSION=consent-2026-02`, and `PARTNER_LIST_VERSION=partners-2026-01`.
Those environment overrides retain V1 validation semantics. Consent text is the current
form's two consent paragraphs joined with one newline; changing their wording requires
updating the version and the text in `src/rpc/consent.ts` together. A source-comparison test
checks the text against the form.

`HANDOFF_KEY` is a core-only Worker secret; `HANDOFF_KEY_ID` defaults to `1` (at most
16 URL-safe characters). Never put the key in brand config or Wrangler vars. Changing
the key invalidates old cookies. Tokens are HMAC-SHA256 signed and last 30 minutes.
Their payload includes brand ID, amount, ZIP hash, issue time, nonce and key ID, plus
the signed ZIP required by the existing `verifyHandoff` response. They are signed,
not encrypted; neither the key nor any provider credential is in the token.

The existing RPC JSON shapes are unchanged. For submission, the authenticated brand
Worker sends `x-consent-brand = encodeURIComponent(configured display name)` and
forwards `Sec-GPC` when present as `0` or `1`. Core requires the display-name header,
hashes the consent text, and records the name, version, timestamp, page URL, trusted
hostname, V1 `SHA256(ip:site_id)`, and forwarded user agent. Absent GPC is SQL NULL;
core never infers a negative signal. The brand replaces attempted browser header
overrides with its own config. Raw IP addresses are not stored.

Migration `packages/leads-db/migrations/0007_core_rpc.sql` adds hashed continuations,
explicit click ownership, consent hash/name/GPC evidence, and `brand_runtime.form_route`
(default `/request`). The installer must populate the brand's actual route and settings.
The frozen conversion table is unchanged.

## V1 behavior and the dedupe discrepancy

Port source: `fusion_formv_v1`, branch `anjuna-port-base`, commit
`8404ec27d95985b4eb3ff980a833a1b2f2fbeb05`, `functions/api/[[path]].ts`.
`src/rpc/validation.ts` identifies its source ranges. Both `lite_v1` and `full_v1`
follow the original validator. The lite form's unasked numeric fields use V1's `-1`
storage sentinel and are omitted from prepop. ZIP-derived state takes precedence.
ZIP and state never block routing: NY, AR, VT, WV and territories are accepted and
prepopped with their ZIP-derived state. An unknown ZIP is accepted and prepopped
without ZIP-derived state; a full form keeps its submitted state, as V1 does.
Invalid state input still fails validation.

The brief mentions email/phone dedupe within a V1 window. The pinned `handleLead`
(lines 333–508) only deduplicates by client `lead_id`; it contains no contact window.
This implementation preserves that source behavior, including accepting a fresh ID
with the same email/phone. A contact-dedupe window has been requested from the owner
and remains unspecified. No new contact rejection policy was invented.

New submissions return 201; duplicate IDs return 200 with a fresh continuation;
invalid input returns V1 4xx messages. Duplicate continuations refer to the persisted
lead for trusted identifiers and use the current validated applicant and ZIP-derived
state for prepop. A retry does not replace the stored lead's PII or attribution.
Cross-brand ID collisions cannot mint a continuation for another brand.

Click claim, lead, consent, continuation and mailing outbox commit in one D1 batch.
Only the successful claimant receives the session's server click IDs and attribution.
The trusted brand ID is stored in `leads.brand`; `leads.click_id` is exactly the client
lead ID with hyphens removed. This is the merged postback handler's lookup key.

Continuations are random 256-bit tokens, stored only as SHA-256 hashes, valid for
30 minutes and consumed by a conditional UPDATE. Unknown, expired, consumed or
other-brand tokens return 404. V1 BUYER_FIELDS, order, omission and URL encoding are
preserved, with the brand runtime's aid and prepop base. Relative `/apply` resolves
against the trusted lead hostname. Every continuation resolves to prepop; ZIP and
state never redirect to `/complete`.
The browser receives only its first-party continuation URL in submission JSON.

## Live settings

`brandSettings` returns exactly flow gate mode, pause, amount buckets, A/B config,
default keyword and form route. Secret fields and extra keys fail the response schema.
It shares existing admin field schemas; the admin contract's only change is moving
its identifier imports to `common.ts` to avoid a dependency cycle. Existing shapes
and goldens are unchanged.

Brand runtime caches settings for 60 seconds in memory, coalesces concurrent refreshes,
and keeps caches separate by CoreClient and brand. Failures, timeouts and invalid
responses use static `BRAND_CONFIG`; a failed refresh is retried after 60 seconds.
The example retains its client/handler across requests so that cache is effective.
Pause/resume and new A/B weights are visible on the next refresh without redeploying.
Existing A/B assignments stay sticky. Settings apply equally to all visitors.

## Acceptance evidence

| Criterion | Status and evidence |
| --- | --- |
| Existing and new contract goldens | PASS: contracts suite, including public settings secret-field rejection and both pinned-source provenance checks |
| V1 lite/full validation | PASS: `validation.test.ts`, 52 fixture/mutation comparisons with the pinned V1 validator |
| Site ID, consent evidence, ZIP-derived prepop state, stored attribution, 201/200/4xx | PASS: `rpc.test.ts` V1 lead path cases |
| V1 idempotency | PASS: concurrent duplicate submissions produce one lead/outbox; separate test confirms pinned contact behavior |
| Email/phone dedupe window in brief | UNRESOLVED: no such rule/window exists in the pinned source; owner clarification pending |
| Atomic click claim and outbox | PASS: concurrent claim test, cross-brand claim test and forced outbox failure/rollback/retry test |
| Continuation TTL, single use and V1 URL bytes | PASS: concurrent resolve, expiry, cross-brand token and golden/relative prepop tests |
| ZIP and signed handoffs | PASS: ZIP padding/404; HMAC signature, brand, tamper, expiry and amount checks |
| Every RPC checks brand ownership | PASS: parameterized authentication/ownership cases for all seven routes |
| Complete local money path | PASS: Miniflare brand → recordClick → submitLead → provider 302 → postback with exact cid → conversion queue → pending with brand and hostname |
| Live cache and fallback | PASS: brand runtime cache expiry, concurrent refresh, pause/resume, weights, settings, failures, timeout, identity isolation and provisioned entrypoint tests |

Verified on 2026-10-02 in an isolated Ubuntu WSL clone of the committed implementation:

```text
bun install --frozen-lockfile                                      PASS
bun run build                                                     PASS (12 tasks)
bun run typecheck                                                 PASS (16 tasks)
V1_DIR=/mnt/h/w/_v1 FORM_DIR=/mnt/h/w/_form \
  bun run test --env-mode=loose --continue                          PASS (18 tasks)
```

**604 tests passed, 0 failed, 0 skipped:** core 154; brand runtime 144 (141 Worker
tests + 3 asset-router tests); contracts 158; leads-db 19; auth-db 11; factory-db 8;
mailing 6; insights 18; lead-form 28; keyword-slot-react 9; template starter 6;
web 43. Both port checkouts match their pinned commits. No providers were called:
outbound Worker requests are blocked and the prepop redirect is inspected manually.

Native Windows install/build and focused typecheck also passed. Native core tests
hit `connect EADDRINUSE` while opening Miniflare loopback connections, so WSL supplied
the complete green run. Unrelated Windows processes were left alone. The existing
form chunk-size warning and mailing build-output warning remain unchanged.

## Proposed (out of scope)

- Clarify whether to add contact-based dedupe and, if so, its window and matching/scope rules.
- The installer/admin workflow must populate each brand's actual `form_route`; adding a
  form-route editor or changing the existing admin contract is outside this brief.
