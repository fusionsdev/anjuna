---
id: U03
title: docs(gates): record G1 LeadsGate loop evidence
branch: fus-349-g1-evidence
lane: docs-g1
deps:
builder: codex
reviewers: none
paths: docs/runbooks/gates/
merge: auto
---
## Goal
Close T13 (G1). On 2026-10-09 the owner set brand aid 13119, rotated the postback token and set the Sold/Reject URL. The manager pressed Test sold. Core replied `{"status":"accepted","lead_id":"364b99d5-236b-4df8-9357-b2971fcbea05"}`.

## Do
1. Read the production query results file named in the prompt header. It holds the lead row, `postback_events`, `conversion_uploads` and `continuations` for that lead.
2. Write `docs/runbooks/gates/evidence-T13-g1.md` from `docs/runbooks/gates/evidence-template.md`.
3. Criteria (`docs/TASKS.md` T13): LeadsGate echoes our click_id in cid; the postback is not blocked by Cloudflare; a `conversion_uploads` row exists. Mark each PASS, FAIL or NOT_RUN with the exact rows as proof. A missing gclid is expected for a test lead. Say that G2 needs a real gclid.
4. Copy no email, phone, name or address. Use only ids, state, zip, status, amounts and timestamps.

## Acceptance
- The evidence file exists with each T13 criterion marked and backed by query rows.
- The file holds no PII.
