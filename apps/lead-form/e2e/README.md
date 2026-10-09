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

## U09 verification (2026-10-09)

- Edge: 8/8 fresh-context runs passed at normal speed and 8/8 at 4x CPU throttling.
- `bun run build` in `apps/lead-form`: passed; bundle scanner checked 13 clean files.
- Root `bun run typecheck`: 24/24 tasks successful (23 cached).
- Root `bun run test`: 25/25 tasks successful (24 cached); lead-form ran 29/29 tests.
- Parsed workflow YAML: exact `push.tags: ["v*"]` plus `workflow_dispatch`,
  release-only upload guard, and bundle scan command verified.
- R2 upload and hosted GitHub Actions execution: not run; credentials disabled.

## U09 fix round 2 verification (2026-10-09)

The supplied DeepSeek feedback contains a reviewer name but no findings. Inspection
found that the prior browser fix was only exercised locally. This round makes it
a required release-build check without changing the release triggers or R2 upload.

- Edge: fresh 8/8 normal and 8/8 at 4x CPU throttling passed again.
- `bun run build` in `apps/lead-form`: passed; 13 bundle files clean.
- Root `bun run typecheck`: 24/24 tasks passed, all cached.
- Root `bun run test`: 25/25 tasks passed, all cached.
- Parsed workflow YAML: release-only triggers, upload dependency on the build job,
  bundle scan, and both browser batches verified. Every shell step passed `bash -n`.
- Hosted Ubuntu/Chromium execution and R2 upload: not run. Local browser evidence
  uses Edge; GitHub Actions installs its own Chromium through Playwright.
