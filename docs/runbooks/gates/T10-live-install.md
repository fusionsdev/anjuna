# T10 live acceptance: install on the test domain

Acceptance (`docs/TASKS.md` T10): an install on the test domain reaches READY; a re-run creates nothing new; rollback works; a deliberately failed step rolls back automatically. Test domain: `levellendings.com`.

The code and the workflow tests are not on `main` yet. They are in PR #40 (workflow tests in `workers/factory/test/`).

## Preconditions

- [ ] PR #43 is merged into #40 (done 2026-10-07) and #40 is merged into `main` by the owner.
- [ ] Release tag `v*` pushed by the owner so `deploy.yml` ships core, factory and panel. Check the run is green.
- [ ] `levellendings.com` is an active zone in the AdUplift account (`6cb8500c35210800451bd9a535482850`) with **no A or CNAME record on the apex or `www`**. Check in the Cloudflare dashboard (DNS).
- [ ] A sealed template version exists (see README open question 2).
- [ ] You can sign in to `https://app.aduplift.ai` as Owner (Cloudflare Access).

## Steps

1. **Create the draft.** Panel, Brands, new brand: Domain `levellendings.com`, Keyword default `Quick Loan` (any Title Case text), pick the sealed template.
2. **Install.** Open the brand, click Install. Watch the receipts (validate, rollback record, render, upload, deploy, attach domains, smoke, receipt).
3. **Expect READY.** Lifecycle status READY and runtime sync `ready`. Record the install id and the time.
4. **Smoke by hand (read-only).**
   ```bash
   curl -sI https://levellendings.com/ | head -5
   curl -s "https://levellendings.com/?keyword=fast%20cash%20loans" | grep -o '<h1[^>]*>.*</h1>' | head -2
   curl -s -o /dev/null -w "%{http_code}\n" https://levellendings.com/admin
   ```
   Expect `200` and the keyword in the H1. Expect `404` on `/admin`: admin, postback and drain routes never exist on brand domains.
5. **Re-run creates nothing new.** Click Install again on the same brand and revision. Expect a refusal or a no-op, not a second deployment. Record the installs list (it must not gain a second successful install for the same revision).
6. **Rollback.** Click Rollback. On a first install this detaches the Custom Domain. Expect the lifecycle status to reflect the rollback and `https://levellendings.com/` to stop serving the brand. Reinstall afterwards if you continue to T13.
7. **Forced failure.** Do not break production to force a failure. Evidence for "a deliberately failed step rolls back automatically" is the workflow tests in PR #40. NOT_VERIFIED that a live failure hook exists. If you want a live proof, ask for a test hook first.

## Expected result

READY after step 3, `200` and `404` as above, no second install after step 5, rollback effective after step 6.

## Evidence to capture

Install id, receipts list, the three `curl` outputs, installs list before and after the re-run, the rollback receipt, the CI run URL of the release.

## Stop and rollback

- Any receipt `failed`: stop. Copy the receipt error into the evidence file. The workflow rolls back by itself; confirm the domain is detached.
- Custom Domain will not attach: check for leftover A/CNAME records (error is expected, see brief section 9).
- Never touch the `ef771cfd…` account.
