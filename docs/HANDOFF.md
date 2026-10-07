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

The maimax installation has its own account and bootstrap configs on main. Its CI deploy is gated by an enable flag in `.github/workflows/deploy.yml` (introduced as `FRIEND_ENABLED` in #32, before the tenant was renamed). Production state of both tenants was not checked on 2026-10-07; check it before you claim anything about it.

## Open pull requests
- **PR #40** `fus-347-t12b-brand-lifecycle`: DRAFT, 66 files, truthful brand lifecycle control panel. CI `build typecheck test` is green. It carries `.github/workflows/pr-check.yml`, which is why no other PR has an Actions run yet. Do not merge it before the two blockers below are resolved.
  - Branch `fus-347-t12b-fix-h1-h2` (one commit on top of #40) fixes them: upgrade-all workflow ids exceeded Cloudflare's 100-character limit (now sha256), and an employee could retry an owner-only upgrade install through `/api/installs/:id/retry` (now guarded by the original command's role, and refused while another operation is active). Fold it into #40 or open it against #40.
  - Open review items from the independent audit, not yet fixed: checklist POST runs before `authorizePanel`; GET `/installs` and `/checklist` do not decode the path id; first provision in `workers/core/src/lifecycle.ts` is not atomic across LEADS and FACTORY; `verifySold` does not check the brand is in `LIFECYCLE_ACCOUNT`; `pr-check.yml` has no `permissions:` block.
- **PR #41** `fus-347-panel-reports`: funnel, alerts and mailing reports (core read-only `/admin/funnel|alerts|mailing` plus panel screens). typecheck and tests were green locally; it has no Actions run until `pr-check.yml` is on main. Known items: `apps/web/src/server/access.ts` weakens the `DEV_ACCESS_BYPASS` fail-closed rule (it now relies on the absence of `cf-connecting-ip`); `packages/mailing` changes are outside the reports scope. #40 and #41 conflict in `App.tsx`, `client/api.ts` and `workers/core/test/helpers.ts`; all three are additive. Whichever merges second must rebase.

Do not stack one of these PRs on the other. The owner approves every merge.

## How to review and merge a PR here
1. Read the PR against its task in `docs/TASKS.md` and the rules in `AGENTS.md`. For the money path, compare it line by line with V1. V1 is `fusionsdev/fusion_formv_v1` on branch `anjuna-port-base`, in `functions/api/[[path]].ts`.
2. Rebase on `main`. If only `bun.lock` conflicts, take main's copy, run `bun install`, then confirm with `bun install --frozen-lockfile`. Never hand-merge `bun.lock`.
3. Run `bun run build`, `bun run typecheck` and `bun run test` on Linux.
4. Turbo appends an "agent guidance" block to `AGENTS.md` and may reformat the root `package.json` (`allowScripts` with machine-specific paths). Revert both before you commit.
5. Squash merge and delete the branch, then mark the Linear issue Done (project P-FUS-17).

## Known gaps
- `packages/leads-db` test "V1 parity: every V1 table exists" is close to the 5 s Vitest timeout (about 4.8 s alone, over 10 s under parallel Turbo). Raise its timeout rather than retrying.
- The React starter (`packages/keyword-slot-react/dist/example`) fails `check-template` (no `/privacy`, `/terms`, `/disclosures`, `/do-not-sell` pages). The Astro starter passes. T11 says the T5 starters pass; decide whether the React example needs the legal pages or is exempt.
- `apps/lead-form` bundle/manifest tests and `scripts/smoke-web.test.ts` fail on the local Windows and WSL machines (SyntaxError in the bundle). Linux CI on #40 passes the whole suite.
- Template MCP: `seal_template_version` takes the owner secret as a tool argument and compares it with `!==`; `created_by` / `sealed_by` are caller-supplied; plain `Error`s from certify/seal are reported as `internal_error`, which hides the repair message.

## Owner decisions that are easy to miss
- **Conversions follow V1.** Every soldLead with payout > 0, after the clamp at 230, is queued, with or without a click ID.
- **T6c must match what the postback looks up.** It must write `leads.click_id` = lead_id without hyphens and `leads.brand` = brand_id, because the postback looks leads up by those values. The form sends `site_id=form-default` and `full_v1`/`lite_v1`.
- **Never reuse one template across brands.** Each brand gets a unique design from a builder (open-design, v0, Bolt, Lovable, Magic Patterns), checked through the template MCP plus a similarity check against the other brands.
- **Roles.** Employees can view, add and install brands, edit the keyword default, pause and roll back. Everything that changes where money flows (including upgrade-all) is owner-only (`docs/plans/t12-control-panel.md`).
- **Quota.** Use cloud sessions (Sonnet) for Claude-heavy work. Keep the local machine for the local CLIs, WSL tests and deploys.
- **No merge and no deploy by an agent.** Do not call LeadsGate or the VPS drain.

## Next, in order
1. Owner reviews #40 (with the `fus-347-t12b-fix-h1-h2` fix folded in), then #41. Rebase the second one onto main after the first merges.
2. T13/T14: a real LeadsGate test-sold and a real drain run. These need the owner and the manager.
3. T15: cross-account brand check (brand in account B to `core.aduplift.ai` in account A).
4. T16: the first brand, on a unique builder template.
