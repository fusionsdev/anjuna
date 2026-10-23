# Anjuna control panel: gap backlog, ship order, spec 1 design

## Context

On 2026-10-23 the owner asked what the control panel (`apps/web`) is still missing from a user's view.
Inputs:
- An inventory of `apps/web`: 6 screens, no URL routing, no page for leads, money or conversions.
- Two reference dashboards the owner likes:
  - AURUM Observe Admin
  - FusionOps (Home, My Sites, Settings, LP Wizard)
- Owner requests collected in chat.
- A 4-model committee debate. Notes: `F:\Temp\claude\H--w-t12a-anjuna\bdb0860f-00ed-4128-803f-69315ed4c918\scratchpad\senate\runs\2026-10-23-0907-committee\notes.md`.

The owner confirmed the backlog is complete and approved the ship order below.

## Backlog (final)

| # | Item | Owner decisions / notes |
|---|---|---|
| 1 | Leads list, detail, CSV | Owner sees PII, employee does not; PII CSV owner-only and audited |
| 2 | Money + conversions | KPIs, revenue, queue with reason codes; read-only; requeue later |
| 3 | URL routing, search, pagination, confirm dialogs | Rollback/Recover/Pause/Upgrade-all have no confirm today |
| 4 | Brand history | All installs, revisions, alert details |
| 5 | Admin | Ban/delete user, reset password, suppressions |
| 6 | Settings page | AID, A/B weights, form per arm, split %, gate mode; per brand in one table. Multi-network server post and Cloudflare profiles are separate blocked specs |
| 7 | Domain everywhere | Replace `brand_xxx` ids with domain |
| 8 | Brand card actions | Open, Copy Final URL with `?keyword={keyword}`, Edit & Redeploy, Duplicate, Download, Deploy |
| 9 | Flow-gate modes visible | `param` = "Keyword Param", `signed_cookie` = "Single Page Cookie"; today hidden in drawer (`ConfigPanel.tsx:67-71`) |
| 10 | Google Ads bot timeline | Changes + bot visits + Ads account events; logging only (rule 3); account events manual first, AdKit later |
| 11 | Brand create form like LP Wizard | Auto phone/address (owner: same code as V1), CF profile select, AI copy + SEO meta + SERP preview reusing FusionOps generator with banned-word filter |
| 12 | Professional redesign | Whole panel |
| 13 | Debate additions | Lead reconciliation, PII access audit, suppression search, Pause/Resume + gate label on card, Settings unsaved-change warning, payout/value owner-only at field level |

## Ship order (approved)

1. **Spec 1: routing + app shell + design system + brand card basics** (designed below).
2. **Spec A**: Home overview + Conversions (draft in the debate notes; payout/value owner-only).
3. **Spec B** (Leads, detail, CSV, Postback Inspector, PII audit, suppression search) and **Spec C** (Brands list issues-first, deploy history, Copy Final URL, Download/Deploy menus) in parallel.
4. **Settings** table (items 6, 9).
5. **Spec D**: Traffic, client error log.
6. **Bot timeline phase 1**: manual account-event marks merged with change history.
7. **Blocked, each needs its own governance spec first**: Cloudflare profiles (credential spec), multi-network server post (AGENTS.md rule 2 + ADR 0002 change), LP wizard + contact data, `aurum-14-step` rename (migration spec), conversion requeue, passive bot logging (byte-identity tests).

## Spec 1 design: routing, shell, design system, brand card basics

### Routing
- Replace `useState<View>` in `apps/web/src/client/App.tsx` with a `useRoute` hook on `history.pushState` + `popstate`. No new dependency.
- Paths: `/brands`, `/brands/:id`, `/funnel`, `/alerts`, `/mailing`, `/audit`, `/users`; `/` redirects to `/brands` until Spec A adds Home.
- SPA fallback already set: `apps/web/wrangler.jsonc` `not_found_handling: "single-page-application"`. Confirm `src/server/index.ts` passes non-`/api` paths to `ASSETS`.

