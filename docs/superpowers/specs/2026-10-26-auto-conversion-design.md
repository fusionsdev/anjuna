# Auto-create the Google Ads conversion action per brand (FUS-384)

Owner request 2026-10-26: a brand with a Google Ads account gets its offline conversion action created automatically, so nobody creates one by hand. Linear FUS-384 holds the owner-approved design and acceptance.

## 1. Decisions (owner, 2026-10-26)

- The drain VPS runs the create through the AdKit CLI. Cloudflare Workers never call AdKit and hold no AdKit key.
- The conversion name is random and unique. It never contains the brand id, a hostname or a brand name.
- Settings: type `upload_clicks`, category `purchase`, status `enabled`, Primary, counting `one`, default value 0 USD.
- No real AdKit or Google Ads call in this PR (AGENTS.md rule 7). Tests inject the AdKit runner and `fetch`.

## 2. Flow

Every 10 minutes, after `refresh-routing.mjs`, the drain runs `conversion-sync.mjs`:

1. `GET /api/conversions/setup/pending` lists brands that need a conversion action.
2. Per brand, `adkit manage google conversions list --account <a> --limit 500 --json [--project <p>]` returns the existing conversions as name to `platformId`.
3. The drain picks a name. A brand with a stored name (an earlier claim for the same account) reuses it. Otherwise the drain generates `cv-` plus 16 lowercase hex characters from `crypto.randomBytes(8)` and regenerates while the name already exists in the account, up to 5 tries.
4. `POST /api/conversions/setup/claim` with `{ brand_id, name }`. Core stores the name before any create. Core answers with the claim id and the name to use (the stored name wins over the proposed one).
5. When that name already exists in the account (a crashed earlier run created it), the drain adopts its `platformId` and creates nothing.
6. Otherwise the drain runs `adkit manage google conversions create --account <a> --data <json> --publish --json [--project <p>]` and parses the new id. When the create fails with a duplicate-name error, the drain lists again and adopts the id of that name.
7. `POST /api/conversions/setup/result` with `{ brand_id, claim_id, conversion_action_id }` or `{ brand_id, claim_id, error }`.
8. The next `refresh-routing.mjs` run includes the brand, because `brand_runtime.google_conversion_action` is now set.

`--dry-run` runs steps 1 and 2, prints one `plan` line per brand with the name it would claim, and writes nothing to core or AdKit.

## 3. Duplicate prevention

- The name is stored in core before the create (step 4). A retry after a crash or a failed record finds that name in the account (step 5) and adopts it.
- The claim is one atomic D1 statement per brand. A live claim (younger than 30 minutes) blocks every other claim, so two drains or two overlapping runs never create for the same brand at once.
- The result write sets `google_conversion_action` only while it is still NULL and the account still equals the claimed account. A repeated result for the same claim answers 200 with `already: true` and writes no second audit row.
- The create always passes `--publish`. Without it AdKit makes a draft and returns no Google Ads id.

## 4. Core data (leads-db migration `0018_conversion_setup.sql`)

```sql
CREATE TABLE conversion_setup (
  brand_id        TEXT PRIMARY KEY,
  account         TEXT NOT NULL,            -- google_ads_account at claim time
  name            TEXT NOT NULL,            -- the opaque conversion name, fixed per (brand, account)
  status          TEXT NOT NULL CHECK (status IN ('claimed', 'created', 'failed')),
  claim_id        TEXT NOT NULL,
  claimed_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,                     -- failed rows only: earliest next claim
  last_error      TEXT,                     -- failed rows only, at most 500 characters
  conversion_action_id TEXT,                -- created rows only
  updated_at      TEXT NOT NULL
);
```

Column CHECKs bound shapes: `account` is 10 digits, `name` matches `^cv-[0-9a-f]{16}$`, `conversion_action_id` is NULL or 1 to 20 digits.

A brand needs a conversion action when `google_ads_account IS NOT NULL AND google_conversion_action IS NULL`. It is eligible for a claim when it needs one and one of these holds:

- no `conversion_setup` row, or a row whose `account` differs from the current `google_ads_account` (the account changed: the row restarts with attempts 0 and the new name);
- `status = 'claimed'` and `claimed_at` is older than 30 minutes (a crashed run);
- `status = 'failed'`, `next_attempt_at <= now` and `attempts < 5`.

A `created` row whose brand has `google_conversion_action` NULL again (the owner cleared it in the panel) is eligible as well, with the account rule above. Same account keeps the same name, so the drain adopts the existing conversion.

Failure backoff: `next_attempt_at = now + 1 hour * 2^(attempts - 1)`, capped at 24 hours. After 5 failed attempts the row stays `failed` until the account changes or the owner sets a conversion action by hand.

## 5. Core endpoints (drain token, `Authorization` header only, like `/api/conversions/routing`)

