---
id: U09
title: ci(lead-form): move the form upload workflow into .github/workflows
branch: fus-339-form-upload-workflow
lane: ci
deps:
builder: codex
reviewers: deepseek
paths: .github/workflows/ apps/lead-form/
merge: owner
---
## Goal
T4 is not closed. The form-upload workflow sits at `apps/lead-form/ci/lead-form.workflow.yml`, outside `.github/workflows`. T4 acceptance also needs the browser E2E (`ui_e2e.py`) to pass. It passed 6 of 8 runs.

## Do
1. Move the workflow into `.github/workflows/` with the same behaviour: build, SHA-256 manifest, R2 upload as `form@sha`. Trigger only on `v*` tags or manual dispatch, never on every push, because an upload is a release action.
2. Find why the E2E failed 2 of 8 runs. Fix the flake in the form or in the test.
3. Reference secrets by name only.

## Acceptance
- The workflow lives in `.github/workflows/` and triggers on tags or manual dispatch only.
- The workflow runs the bundle grep check: no brand domain, "anjuna", "aurum", PostHog key or Sentry DSN.
- `bun run typecheck` and `bun run test` green.
