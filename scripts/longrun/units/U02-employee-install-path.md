---
id: U02
title: feat(web): employee brand install path with sealed-template dropdown
branch: fus-347-employee-install-path
lane: web
deps:
builder: codex
reviewers: deepseek
paths: apps/web/ packages/contracts/
merge: auto
---
## Goal
Employees have waited days to launch brands. T12 acceptance says an Employee can create and install a brand from Domain + Keyword, and Owner-only actions are guarded. The template field is free text today. Employees must pick a sealed template.

## Do
1. Read `apps/web/src/client/screens/BrandLifecycle.tsx`, `apps/web/src/server/lifecycle.ts`, `apps/web/src/client/lifecycle-state.ts` and their tests.
2. Replace the free-text template input with a dropdown of sealed template versions from the factory D1, served by the existing server API. Add a server endpoint only if none lists sealed templates. Reuse `packages/contracts` schemas.
3. Add or extend tests proving three things. An Employee can create a draft from Domain + Keyword + sealed template and start Install. Rollback, Upgrade-all and Delete stay Owner-only on the server side. Unsealed templates are not offered.

## Acceptance
- The template field is a dropdown fed by sealed templates only.
- Tests cover employee create and install, and the server refusing owner-only actions for an Employee.
- `bun run typecheck` and `bun run test` green.
