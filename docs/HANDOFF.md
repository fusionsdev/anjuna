# Handoff — read this first if you are picking up Anjuna

## Where to work (read before anything else)
- **Local:** open the session in `H:/w/t12a/anjuna` only, and run `git checkout main && git pull --ff-only origin main` first. Per-tenant `wrangler.deploy.<tenant>.jsonc` files with the real D1 ids are now committed (`aduplift`, `maimax`); there is no git-excluded deploy config any more.
- **Every other local anjuna clone is a stale per-agent clone.** Do not continue work there. This includes `H:/DEV/projects/ppc_project/leads-form/anjuna`, which sits on branch fus-340 / T5 that is ALREADY MERGED, and `H:/w/t6`…`tpl`. Short-lived worktrees for open PRs (for example `H:/w/anjuna-panel-reports`) are fine; remove them when the PR is merged.
- **Cloud (claude.ai/code):** work from `main` on GitHub. If this file is missing, you are on an old branch.
- **Sanity check:** if `docs/HANDOFF.md` is missing or main has fewer than 38 merged PRs, your checkout is stale. Pull before you trust anything.
- **node_modules:** the clone at `H:/w/t12a/anjuna` was installed from WSL. Run its tests through WSL, or reinstall natively on Windows. Miniflare tests on Windows can fail with `EADDRINUSE` or time out under parallel Turbo load; that is the environment, not the code.

Updated 2026-10-07. This file lives in the repo on purpose: cloud sessions cannot reach the owner's local Oracle memory server.

