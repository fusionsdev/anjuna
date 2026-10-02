# Anjuna — rules for every agent

Anjuna is a lead-gen platform that runs entirely on Cloudflare. Each brand gets one Worker with a Custom Domain that serves a static landing page and the lead form. One shared core (`core.aduplift.ai`) stores leads in D1, hands buyers off to LeadsGate by prepop redirect, receives LeadsGate postbacks and queues Google Ads conversions for the existing VPS drain (`drain.mjs` → AdKit). "AURUM" means only the legacy systems, which are port sources.

## Read first

1. `docs/PRODUCT-BRIEF.md` — what to build, with requirement IDs (BR-*, CO-*, FO-*, TP-*, FA-*, TN-*).
2. `docs/TASKS.md` — the task you are assigned (T1–T17), its acceptance criteria and its Linear issue.
3. `spike/` — working reference code that proved the full loop on real Cloudflare. Read it; do not edit it.

## Port sources (read-only)

- V1 core: `https://github.com/fusionsdev/fusion_formv_v1`, branch `anjuna-port-base` (commit `8404ec2`).
- Form: `https://github.com/fusionsdev/aurum-form`, branch `anjuna-port-base` (commit `8ba11d3`).

Clone them outside this repo, for example `git clone --depth 1 -b anjuna-port-base <url> /tmp/v1`. Never push to them and never copy from any other branch.

## Hard rules

1. **V1 parity.** Port V1 behavior. V1 has handled about 1,000 production leads. Do not invent new loss-prevention machinery.
2. **Buyer handoff is LeadsGate prepop redirect only.** No server-side post to LeadsGate, and no `LEADSGATE_ENDPOINT`.
3. **No cloaking.** No response may vary by user agent, IP, ASN, referrer, gclid or bot detection. The flow gate depends only on what the visitor did (valid amount + ZIP from the landing page).
4. **Brand bytes stay clean.** Nothing a brand serves may contain another brand's identifiers, the strings "anjuna" or "aurum", a PostHog key or a Sentry DSN.
5. **Cloudflare only.** D1 for all data. R2 only for sealed template/form artifacts and certification evidence; lead data never goes to R2. Workers and Workflows for compute.
6. **No secrets in git.** Never commit `.dev.vars`, API tokens or secrets. Account IDs are allowed in wrangler config (they guard against deploying to the wrong account). D1 database IDs use placeholders until the databases are created.
7. **No deploys and no real external calls.** Do not deploy to Cloudflare, call LeadsGate, or touch the drain. Those are owner-gated (Wave 4).

## How to work

- **One task = one branch = one pull request.** Name the branch after the task's Linear issue, for example `fus-337-d1-schemas`. Branch from `main`.
- **Stay in scope.** If you find work outside your task, list it in the PR description under "Proposed (out of scope)". Do not implement it.
- **Do not merge.** The owner approves every merge into `main`.
- **Definition of done:** the task's acceptance criteria in `docs/TASKS.md`, plus `bun run typecheck` and `bun run test` green. In the PR description, map each acceptance criterion to its evidence (test name or command output).

## Layout

| Path | Contents |
|---|---|
| `apps/` | `lead-form` (T4), `web` control panel (T12) |
| `packages/` | `contracts` (T3), `leads-db`, `factory-db`, `auth-db` (T2), `brand-runtime` (T7), template starters (T5) |
| `workers/` | `core` (T6), factory Workflows (T10) |
| `docs/adr/` | architecture decision records (T1): 0001 D1 only, 0002 LeadsGate prepop + postback, 0003 brand Worker topology, 0004 same-origin tracking |
| `spike/` | reference only |

## Tooling

- Bun workspaces (`apps/*`, `packages/*`, `workers/*`), Turborepo, TypeScript strict, Vitest.
- Worker tests run with Miniflare / `@cloudflare/vitest-pool-workers`. Use `compatibility_flags: ["global_fetch_strictly_public"]` on every brand Worker and on any Worker that fetches another Worker in the same zone (error 1042).
- Root commands: `bun install`, `bun run build`, `bun run test`, `bun run typecheck`.
- Each package defines its own `build`, `test` and `typecheck` scripts so Turborepo can run them.