### App shell
- `components/AppShell.tsx` (sidebar + header + main), `components/SidebarNav.tsx` (links, active state, Users owner-only, Mailing kept).
- Header: page title, environment badge (tenant name from config), user menu (email, role, sign out).
- Mobile under 768 px: sidebar becomes a drawer with a menu button.

### Design system
- `styles/tokens.css`: color, spacing, radius, shadow, type scale as CSS variables; light theme first.
- Fonts bundled with `@fontsource/inter` and `@fontsource/sarabun` (no external font request).
- Shared components in `src/client/components/`: `DataTable` (sticky header, 36 px rows, monospace ids, tabular numbers), `StatusBadge` (color + icon + text), `ConfirmDialog` (replaces `window.confirm`), `EmptyState`, `Spinner`/skeleton, `Toast`.
- Apply `ConfirmDialog` to Rollback, Recover, Pause, Upgrade-all, role change, flow gate change, token rotation.

### Domain everywhere
- `useBrandLabels()` hook builds `brand_id -> domain` from `/api/lifecycle/brands` (factory `brands.domain`) with fallback to the first `BrandSummary.hostnames` entry.
- `BrandLabel` component renders domain first, id in small monospace on hover. Use it in Brands, Funnel, Alerts, Audit, UpgradeOutcomes.

### Brand card basics
- Show domain, status badge, flow-gate label ("Keyword Param" / "Single Page Cookie"), latest install status.
- Pause/Resume button on the card (owner rules unchanged: `panel-roles.ts`), with `ConfirmDialog`.
- Remove dead `screens/Brands.tsx` wrapper.

### Tests
- Routing: deep link renders the right screen, back button, unknown path.
- `ConfirmDialog` gates each destructive action (cancel sends no request).
- `useBrandLabels` mapping and fallback.
- Existing `apps/web/test/*.ui.test.tsx` stay green after the shell swap.

## Agent and subagent plan

### Roles

| Seat | Who | Does | Never does |
|---|---|---|---|
| Orchestrator | Main session (Opus) | Writes specs and plans, writes task briefs, dispatches seats, reads short reports, opens PRs, merges on green | Writes product code |
| Research | `Explore` subagents (read-only) | Find code before a spec: V1 phone/address code, FusionOps generator, factory lifecycle reads | Edit files |
| Coder | `relay:relay-coder` (Sonnet, xhigh) | One task from the plan: code + tests + self-review, returns a status contract | Touch files outside its task |
| Coder (escalation) | `relay:relay-coder-opus` | Tasks on money, auth or PII paths: field-level payout gating, PII access audit, CSV export; or any task where relay-coder failed 2 fix rounds | |
| Reviewer | `relay:relay-reviewer` (Opus, read-only) | Spec-compliance verdict per task, then a final whole-branch review per spec | Edit files |
| Second reviewer | Codex CLI (`codex exec --sandbox read-only`), run by a general-purpose subagent so raw output stays out of the orchestrator | Reviews every task diff after relay-reviewer passes it, and the final branch diff. Returns pass / findings with file:line | Edit files |
| Bug fixer check | `relay:relay-diffcheck` | Verifies a bug fix hits the root cause | |
| Verifier | general-purpose subagent | `bun run typecheck`, `bun run test`, browser-pane screenshots at desktop and 375 px via the `run` skill | |
| Design review (optional) | `senate` committee (codex, cursor, agy) | Second opinion on each spec doc before writing-plans, same as today's debate | |

### Flow per spec

1. Explore agents (up to 3 in parallel) gather file paths and existing helpers.
2. Orchestrator writes the spec, owner reviews it.
3. `superpowers:writing-plans` splits the spec into tasks of about 1 to 3 files each, with tests named per task.
4. `relay` pipeline runs each task in this order:
   - The coder writes the task.
   - relay-reviewer (Opus) reviews it.
   - Codex reviews the same diff as a second, independent check.
   - The task passes only when both reviewers pass it.
   - Findings from either reviewer go back to the same coder in one fix round.
   - Both reviewers re-check the fix.
   - Two failed rounds escalate the task to relay-coder-opus.
   - When the two reviewers disagree, the orchestrator decides against the spec and records the reason in the task report.
