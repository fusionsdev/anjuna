# Anjuna handoff — 2026-10-09

**T10 and T13/G1 have PASS evidence. G2, G3 and T16 remain open. PR #42 is superseded by this handoff.** This replaces the 2026-10-02 instructions, including “T10 is not needed.” Sources: [T10 evidence](runbooks/gates/evidence-T10.md), [T13 evidence](runbooks/gates/evidence-T13-g1.md), [T16 prerequisites](runbooks/gates/T16-first-brand.md), [U12 assignment](../scripts/longrun/units/U12-handoff-refresh.md).

## Snapshot and working rules

- Main was read locally with `git log origin/main`, through [`1a1ca4e` / PR #80](https://github.com/fusionsdev/anjuna/commit/1a1ca4e6e956ddea06c7394d8b7deb1a15c444e7), committed 2026-10-09 12:46:41 +07:00. No fetch or live service check was run. This is a dated snapshot, not a deployment report.
- The read-only [long-run log](H:/w/t12a/anjuna/longrun/log.jsonl) was read through `2026-10-09T05:48:16Z`. The summary below preserves its results for cloud sessions without local-file access. Main history takes precedence over stale log entries.
- Work in the assigned directory and current branch. U12 uses `H:/w/t12a/anjuna-lr/U12`, branch `docs/handoff-5`, and edits only this file and `docs/TASKS.md`. Do not follow the old instruction to abandon other directories and switch to main. See [U12 scope](../scripts/longrun/units/U12-handoff-refresh.md) and [builder restrictions](../scripts/longrun/longrun.sh).
- Follow [AGENTS.md](../AGENTS.md): V1 parity; LeadsGate prepop redirect only; no cloaking; clean brand bytes; D1 for lead data; owner-gated real-system actions. Keep the managed Turborepo guidance block. This builder must not push, tag, deploy, merge, create branches, run worktree commands or call Cloudflare, LeadsGate or a VPS. [Builder prompt](../scripts/longrun/longrun.sh).

## Live systems and versions

These are recorded observations or configured targets. **NOT_CHECKED** means the sources do not establish current health or deployment version. A merged commit or configured hostname does not prove deployment. [T10 limits](runbooks/gates/evidence-T10.md#not-checked), [T13 limits](runbooks/gates/evidence-T13-g1.md#not-checked).

| System | Recorded state | Version and evidence |
|---|---|---|
| AdUplift account | Configured account `6cb8500c35210800451bd9a535482850`. | [Tenant config](../tenants/aduplift.config.ts). |
| `core.aduplift.ai` | Production Test sold accepted; `aduplift-leads` has the sold event and pending conversion at `2026-10-08T23:22:37.571Z`. The older `anjuna-leads` label in the gate README is stale for this evidence. | Deployed Worker version, commit and release tag: **NOT_CHECKED**. [T13 rows](runbooks/gates/evidence-T13-g1.md), [release database names](../.github/workflows/deploy.yml). |
| `app.aduplift.ai` | Historically live behind Cloudflare Access. Real `CORE` / `AdminService` binding and `MOCK_CORE=0` merged. Lifecycle, reports and Employee install follow-ups are merged. | Current deployed version: **NOT_CHECKED**. [Historical record](https://github.com/fusionsdev/anjuna/blob/9d31237/docs/HANDOFF.md), [binding](https://github.com/fusionsdev/anjuna/commit/89cc594), [#40](https://github.com/fusionsdev/anjuna/pull/40), [#41](https://github.com/fusionsdev/anjuna/pull/41), [#74](https://github.com/fusionsdev/anjuna/pull/74). |
| Factory and `levellendings.com` | Production receipts show READY, rollback and compensation. Exported brand `brand_e210d8e7f5234dde` is `live`, updated `2026-10-08T20:37:37.653Z`. | Recorded revision `brand_e210d8e7f5234dde_rev_1`. Provider Worker version and deployed commit: **NOT_CHECKED**. U04's new server guard was **not deployed** by that session. [T10 report](runbooks/gates/evidence-T10.md). |
| `mcp.aduplift.ai` | Template MCP, certification/seal pipeline and AdUplift factory binding merged. No longer an in-flight build. | Configured Worker `anjuna-template-mcp`; live version/health: **NOT_CHECKED**. [#27](https://github.com/fusionsdev/anjuna/pull/27), [#55](https://github.com/fusionsdev/anjuna/pull/55), [config](../workers/template-mcp/wrangler.jsonc). |
| Maimax: `core.maimax.fit`, `app.maimax.fit` | Separate tenant configuration and provisioned D1 IDs committed. Account `c1a44deffd54a8ce35cb9e68abeb7b11`. Not AdUplift account B for G3. | Current live versions/health and two-tenant acceptance: **NOT_CHECKED**. [Config](../tenants/maimax.config.ts), [bootstrap #35](https://github.com/fusionsdev/anjuna/pull/35), [G3 account distinction](runbooks/gates/README.md). |
| Drain / AdKit | G1 created a pending conversion with no gclid. It does not prove upload. | Installed drain version and G2 upload: **NOT_CHECKED**. [G1 limits](runbooks/gates/evidence-T13-g1.md#c-conversion_uploads), [T14](runbooks/gates/T14-drain.md). |
| `demo1..5.aduplift.ai` | Historical TEST-banner brands with source outside this repo. | Current versions/health: **NOT_CHECKED**; not T16 evidence. [Historical record](https://github.com/fusionsdev/anjuna/blob/9d31237/docs/HANDOFF.md), [T16 criteria](runbooks/gates/T16-first-brand.md). |

Source versions are separate: Bun `1.3.13`, lead payload `2026-01`, and form bundle identity `form@<git_sha>`. No deployed artifact SHA is established here. [package.json](../package.json), [tenant defaults](../tenants/aduplift.config.ts), [artifact metadata](runbooks/form-artifact-payload-version.md).

## T-task status

“Merged” means present in the main snapshot above. It does not certify live acceptance. Definitions remain in [TASKS.md](TASKS.md).

| Task / issue | Status | Evidence |
|---|---|---|
| T1 / FUS-336 | ADRs/rules and V1/spec reconciliation merged. | [#1](https://github.com/fusionsdev/anjuna/pull/1), [#5](https://github.com/fusionsdev/anjuna/pull/5), [#48](https://github.com/fusionsdev/anjuna/pull/48), [ADRs](adr/). |
| T2 / FUS-337 | D1 schemas and ZIP seed merged. Live application of the seed is not established by the merge. | [#3](https://github.com/fusionsdev/anjuna/pull/3), [#78](https://github.com/fusionsdev/anjuna/pull/78), [U01 context](../scripts/longrun/units/U01-zip-seed.md). |
| T3 / FUS-338 | Contracts and V1 golden fixtures merged. G4 record reports 161 passed, 5 skipped on Windows; requests Linux recheck. | [#4](https://github.com/fusionsdev/anjuna/pull/4), [G4 record](runbooks/gates/README.md). |
| T4 / FUS-339 | Form and CRLF fix merged. Upload-workflow move #79 is owner-ready in the log, not in main. | [#6](https://github.com/fusionsdev/anjuna/pull/6), [#49](https://github.com/fusionsdev/anjuna/pull/49), [U09 card](../scripts/longrun/units/U09-lead-form-upload-workflow.md), [log](H:/w/t12a/anjuna/longrun/log.jsonl). |
| T5 / FUS-340 | Astro and React starters merged. | [#2](https://github.com/fusionsdev/anjuna/pull/2), [template contract](template-contract.md). |
| T6 / FUS-341 | Auth, money path, lead RPC, admin API and crons merged. Duplicate-submit parity and Windows cron test fixes merged. | [#12](https://github.com/fusionsdev/anjuna/pull/12), [#14](https://github.com/fusionsdev/anjuna/pull/14), [#17](https://github.com/fusionsdev/anjuna/pull/17), [cron wiring](https://github.com/fusionsdev/anjuna/commit/4ec328c), [#52](https://github.com/fusionsdev/anjuna/pull/52), [#80](https://github.com/fusionsdev/anjuna/pull/80). |
| T7 / FUS-342 | Runtime, factory bundle, neutral completion and brand-domain `/apply` handoff merged. | [#13](https://github.com/fusionsdev/anjuna/pull/13), [#50](https://github.com/fusionsdev/anjuna/pull/50), [#53](https://github.com/fusionsdev/anjuna/pull/53), [#57](https://github.com/fusionsdev/anjuna/pull/57). |
| T8 / FUS-343 | Mailing sync, scheduled wiring and tenant secret support merged. No live listmonk acceptance claimed. | [#10](https://github.com/fusionsdev/anjuna/pull/10), [cron wiring](https://github.com/fusionsdev/anjuna/commit/4ec328c), [#38](https://github.com/fusionsdev/anjuna/pull/38). |
| T9 / FUS-344 | Insights/alerts and report UI merged. | [#11](https://github.com/fusionsdev/anjuna/pull/11), [#41](https://github.com/fusionsdev/anjuna/pull/41). |
| T10 / FUS-345 | Workflows merged. **PASS** for four criteria using production receipts plus local guard, replay and forced-failure tests. Required for the first brand. | [#26](https://github.com/fusionsdev/anjuna/pull/26), [evidence / #72](runbooks/gates/evidence-T10.md), [T16 prerequisites](runbooks/gates/T16-first-brand.md). |
| T11 / FUS-346 | Checker, Template MCP, certification/seal and AdUplift binding merged. | [#16](https://github.com/fusionsdev/anjuna/pull/16), [#19](https://github.com/fusionsdev/anjuna/pull/19), [#27](https://github.com/fusionsdev/anjuna/pull/27), [#55](https://github.com/fusionsdev/anjuna/pull/55). |
| T12 / FUS-347 | Admin contract, shell/auth, panel, lifecycle, reports and Employee sealed-template install path merged. U08 outcome follow-up still running in log. | [#8](https://github.com/fusionsdev/anjuna/pull/8), [#9](https://github.com/fusionsdev/anjuna/pull/9), [#28](https://github.com/fusionsdev/anjuna/pull/28), [#40](https://github.com/fusionsdev/anjuna/pull/40), [#41](https://github.com/fusionsdev/anjuna/pull/41), [#74](https://github.com/fusionsdev/anjuna/pull/74), [log](H:/w/t12a/anjuna/longrun/log.jsonl). |
| T13 / FUS-349 / G1 | **PASS**. Accepted Test sold, matching lead/event and pending conversion. `cid` match is inferred from the lookup contract, not packet capture. | [Evidence / #69](runbooks/gates/evidence-T13-g1.md). |
| T14 / FUS-350 / G2 | **OPEN**. Real gclid, unchanged pending/ack and one successful AdKit upload required. | [G1 does not prove G2](runbooks/gates/evidence-T13-g1.md#c-conversion_uploads), [runbook](runbooks/gates/T14-drain.md). |
| T15 / FUS-351 / G3 | **OPEN**. Needs account B, cross-account submit/postback, no 1042 and credential isolation. | [Runbook](runbooks/gates/T15-cross-account.md), [account gap](runbooks/gates/README.md). |
| T16 / FUS-352 | **OPEN**. No owner approval recorded. Live test-brand status and G1 PASS are insufficient. | [Runbook](runbooks/gates/T16-first-brand.md), [T13 approval section](runbooks/gates/evidence-T13-g1.md#approval-t16-only). |
| T17 / FUS-348 | Bootstrap/release matrix merged; maimax config/D1 IDs committed. Full two-tenant release and token-isolation acceptance not established. | [Implementation](https://github.com/fusionsdev/anjuna/commit/0c06b45), [#30](https://github.com/fusionsdev/anjuna/pull/30), [#35](https://github.com/fusionsdev/anjuna/pull/35), [workflow](../.github/workflows/deploy.yml), [acceptance](TASKS.md). |

T10 limits: the production failure was not proven deliberately injected; deliberate failure was tested locally. No live before/after inventory proves second-request idempotency. One historical compensation failed with `recovery_required: true`. PASS does not mean every failure recovered. [Exact limits](runbooks/gates/evidence-T10.md#deviations-and-surprises).

## Long-run result snapshot

Every log status below refers to the [local log](H:/w/t12a/anjuna/longrun/log.jsonl) cutoff above. Repository links preserve merged results for cloud sessions. All times are UTC on 2026-10-09.

| Unit | Recorded result |
|---|---|
| U01 | Merged [#78](https://github.com/fusionsdev/anjuna/pull/78), ZIP seed, `05:11:48Z`. |
| U02 | Merged [#74](https://github.com/fusionsdev/anjuna/pull/74), Employee install, `03:47:55Z`. |
| U03 | Log ends parked at `02:38:31Z`, but main contains [#69](https://github.com/fusionsdev/anjuna/pull/69) and [G1 PASS](runbooks/gates/evidence-T13-g1.md). Parked entry is stale. |
| U04 | Merged [#72](https://github.com/fusionsdev/anjuna/pull/72), T10 evidence/guard, `02:55:12Z`. |
| U05 | Parked `05:19:14Z`: rounds exhausted, tests failed. [Recovery card](../scripts/longrun/units/U05-compensation-lock-recovery.md). |
| U06 / U07 | No events in the supplied log; no completion claim. [Retry race](../scripts/longrun/units/U06-retry-compensation-race.md), [paused smoke](../scripts/longrun/units/U07-paused-upgrade-smoke.md). |
| U08 | Latest event `build:r1`, `05:13:30Z`; no merged outcome. [Card](../scripts/longrun/units/U08-upgrade-outcome-visible.md). |
| U09 | [#79](https://github.com/fusionsdev/anjuna/pull/79) ready for owner `05:32:37Z`; not merged in this main snapshot. |
| U10 | Merged [#80](https://github.com/fusionsdev/anjuna/pull/80), Windows cron test, `05:46:28Z`. |
| U11 | `maimax-leads` query failed `05:47:40Z`; report path recorded `05:47:48Z`. No counts inferred. [Report card](../scripts/longrun/units/U11-zip-counts-report.md). |
| U12 | This refresh; latest log event `build:r1`, `05:48:16Z`. [Card](../scripts/longrun/units/U12-handoff-refresh.md). |

## Open owner items

1. **G2 drain:** follow [T14](runbooks/gates/T14-drain.md), peek first, then one real upload with a real gclid. Record pending/ack and AdKit success. The G1 conversion has no gclid. [Evidence](runbooks/gates/evidence-T13-g1.md#c-conversion_uploads).
2. **G3 account B:** supply an AdUplift-owned second account and scoped credential. Record cross-account success and rejection outside that account. Maimax has its own core and does not satisfy G3. [T15](runbooks/gates/T15-cross-account.md), [account distinction](runbooks/gates/README.md).
3. **Token rotation:** confirm rotation of the two leaked maimax Cloudflare API tokens. Completion is not recorded in gate evidence. This is separate from the test brand postback token, whose rotation is owner-reported on 2026-10-09. [T16 prerequisite](runbooks/gates/T16-first-brand.md#preconditions), [postback rotation](runbooks/gates/evidence-T13-g1.md).
4. **T16 approval:** after G1/G2/G3 PASS, complete the unique-template install, checklist and full e2e. Record owner approval in FUS-352 with evidence links. Confirm production aid: the test uses `13119`, while committed AdUplift defaults still use `10001`. [T16](runbooks/gates/T16-first-brand.md), [G1](runbooks/gates/evidence-T13-g1.md), [defaults](../tenants/aduplift.config.ts).
5. **Release tag:** review merged changes and owner-ready #79 before selecting a release. Only the owner pushes a `v*` tag. It triggers deployment and migrations; a main merge does not. Record the tag, deployed commits and Worker version IDs. T10's server guard still needs deployment confirmation. [Workflow](../.github/workflows/deploy.yml), [release rule](../scripts/longrun/README.md#guardrails), [T10 limit](runbooks/gates/evidence-T10.md).

Use the [evidence template](runbooks/gates/evidence-template.md) for new gates. The template itself is not evidence. Never include tokens or applicant PII. [Gate rules](runbooks/gates/README.md#rules-for-every-gate).

## Run the long-run supervisor

Owner-only instructions, not commands for a credential-disabled builder. Use Git Bash in the main clone with Bun, Git, `gh`, Wrangler, Codex and the opencode reviewer available. Documented setup uses authenticated `gh` and Wrangler; `JEV_API_KEY` is optional. [Setup](../scripts/longrun/README.md#start), [CLI calls](../scripts/longrun/longrun.sh), [review wrapper](../scripts/longrun/review.sh).

```bash
cd /h/w/t12a/anjuna
bash scripts/longrun/longrun.sh --dry-run
# After reviewing the unit states, start the actual run:
bash scripts/longrun/longrun.sh --parallel 2
# Or select named units:
bash scripts/longrun/longrun.sh --only U01,U03
```

Run one supervisor at a time; `supervisor.pid` rejects a second live process. **Dry-run writes state:** selected runnable units become `dry`, while normal scheduling selects `todo`. Review `longrun/state/*.status` after a preview and deliberately reset only intended units to `todo`. Do not blindly reset merged, parked or owner-ready units. There is no automatic reset of `dry` states. [Parsing, dry-run and scheduler code](../scripts/longrun/longrun.sh).

The supervisor manages branches/worktrees, read-only D1 input, builds, checks, reviews, PRs and eligible auto-merges. Builders receive blanked credentials. Money-path cards stop for owner merge. The loop does not tag or deploy. Read `longrun/OWNER_NEEDED.md`, `longrun/log.jsonl` and unit states before resuming; reconcile stale log entries with main, as for U03 above. [Implementation](../scripts/longrun/longrun.sh), [operating rules](../scripts/longrun/README.md).

Run `bun run typecheck` and `bun run test` from the assigned repo root before committing. Local tests do not close live gates. [Definition of done](../AGENTS.md), [gate rules](runbooks/gates/README.md#rules-for-every-gate).
