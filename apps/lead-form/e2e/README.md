# Local browser acceptance

This is the maintained local adaptation of `spike/ui_e2e.py`. The spike stays read-only.
It builds the real form and serves it through the real `packages/brand-runtime` Worker
in Miniflare. Core is an in-memory test double. No credentials are needed.

From the repo root, install workspace dependencies with `bun install --frozen-lockfile`.
The browser test needs Python and Playwright (`python -m pip install playwright==1.62.0`).
Use an installed Edge with `--channel msedge`, or install Playwright Chromium with
`python -m playwright install chromium` and omit `--channel`.

In one terminal, from `apps/lead-form`:

```sh
bun run build
node e2e/serve.mjs
```

In a second terminal, from `apps/lead-form`:

```sh
python e2e/ui_e2e.py http://127.0.0.1:8799 --runs 8 --channel msedge
python e2e/ui_e2e.py http://127.0.0.1:8799 --runs 8 --channel msedge --cpu-rate 4
```

Each run gets a fresh browser context. The test checks the landing and form keyword,
prefilled ZIP, all 3 steps, consent, accepted lead response, provider hop, and the
amount/name/nonempty click ID in the prepop URL. Assertions fail the process.
The test accepts only a loopback origin. It reads the local provider response with
`max_redirects=0` and replaces it before the browser can follow the external URL.
Unexpected external requests fail the test. Worker outbound requests are denied too.
Stop the local server after testing. Generated assets and logs live in ignored `.e2e/`.

## Reproduced flake

The historical 8-run logs are not in this worktree. Two local replays of the spike's
selectors reproduced the final-submit failure:

```text
4 step: Contact Details
DIAG checkbox count: 0 button: [' Previous Section']
submit wait: TimeoutError
prepop has amount/name/click_id: False False False
```

The sticky bar updates its step text before `AnimatePresence mode="wait"` replaces
the outgoing main screen. `wait_for_selector("text=Review & Agreement")` can match
that bar. `locator(...).all()` immediately returns an empty checkbox list.
`main button[type=button]:enabled.last` then selects **Previous Section**, since
the intended submit button is disabled until consent. The old test catches the
timeout and prints false results but exits 0.

The local adaptation waits for the exact heading inside `main`, waits for and checks
the consent input, and clicks **Submit Secure Inquiry** inside `main` by name.
It checks parsed redirect parameters and propagates failures. It adds no fixed sleeps
and does not change production form behavior.

`test_ui_e2e.py` locks the browser in that outgoing-screen state and proves that
the old selectors see zero checkboxes and target **Previous Section**. It then
mounts the review screen after a delay and calls the same `submit_review` helper
used by the full E2E. The check requires consent and submission, and fails if the
helper goes back. The delay simulates the animation; the helper waits on elements.

Run the regression from `apps/lead-form`:

```sh
python -m unittest discover -s e2e -p 'test_*.py'
```

Set `E2E_BROWSER_CHANNEL=msedge` to use installed Edge. In PowerShell, use
`$env:E2E_BROWSER_CHANNEL = 'msedge'` before the command. CI uses Chromium.

## Release workflow

`.github/workflows/lead-form.yml` runs on `v*` tag pushes or manual dispatch only.
The upload job uses the same release-only condition. Build, bundle scan, SHA-256
manifest verification, immutable `form@<sha>` prefix, and manifest-last R2 upload
are preserved. Secret references are `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; variable references are `R2_ARTIFACTS_BUCKET` and
`FORBIDDEN_DOMAINS`. Upload is not part of this local browser test.

The release build job also installs Python 3.12 and Playwright 1.62.0 Chromium,
starts the local Worker, and requires 8 normal runs plus 8 runs at 4x CPU throttling.
Startup is bounded and checks that the server is still alive. The shell exits on
the first failing browser command and stops the server on exit. The manifest and
artifact are published only after both batches pass; the R2 job depends on that
build job. Browser acceptance receives no Cloudflare secrets.

## U09 acceptance verification (2026-10-09, repeated from `538d69e`)

The workflow move and selector fix already existed on branch
`fus-339-form-upload-workflow` at `6370bad`. Starting from `538d69e`, a second
verification reran the local acceptance checks and parsed the release workflow.
The implementation remains unchanged; the results below are from that repeat run.

| Acceptance | Evidence from this run |
| --- | --- |
| Discoverable release workflow | Parsed `.github/workflows/lead-form.yml`; exact triggers are `push.tags: ["v*"]` and `workflow_dispatch`. The old `apps/lead-form/ci/lead-form.workflow.yml` is absent. |
| Clean bundle | `bun run build` in `apps/lead-form` passed. The scanner checked 13 files for brand domains, platform names, PostHog keys and Sentry DSNs. The release workflow calls the scanner before publishing. |
| Stable browser acceptance | `python -m unittest discover -s e2e -p 'test_*.py'` passed 1/1 with `E2E_BROWSER_CHANNEL=msedge`. Local Worker E2E passed 8/8 normal runs and 8/8 at `--cpu-rate 4`, using `--channel msedge`. |
| Root typecheck | `bun run typecheck`: 24/24 tasks passed, 23 cached. Lead-form typecheck ran uncached. |
| Root tests | `bun run test`: 25/25 tasks passed, 24 cached. Lead-form ran 29/29 tests uncached. |
| Release artifact contract | Parsed workflow confirms the SHA-256 manifest command, browser gates, upload dependency on build, release-only upload condition, `form@${{ github.sha }}` prefix and named secret references. |

The historical 2 failed-run logs are unavailable. The deterministic regression
reproduces the selector race described above. It does not prove that both
historical failures had the same cause.

The earlier verification found Playwright's Chromium headless executable absent.
This repeat used installed Edge for the regression and both 8-run batches; it did
not retry the default Chromium launch. Hosted Ubuntu/Chromium execution and R2 upload
were not run. The workflow
installs Chromium before its browser checks. No Cloudflare, LeadsGate or VPS calls
were made. The local test server was stopped after verification.