All three answer 401 `{ status: "invalid", message: "Unauthorized" }` without a valid token. A `?token=` query parameter is never accepted.

- `GET /api/conversions/setup/pending` returns `{ brands: [{ brand_id, account, project, name }] }` for every eligible brand, ordered by `brand_id`. `project` is `adkit_project` or null. `name` is the stored name when a row exists for the same account, else null. Read-only.
- `POST /api/conversions/setup/claim` body `{ brand_id, name }`. `name` must match `^cv-[0-9a-f]{16}$` (400 otherwise). Answers:
  - 200 `{ status: "claimed", claim_id, name, account, project }` when the claim statement changed 1 row. `claim_id` is `crypto.randomUUID()`. `attempts` is unchanged by a claim.
  - 409 `{ status: "busy" }` when a live claim exists or the brand is not eligible.
  - 404 `{ status: "invalid", message: "Unknown brand_id" }` for an unknown brand.
- `POST /api/conversions/setup/result` body `{ brand_id, claim_id, conversion_action_id }` (1 to 20 digits) or `{ brand_id, claim_id, error }` (1 to 500 characters). Answers:
  - 200 `{ status: "created" }`: the row becomes `created`, `brand_runtime.google_conversion_action` is set with a new `updated_at` (same `nextTimestamp` rule as the panel PATCH), and one Factory `audit_log` row is written: actor `drain`, role `system`, action `brand.conversion_create`, entity `brand`, before `{ google_conversion_action: null }`, after `{ google_conversion_action, name, account }`.
  - 200 `{ status: "failed" }`: the row becomes `failed`, attempts + 1, backoff set, one audit row with action `brand.conversion_create_failed` and after `{ error, attempts, name, account }`.
  - 200 `{ status: "created", already: true }` when the same claim already recorded the same id. No write.
  - 409 `{ status: "stale" }` when the claim id does not match the row, the row is not `claimed`, or the brand account changed since the claim. On an id result with a changed account the drain logs the orphan conversion name and id.
  - 409 `{ status: "stale" }` when `google_conversion_action` was set by hand meanwhile. The row still becomes `created` with the drain's id so the name is not reused.

Bodies over 4 KB answer 413. Unknown fields answer 400 (strict schemas in `@anjuna/contracts`).

## 6. Panel

- New admin endpoint `GET /admin/brands/:id/conversion-setup`, owner only (`min_role: "owner"`), returns `{ conversion_setup: { status, error, name, conversion_action_id, attempts, updated_at } }`:
  - `none` when the brand has no Google Ads account;
  - `created` when `google_conversion_action` is set (a hand-set action has `name` null);
  - `failed` with `error` and `attempts` when the row is `failed`;
  - `pending` otherwise (no row yet, or a live claim).
- The panel route `GET /api/brands/:id/conversion-setup` forwards it with the existing `authorize` + `callCore` pattern. The mock core serves a fixture.
- The money section (`MoneySection` in `ConfigPanel.tsx`) shows one status line under the conversion action field: `รอสร้างอัตโนมัติ (Pending)`, `สร้างแล้ว (Created)` with the name, or `สร้างไม่สำเร็จ (Failed)` with the error and attempts. `none` shows nothing. The line never blocks saving.

## 7. Drain files

- `scripts/drain/conversion-sync.mjs [--dry-run]`, plain Node 20, no dependencies. Exports `generateName`, `pickUniqueName`, `conversionCreateArgs`, `conversionListArgs`, `parseAdkitJson` (same JSON-tail rule as `spend-sync.mjs`), `conversionsByName`, `createdConversionId`, `syncConversions`. `runAdkit` and `fetchImpl` are injectable.
- `createdConversionId` reads the id from `platformId`, `id`, `conversionActionId` or a `customers/<c>/conversionActions/<id>` resource name, at the top level or under `conversion` / `result` / `data`. A value that is not 1 to 20 digits is an error.
- The create `--data` JSON is `{ name, type: "upload_clicks", category: "purchase", status: "enabled", countingType: "one", defaultValue: 0, currency: "USD", alwaysUseDefaultValue: false, isPrimary: true }`. One builder function holds every flag so the rollout can adjust them in one place.
- One failing brand does not stop the others. Any failure makes the exit code 1. Output lines: `conversion-sync: <brand> created <id> name=<name>`, `... adopted <id>`, `... failed: <error>`, `... busy`, and a final `conversion-sync: N created, N failed`.
- `scheduler.mjs` and `run.sh` run it after `refresh-routing.mjs` on every tick, before `drain.mjs`, only when the file is present. A failure is logged and the tick continues. Routing picks up a new action on the next tick.
- `README.md` gets a `conversion-sync.mjs` paragraph and the copy lists include it.

## 8. Out of scope

- A panel retry button for a brand that failed 5 times.
- Deploy, remote D1 migration and the VPS rollout (main session after merge).