5. Final whole-branch review by relay-reviewer, then by Codex, then the verifier.
6. One branch and one PR per spec (AGENTS.md). Merge only when checks are green, gated with `&&`.

### Parallelism

| Phase | Mode | Why |
|---|---|---|
| Spec 1 | Sequential, 1 worktree | Every task touches `App.tsx` and shared components |
| Spec A | Sequential after spec 1 merges | Needs the shell and `DataTable` |
| Spec B and spec C | Parallel, 2 worktrees under `H:/w/anjuna-wt/` (never F:/Temp), each with its own relay pipeline | Independent data paths: B reads core leads, C reads factory lifecycle |
| Settings, D, bot timeline phase 1 | Sequential | Small; each touches `ConfigPanel`/core admin routes |

Conflict hot spots for B and C: `packages/contracts/src/admin-api.ts`, `workers/core/src/admin/index.ts`, the route table in `App.tsx`.
Rule: each spec adds its endpoints in its own block and its routes in its own module file. B merges first, C rebases.

Inside one spec, tasks that touch disjoint files may run as parallel coder seats, for example the contracts task and a UI component task. Tasks that share a file stay sequential.

### Superpowers skill per step

| Step | Skill |
|---|---|
| Spec writing (done for backlog; per spec next) | `superpowers:brainstorming` |
| Task plan per spec | `superpowers:writing-plans` |
| Worktree per spec (B and C parallel) | `superpowers:using-git-worktrees` (root `H:/w/anjuna-wt/`) |
| Running tasks | `relay` pipeline under `superpowers:subagent-driven-development`; B and C in parallel via `superpowers:dispatching-parallel-agents` |
| Each task | `superpowers:test-driven-development` (test first, then code) |
| Any failing test or bug | `superpowers:systematic-debugging`, fix verified by relay-diffcheck |
| Review | `superpowers:requesting-code-review` (relay-reviewer + Codex), `superpowers:receiving-code-review` (coder handles findings) |
| Before claiming done | `superpowers:verification-before-completion` (typecheck, test, screenshots as evidence) |
| PR and merge | `superpowers:finishing-a-development-branch` |

### Monitoring with Herdr

- Herdr 0.9.2-preview is installed and its server is running. This session runs outside Herdr (`HERDR_ENV` empty), and the Herdr skill forbids controlling a session from outside a Herdr pane.
- Setup: owner runs `herdr` in `H:\w\t12a\anjuna`, starts `claude` in the first pane, and resumes this plan there. That pane becomes the orchestrator.
- Worker seats run as Herdr agents in sibling panes so the sidebar shows `working` / `blocked` / `done` for each:
  - `herdr pane split --current --direction right --cwd <worktree> --no-focus`
  - `herdr agent start coder-<task> --kind claude --pane <id>` for coder seats (Sonnet via `-- --model sonnet`)
  - `herdr agent start review-codex --kind codex --pane <id> -- --sandbox read-only` for the Codex reviewer
  - `herdr agent prompt <name> "<brief file path + instructions>" --wait --timeout 1800000`
  - Results come back as report files under `docs/superpowers/reports/<spec>/` (git-ignored scratch), read with `herdr agent read` only as a fallback.
- One Herdr workspace per spec; B and C get one workspace each, matching their worktrees.
- relay-reviewer (Opus) stays an in-process subagent; only seats that write code or run Codex go to panes.
- `blocked` in the sidebar means an approval prompt; the orchestrator inspects it and asks the owner before answering.

## Steps after approval

1. Create Linear issue for spec 1; branch `fus-<id>-panel-shell` from `main`.
2. Write `docs/superpowers/specs/2026-10-23-panel-backlog-and-order.md` (this backlog + order) and `docs/superpowers/specs/2026-10-23-panel-shell-design.md` (spec 1); commit.
3. Owner reviews the spec files.
4. Invoke `superpowers:writing-plans` for spec 1.

## Verification

- `bun run typecheck` and `bun run test` green.
- Local panel with mock-core: open each path directly, reload, back button; destructive buttons show the dialog.
- Browser pane screenshots at desktop and 375 px width, before and after.
