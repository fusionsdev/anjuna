# Handoff — read this first if you are picking up Anjuna

Updated 2026-10-02. This file lives in the repo on purpose: cloud sessions cannot reach the owner's local Oracle memory server.

## State of main
Merged:
- T1 ADRs (`docs/adr/`)
- T2 D1 schemas (`packages/leads-db`, `factory-db`, `auth-db`)
- T3 contracts (`packages/contracts`)
- T4 form (`apps/lead-form`)
- T5 Astro and React starters
- T7 brand runtime (`packages/brand-runtime`)
- T8 mailing (`packages/mailing`)
- T9 insights (`packages/insights`)
- T12-0 admin API contract
- T12a control panel (`apps/web`)
- T6a/b core auth and V1 money path (`workers/core`)
- core admin API (`AdminService`)

Live on the Cloudflare account "AdUplift" (`6cb8500c35210800451bd9a535482850`; never deploy to `ef771cfd…`):
- `app.aduplift.ai`: the panel. It is behind Cloudflare Access (team `aduplift.cloudflareaccess.com`) and still uses `MOCK_CORE=1`.
- `demo1..5.aduplift.ai`: test brands with a TEST banner. Their Worker source is outside this repo.
- `core.aduplift.ai`: NOT deployed yet.

## In flight (local CLI runs; they may arrive as draft PRs marked "unreviewed")
- **T6c core lead path + live brand settings**, branch `fus-341-core-lead-submit`.
- **T11 template checker**, branch `fus-346-template-cert`.
- **Template MCP** (`workers/template-mcp`, `mcp.aduplift.ai`): being built in a cloud session.

## How to review and merge a PR here
1. Read the PR against its task in `docs/TASKS.md` and the rules in `AGENTS.md`. For the money path, compare it line by line with V1. V1 is `fusionsdev/fusion_formv_v1` on branch `anjuna-port-base`, in `functions/api/[[path]].ts`.
2. Rebase on `main`. If only `bun.lock` conflicts, take main's copy, run `bun install`, then confirm with `bun install --frozen-lockfile`. Never hand-merge `bun.lock`.
3. Run `bun run build`, `bun run typecheck` and `bun run test` on Linux. On Windows, Miniflare tests can fail with `EADDRINUSE`; that is the environment, not the code.
4. Turbo appends an "agent guidance" block to `AGENTS.md`. Revert it before you commit.
5. Squash merge and delete the branch, then mark the Linear issue Done (project P-FUS-17).

## Owner decisions that are easy to miss
- **Conversions follow V1.** Every soldLead with payout > 0, after the clamp at 230, is queued, with or without a click ID.
- **T6c must match what the postback looks up.** It must write `leads.click_id` = lead_id without hyphens and `leads.brand` = brand_id, because the postback looks leads up by those values. The form sends `site_id=form-default` and `full_v1`/`lite_v1`.
- **Never reuse one template across brands.** Each brand gets a unique design from a builder (open-design, v0, Bolt, Lovable, Magic Patterns), checked through the template MCP plus a similarity check against the other brands.
- **Roles.** Employees can view, add and install brands, edit the keyword default, pause and roll back. Everything that changes where money flows is owner-only (`docs/plans/t12-control-panel.md`).
- **Quota.** Use cloud sessions (Sonnet) for Claude-heavy work. Keep the local machine for the local CLIs, WSL tests and deploys.

## Next, in order
1. Review and merge T6c and T11.
2. Wire the `packages/mailing` and `packages/insights` crons into core.
3. Deploy core: D1 `anjuna-leads`, secrets, and a WAF skip rule for `/api/postback` and `/api/conversions/*`.
4. Switch the panel off `MOCK_CORE` and add the `CORE` binding.
5. Template MCP.
6. T13/T14: a real LeadsGate test-sold and a real drain run. These need the owner and the manager.
7. T16: the first brand, on a unique builder template.

Not needed for the first brand: T10 install Workflows, T17 the friend's tenant.
