# ADR-0005: AdKit runs on the VPS, the panel writes jobs

- **Status:** Accepted
- **Date:** 2026-11-07
- **Brief refs:** §3 Non-goals ("Direct Google Ads API work. AdKit is used only by the existing drain."), CO-4, AGENTS.md hard rules 5 and 7
- **Spec:** `docs/superpowers/specs/2026-11-07-panel-redesign-design.md`, section "Decisions", AdKit bullet
- **Numbering:** the brief's §8 reserves "0005" for "postback to core". That decision is recorded as ADR-0002, so this file takes the number 0005.

## Context

The panel's new-brand wizard step 4 is four empty text fields: Google Ads account, conversion action, AdKit project, Microsoft account. The owner types ids by hand. 29 brands wait for a per-brand route and "Test sold". The redesign needs project and account selects filled from AdKit, and a conversion action created from the panel.

The brief's non-goal says AdKit is used only by the existing drain. That was written when AdKit only uploaded conversions. Since FUS-384 the VPS job `scripts/drain/conversion-sync.mjs` already runs `adkit manage google conversions create ... --publish` and `scripts/drain/spend-sync.mjs` already runs `adkit manage google results`. Both talk to core with the drain token. The non-goal no longer describes the code.

Workers cannot run the `adkit` CLI. The AdKit API key is a credential that would sit in Worker secrets on core and on the panel Worker.

## Decision

1. **Workers never hold an AdKit key.** No Worker, in any installation, calls AdKit or the Google Ads API. No Worker env var, secret or binding carries an AdKit credential.
2. **The VPS drain host runs `adkit`.** `adkit` and its credentials exist only on the host that already runs `drain.mjs`, `conversion-sync.mjs` and `spend-sync.mjs`.
3. **The panel writes jobs to D1. The VPS executor claims them and posts results.** The queue follows the pending, claim, result pattern of `workers/core/src/conversion-setup.ts`:
   - The panel (or a scoped `/api/v1` key) inserts a job row into `adkit_jobs` with an `idempotency_key`.
   - The executor on the VPS lists pending jobs, claims one atomically, runs `adkit`, and posts the result.
   - Core routes for the executor use the existing drain token, in a header only.
4. **Directory data comes from the VPS.** A VPS script syncs AdKit projects, accounts and conversion actions into `adkit_directory` hourly. The wizard reads selects from that table, never from AdKit.
5. **The executor has an allowlist.** Only `accounts list`, `conversions list`, `results list` and `conversions create` can run. Any other subcommand is rejected before a process is spawned.
6. **Conversion actions are created with `--publish`.** This is the existing `conversion-sync.mjs` behavior.
7. **`drain.mjs` stays frozen.** The executor is a separate script. ADR-0002 decision 4 and brief CO-4 are unchanged.
8. **Campaigns are drafts until an owner enables them.** Any campaign created through a job is created as a draft. Enabling a campaign is an owner action. No job kind enables, resumes or changes the budget of a campaign. Campaign creation UI is V2 and has its own spec.
9. **A retried job does one thing.** A retry reuses the job's `idempotency_key`. The `UNIQUE` constraint on that key keeps one row, and on a duplicate-name error from AdKit the executor lists the account's conversion actions and adopts the existing id, as `conversion-sync.mjs` does today.
10. **Stale data shows as "—".** Directory and spend data older than 2 hours is not shown as a number.

## Consequences

- AdKit credentials stay on one host that the owner already operates. A Worker leak exposes no ad-account access.
- The panel cannot act on AdKit in real time. A job waits for the next executor run, so the UI shows queued, claimed, done and failed states, not an instant result.
- A VPS that is down stops new conversion actions and directory refreshes. The conversion upload path (drain, ADR-0002) is unaffected because it does not depend on the job queue.
- The executor is new code on the VPS. Its install is an owner action behind the Wave 4 gate. Tests use fixtures and an empty `PATH`, and no test calls AdKit.
- `docs/PRODUCT-BRIEF.md` §3 no longer lists AdKit as drain-only. It points to this ADR. AGENTS.md line 3 still describes AdKit as the drain's upload path and needs the same pointer.
- Campaign enable stays a human decision, so a bug in the panel or a leaked scoped key cannot start ad spend.

## Rejected

- **A Worker calls AdKit over HTTP with an API key.** It removes the VPS hop and gives instant results. It puts an AdKit key in Worker secrets on core and on every installation, including maimax. A leak would give write access to every connected ad account. The spec also lists whether AdKit's key can call an HTTP endpoint as unverified, so the option is not available yet.
- **The panel shells out to `adkit`.** Workers have no process runtime.
- **Free-text ids in the wizard (status quo).** A typo in an account or conversion action id surfaces only when the drain fails to upload.
