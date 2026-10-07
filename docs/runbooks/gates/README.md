# Gate runbooks: T10 live, T13, T14, T15, T16

These runbooks turn the Phase 0 GO/NO-GO gates (`docs/PRODUCT-BRIEF.md` section 10) into steps an owner can run in minutes. They are documents only. Nothing here was executed by an agent. Every gate touches a real system, so every gate is **owner-gated** (`AGENTS.md` hard rule 7).

Each runbook has the same shape: preconditions, steps with exact commands, expected result, evidence to capture, stop and rollback.

| Runbook | Gate | Needs |
|---|---|---|
| [T10-live-install.md](T10-live-install.md) | T10 live acceptance | owner, Cloudflare deploy |
| [T13-leadsgate.md](T13-leadsgate.md) | G1 | owner and the LeadsGate manager |
| [T14-drain.md](T14-drain.md) | G2 | owner, VPS access |
| [T15-cross-account.md](T15-cross-account.md) | G3 | a second Cloudflare account |
| [T16-first-brand.md](T16-first-brand.md) | first production brand | everything above |
| [evidence-template.md](evidence-template.md) | all | copy one per gate |

G4 (V1 golden fixtures) needs no real system. Evidence 2026-10-07: `packages/contracts` tests, 161 passed and 5 skipped on Windows (`bun run test`). Re-run on Linux before citing it as final.

## Inputs supplied by the owner on 2026-10-07

| Input | Value | Note |
|---|---|---|
| Test domain | `levellendings.com` | zone status and DNS records NOT_CHECKED |
| LeadsGate TEST aid | `13119` | see open question 1 |
| aduplift drain host | reachable with the SSH alias `hstgr` | agents never connect |
| Core | `core.aduplift.ai`, D1 database `anjuna-leads` (HANDOFF) | live per HANDOFF, NOT_CHECKED today |

## Open questions that block a gate (answer before you start it)

1. **aid mismatch.** `tenants/aduplift.config.ts` has `leadsGateAid: "10001"`. The owner's TEST aid is `13119`. The brief says a revision cannot override tenant-owned runtime defaults, so a test brand with aid `13119` may need a temporary tenant-level change and a redeploy. Decide: change the tenant aid for the test, or give the test brand its own value. NOT_VERIFIED how the panel sets a per-brand aid.
2. **Template seal (soft risk, not a gate).** Owner decision 2026-10-07: the ready-made templates come from outside and `check-template` is not a gate; do not block a gate on it. For awareness only: the upgrade path in code requires a template version with status `sealed` (`validateUpgradeSelection`), and seal wants certification evidence (commit `bcda6a5`). NOT_VERIFIED whether the install path has the same requirement. If the install is refused for this reason, record it in the evidence file and ask for a code decision. Do not work around it by hand.
3. **Release path.** `.github/workflows/deploy.yml` runs on `v*` tags only (as of `e07a552`). The lifecycle panel (PR #40) reaches `app.aduplift.ai` only after #40 merges and a release tag is pushed. The tag is a deploy and is the owner's action.
4. **Postback macros.** The LeadsGate postback URL needs LeadsGate's own macro names for click id, payout and lead id. NOT_VERIFIED. Ask the manager for the exact macros and for how `type` (`newLead`, `soldLead`, `rejectLead`) is sent.
5. **Per-brand postback token.** Core stores only a SHA-256 hash (`brand_runtime.postback_token_hash`). NOT_VERIFIED where the plaintext is shown at provisioning. Find it before configuring LeadsGate.
6. **Second account for G3.** NOT_CHECKED whether an aduplift-owned account B exists. The maimax account is a separate installation with its own core, so it does not satisfy G3.

## Rules for every gate

- Never paste tokens, API keys, `DRAIN_TOKEN`, postback tokens or cookies into chat, Linear, a PR or these files. Export them as shell variables in your own terminal.
- Read-only first. Run the no-write checks before any step that writes.
- Stop on the first unexpected result. Record it in the evidence file. Do not retry past the stop rule.
- `NOT_RUN` and `NOT_CHECKED` are valid evidence. A step you did not run is not a pass.
- Rollback for any brand install: panel, brand page, Rollback (first install detaches the Custom Domain).
