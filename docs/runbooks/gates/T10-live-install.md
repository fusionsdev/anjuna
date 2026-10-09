# T10 live acceptance: install on the test domain

Acceptance (`docs/TASKS.md` T10): an install on the test domain reaches READY; a re-run creates nothing new; rollback works; a deliberately failed step rolls back automatically. Test domain: `levellendings.com`.

The code and the workflow tests are not on `main` yet. They are in PR #40 (workflow tests in `workers/factory/test/`).

## Preconditions

- [ ] PR #43 is merged into #40 (done 2026-10-07) and #40 is merged into `main` by the owner.
- [ ] Release tag `v*` pushed by the owner, and the `deploy.yml` run is green. **Note:** `deploy.yml` deploys `anjuna-core` and `anjuna-web` (panel) only. It does not deploy `anjuna-factory`, and PR #40 does not change that. The repo has no other factory deploy path (`workers/factory` `build` is `wrangler deploy --dry-run`). It applies leads, factory and auth D1 migrations before deploying each tenant's Workers. (Update: `deploy.yml` now also deploys `anjuna-factory` after the aduplift core deploy (the maimax account has no factory yet), behind a guard that checks the factory secrets first.)
- [ ] **Factory secrets:** `anjuna-factory` needs the Worker secrets `CF_API_TOKEN` and `CORE_TOKEN`, set once by the owner with `bun x wrangler secret put <NAME> --config workers/factory/wrangler.aduplift.jsonc`. Never set them as dashboard plain-text vars: `wrangler deploy` drops dashboard vars that are not in the wrangler config, but Worker secrets survive deploys.
- [ ] **Gate (blocked until done):** `anjuna-factory` is deployed to the AdUplift account by an owner-approved path, either a factory job added to `deploy.yml` or an owner-run `wrangler deploy -c workers/factory/wrangler.aduplift.jsonc`. Record the factory Worker version id. Confirm the deployed panel has the factory service binding before step 2.
- [ ] The AdUplift release job in `deploy.yml` builds and uploads `runtime/brand-runtime.js` to the factory `ARTIFACTS` bucket (`anjuna-artifacts`) from the released commit. Record its SHA-256 from the workflow log. Manual fallback only: from the released commit, run `bun run --filter @anjuna/brand-runtime bundle`, record the bundle's SHA-256, then run `bunx wrangler r2 object put anjuna-artifacts/runtime/brand-runtime.js --file packages/brand-runtime/dist/brand-runtime.js --content-type application/javascript --remote --config workers/core/wrangler.deploy.aduplift.jsonc` with the AdUplift credentials.
- [ ] `levellendings.com` is an active zone in the AdUplift account (`6cb8500c35210800451bd9a535482850`) with **no A or CNAME record on the apex or `www`**. Check in the Cloudflare dashboard (DNS).
- [ ] A template version the factory accepts exists (README question 2 is a soft risk, not a gate). If the install is refused because the version is not sealed, record it and stop that step.
- [ ] You can sign in to `https://app.aduplift.ai` as Owner (Cloudflare Access).

## Steps

1. **Create the draft.** Panel, Brands, new brand: Domain `levellendings.com`, Keyword default `Quick Loan` (any Title Case text), pick the template version.
2. **Install.** Open the brand, click Install. Watch the receipts (validate, rollback record, render, upload, deploy, attach domains, smoke, receipt).
3. **Expect READY.** Lifecycle status READY and runtime sync `ready`. Record the install id and the time.
4. **Smoke by hand (read-only, BR-1).**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://levellendings.com/
   curl -s "https://levellendings.com/?keyword=fast%20cash%20loans" | grep -o '<h1[^>]*>.*</h1>' | head -2
   curl -s -w "\n%{http_code}\n" https://levellendings.com/index.html
   curl -s -w "\n%{http_code}\n" https://levellendings.com/_f/index.html
   curl -s -w "\n%{http_code}\n" https://levellendings.com/does-not-exist
   curl -s -w "\n%{http_code}\n" https://levellendings.com/api/postback
   curl -s -w "\n%{http_code}\n" https://levellendings.com/admin
   curl -s -o /dev/null -w "%{http_code}\n" https://levellendings.com/request/complete
   ```
   Expect `200` on `/` and the rewritten keyword `Fast Cash Loans` in the H1. Expect the same `404` with body `Not Found` on `/index.html`, `/_f/index.html`, `/does-not-exist`, `/api/postback` and `/admin`: internal HTML must not bypass the Worker, and admin, postback and drain routes never exist on brand domains. Expect `200` on `/request/complete` (use `<formRoute>/complete` if the brand uses a different form route).
5. **Re-run creates nothing new.** Click Install again on the same brand and revision. Expect a refusal or a no-op, not a second deployment. Record the installs list (it must not gain a second successful install for the same revision).
6. **Rollback.** Click Rollback. On a first install this detaches the Custom Domain. Expect the lifecycle status to reflect the rollback and `https://levellendings.com/` to stop serving the brand. Reinstall afterwards if you continue to T13.
7. **Forced failure: not verified live.** Do not break production to force a failure. This runbook cannot prove "a deliberately failed step rolls back automatically" on the live test domain. Supporting, non-live evidence is the factory Vitest suite, which uses fakes and makes no Cloudflare calls:

   - `workers/factory/test/workflows.test.ts`: "compensates first-install failure after core provision using the actual core revision", "still compensates on replay when every mutation step is cached", "retains the lock and actionable failure when compensation dispatch fails".
   - `workers/factory/test/receipt.test.ts`: "saves failed receipt and re-throws on work error".

   Attach the green `build typecheck test` CI run URL for the released commit. Report this criterion as **PARTIAL (unit-tested, not live-verified)** until an owner-approved, test-domain-only failure hook exists.

## Expected result

READY after step 3, `200` and uniform `404` responses as above, no second install after step 5, rollback effective after step 6. The forced-failure criterion remains **PARTIAL (unit-tested, not live-verified)** as described in step 7.

## Evidence to capture

Install id, receipts list, all smoke `curl` outputs, installs list before and after the re-run, the rollback receipt, the CI run URL of the release, the factory deployment version id, the brand-runtime bundle SHA-256, and the PR check run URL backing step 7.

## Stop and rollback

- Any receipt `failed`: stop. Copy the receipt error into the evidence file. The workflow rolls back by itself; confirm the domain is detached.
- Custom Domain will not attach: check for leftover A/CNAME records (error is expected, see brief section 9).
- Never touch the `ef771cfd…` account.