## State of main
Merged:
- T1 ADRs (`docs/adr/`)
- T2 D1 schemas (`packages/leads-db`, `factory-db`, `auth-db`)
- T3 contracts (`packages/contracts`)
- T4 form (`apps/lead-form`)
- T5 Astro and React starters (`packages/template-astro-starter`, `keyword-slot-react`)
- T6 core (`workers/core`): auth, V1 money path, lead path, live brand settings, admin API (`AdminService`), mailing and alerts crons
- T7 brand runtime (`packages/brand-runtime`)
- T8 mailing (`packages/mailing`)
- T9 insights (`packages/insights`)
- T10 factory install / rollback / upgrade-all Workflows (`workers/factory`, PR #26). The Workflow tests are NOT on main yet; they ship with PR #40 (see below).
- T11 template certification + seal (`packages/template-cert`, `workers/template-mcp`, PRs #16, #19, #27). Browser Rendering screenshots have only been tested with a fake binding.
- T12-0 admin API contract, T12a control panel shell, T12 brand lifecycle + install pipeline (`apps/web`, PR #28)
- T17 tenant bootstrap and CI deploy matrix (`tenants/`, `scripts/`, PRs #29–#39). Tenants: `aduplift` (owner) and `maimax` (separate Cloudflare account, LeadsGate aid, drain VPS and listmonk).

Live on the Cloudflare account "AdUplift" (`6cb8500c35210800451bd9a535482850`; never deploy to `ef771cfd…`):
- `app.aduplift.ai`: the panel. It is behind Cloudflare Access (team `aduplift.cloudflareaccess.com`) and binds the real core (`CORE` → `AdminService`, `MOCK_CORE=0`).
- `demo1..5.aduplift.ai`: test brands with a TEST banner. Their Worker source is outside this repo.
- `core.aduplift.ai`: `anjuna-core`, live, with a WAF skip rule for /api/postback and /api/conversions/*.
- Template MCP (`workers/template-mcp`) was planned for `mcp.aduplift.ai`; the 2026-10-02 handoff listed it as in flight. Its deployment was not re-verified on 2026-10-07.

The maimax installation has its own account and bootstrap configs on main. Its CI deploy is gated by an enable flag in `.github/workflows/deploy.yml` (introduced as `FRIEND_ENABLED` in #32, before the tenant was renamed).

**maimax drain (owner-reported, Oracle handoff 2026-10-05, not re-verified from this repo):** the Google Ads side is connected and the drain on the maimax VPS is live. It runs from cron every 10 minutes, a test run printed `no pending conversions`, and a lead with a gclid/gbraid arriving at `core.maimax.fit` should upload to the maimax Google Ads account automatically. Remaining items:
- OWNER: rotate the two Cloudflare API tokens that leaked into a chat transcript (Cloudflare dashboard).
- Verify the first real conversion in the drain log on the VPS when a lead with a gclid/gbraid arrives.

Production state of the aduplift tenant was not checked on 2026-10-07; check it before you claim anything about it.

## Open pull requests
State checked 2026-10-07. `main` is `e07a552` (merge of #39); nothing has merged since.
- **PR #40** `fus-347-t12b-brand-lifecycle`: DRAFT, head `1170342`, truthful brand lifecycle control panel. The check `build typecheck test` is SUCCESS and the PR is MERGEABLE. PR #43 (the h1/h2 fix) is already merged into this branch. It carries `.github/workflows/pr-check.yml`, which is why no PR against `main` has an Actions run yet.
  - Open review items from the independent audit, still not fixed (not covered by #45): first provision in `workers/core/src/lifecycle.ts` is not atomic across LEADS and FACTORY; `verifySold` does not check the brand is in `LIFECYCLE_ACCOUNT`.
- **PR #45** `fus-347-t12b-lifecycle-guards`, targets the #40 branch (not `main`), head `4692d0b`: `POST /api/brands/:id/checklist` now authorizes before writing; one `decodeBrandId` helper serves POST install / rollback / checklist and GET installs / checklist, so a malformed escape returns 400, not 500; `pr-check.yml` gets `permissions: contents: read`. Linux CI check is SUCCESS and a read-only review passed. There is no 403 test by design: only the owner and employee roles exist, so the guard is defense in depth.
- **PR #46** `fus-337-leads-db-test-timeout`, targets `main`, head `629b1f9`: sets the `packages/leads-db` Vitest `testTimeout` to 30_000. A local Windows run passed (leads-db 19/19). There is no Actions run because `main` has no `pr-check.yml` until #40 merges. Review passed.
- **PR #41** `fus-347-panel-reports`: funnel, alerts and mailing reports (core read-only `/admin/funnel|alerts|mailing` plus panel screens). Head `53a1b8b`, MERGEABLE, only the CodeSnif check ran (no `pr-check` on `main`). After #40 merges, #41 needs a rebase with 3 additive conflicts: `apps/web/src/client/App.tsx`, `apps/web/src/client/api.ts`, `workers/core/test/helpers.ts`. The `DEV_ACCESS_BYPASS` change in `apps/web/src/server/access.ts` (it now relies on the absence of `cf-connecting-ip`) and the `packages/mailing` changes (outside the reports scope) await an owner decision.
- **PR #42** (this docs PR) and **PR #44** (`docs/gate-runbooks`, head `58131ca`, gate runbooks in `docs/runbooks/gates/`): both OPEN and MERGEABLE.

Suggested merge order (an agent proposal; the owner decides): #45 into the #40 branch, then #40, then #41 (after an agent rebases it), then #42, #44, #46. Do not stack other PRs on one another. The owner approves every merge.

## How to review and merge a PR here
1. Read the PR against its task in `docs/TASKS.md` and the rules in `AGENTS.md`. For the money path, compare it line by line with V1. V1 is `fusionsdev/fusion_formv_v1` on branch `anjuna-port-base`, in `functions/api/[[path]].ts`.
2. Rebase on `main`. If only `bun.lock` conflicts, take main's copy, run `bun install`, then confirm with `bun install --frozen-lockfile`. Never hand-merge `bun.lock`.
3. Run `bun run build`, `bun run typecheck` and `bun run test` on Linux.
4. Turbo appends an "agent guidance" block to `AGENTS.md` and may reformat the root `package.json` (`allowScripts` with machine-specific paths). Revert both before you commit.
5. Squash merge and delete the branch, then mark the Linear issue Done (project P-FUS-17).

## Known gaps
- `packages/leads-db` test "V1 parity: every V1 table exists" was close to the 5 s Vitest timeout. PR #46 raises it to 30 s (not merged yet).
- `workers/core` `test/cron.test.ts`, "bounds one run to MAX_OUTBOX_BATCHES batches of 50...", times out at 30000 ms on a Windows dev host even when run alone. It passes on Linux CI (#40, #45). Not fixed.
- Out-of-scope follow-ups found during #45 review, not fixed: `index.ts` lines 122, 239 and 307 call `decodeURIComponent` without a catch (a malformed escape gives 500); `lifecycle.ts` `GET /api/lifecycle/brands/:id` and the install-id routes use the raw `m[1]`; the old `GET installs` handler in `index.ts` is dead code because the lifecycle handler runs first.
- Deploy workflow: the last 6 runs failed and the last success was v1.0.5 (from `gh run list`). Cause NOT_CHECKED.
- `check-template` is not a gate for the starters or for the ready-made templates the owner supplies; do not spend time making the React example pass it (owner decision, 2026-10-07).
- `apps/lead-form` bundle/manifest tests and `scripts/smoke-web.test.ts` fail on the local Windows and WSL machines (SyntaxError in the bundle). Linux CI on #40 passes the whole suite.
- Template MCP: `seal_template_version` takes the owner secret as a tool argument and compares it with `!==`; `created_by` / `sealed_by` are caller-supplied; plain `Error`s from certify/seal are reported as `internal_error`, which hides the repair message.

## Owner decisions that are easy to miss
- **Conversions follow V1.** Every soldLead with payout > 0, after the clamp at 230, is queued, with or without a click ID.
- **T6c must match what the postback looks up.** It must write `leads.click_id` = lead_id without hyphens and `leads.brand` = brand_id, because the postback looks leads up by those values. The form sends `site_id=form-default` and `full_v1`/`lite_v1`.
- **Never reuse one template across brands.** Each brand gets a unique design from a builder (open-design, v0, Bolt, Lovable, Magic Patterns), checked through the template MCP plus a similarity check against the other brands.
- **Roles.** Employees can view, add and install brands, edit the keyword default, pause and roll back. Everything that changes where money flows (including upgrade-all) is owner-only (`docs/plans/t12-control-panel.md`).
- **Quota.** Use cloud sessions (Sonnet) for Claude-heavy work. Keep the local machine for the local CLIs, WSL tests and deploys.
- **No merge and no deploy by an agent.** Do not call LeadsGate or the VPS drain.

## Owner inputs still open
- LeadsGate TEST aid `13119` versus `tenants/aduplift.config.ts` `leadsGateAid` `"10001"`: which is right.
- LeadsGate postback macro names, and where the per-brand postback token plaintext is shown.
- Whether a second aduplift Cloudflare account exists (gate G3).
- A real gclid for the G2 upload.
- Rotate the two leaked maimax Cloudflare tokens.
- Wave 4 (T13 LeadsGate, T14 drain, T15 cross-account, T16 first brand) is owner-gated. Test domain: `levellendings.com`. Template seal / `check-template` is not a gate.
- Production state: NOT_CHECKED. Agents have deployed nothing.

## Next, in order
1. Owner reviews #45, #40, then #41 (see the suggested merge order above). #41 must be rebased onto main after #40 merges.
2. T13/T14: a real LeadsGate test-sold and a real drain run. These need the owner and the manager.
3. T15: cross-account brand check (brand in account B to `core.aduplift.ai` in account A).
4. T16: the first brand, on a unique builder template.
