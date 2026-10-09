# Gate evidence: T13 (G1)

- Gate: T13 (G1), FUS-349
- Date and time (with offset): postback recorded at `2026-10-08T23:22:37.571Z`, equivalent to `2026-10-09T06:22:37.571+07:00`.
- Run by: owner configured the brand; LeadsGate manager pressed Test sold. U03 reviewed the supplied evidence offline.
- Environment: production database `aduplift-leads`; brand id `brand_e210d8e7f5234dde`; owner-reported aid `13119`. Account id and deployed commit were not supplied. Local review commit: `fb5c09c9992b255deac7d9da0f0bbae2105e6d7c` (not a deployment claim).
- Result: **PASS** for the three T13 acceptance criteria, based on the owner-reported response and supplied production rows.

Source: `H:/w/t12a/anjuna/longrun/input/U03.txt`, already-fetched read-only query results. Each of the four queries reports `success: true`, `changes: 0`, `changed_db: false`, and `rows_written: 0`. No production queries or external calls were made for this review.

The owner reports that on 2026-10-09 they set aid `13119`, rotated the postback token, and configured the Sold/Reject URL. The manager pressed Test sold. The reported core response was:

```json
{"status":"accepted","lead_id":"364b99d5-236b-4df8-9357-b2971fcbea05"}
```

## Steps

| Step | Command or action | Output (secrets removed) | Expected | Result |
|---|---|---|---|---|
| 1 | Verify LeadsGate echoes our `click_id` in `cid`. | Row A has `click_id=364b99d5236b4df89357b2971fcbea05`; row B records `soldLead` for the same lead; core reported `accepted` for that lead. | Callback `cid` matches the stored `click_id`. | **PASS** — inferred from the accepted callback and matching rows under core's `cid` lookup contract. |
| 2 | Verify the postback was not blocked by Cloudflare. | Core reported `accepted`; row B was persisted at `2026-10-08T23:22:37.571Z`, with row C at the same time. | Test sold reaches core and writes its event. | **PASS** for this Test sold request. |
| 3 | Verify a `conversion_uploads` row exists. | Row C: `id=1`, matching lead id, `value=1`, `status=pending`, created at `2026-10-08T23:22:37.571Z`. | A conversion row is created. | **PASS**. |
| 4 | Inspect continuation use as supporting evidence. | Row D: `used_at=2026-10-08T21:18:28.029Z`, before `expires_at=2026-10-08T21:48:27.819Z`. | Continuation was consumed before expiry. | **PASS**; this alone does not prove the redirect's query values. |

The callback inference uses `workers/core/src/postback.ts`: core looks up `leads.click_id` using the cleaned `cid`; an unmatched callback returns `ignored/unknown_click`. The buyer's `lead_id` is not the join key. The supplied response and rows therefore support a successful `cid` match. The raw inbound `cid`, redirect Location header, and LeadsGate log were not supplied; this is not a claim of direct packet capture or verification of the deployed code revision.

## Query rows

Exact field values below are projections of the supplied rows. Omitted fields are not reconstructed. No applicant email, phone, name, street address, full prepop URL, or token is copied.

### A. `leads`

```json
{
  "lead_id": "364b99d5-236b-4df8-9357-b2971fcbea05",
  "click_id": "364b99d5236b4df89357b2971fcbea05",
  "state": "IL",
  "zip": "60610",
  "status": "soldLead",
  "brand": "brand_e210d8e7f5234dde",
  "created_at": "2026-10-08T21:18:27.819Z"
}
```

### B. `postback_events`

```json
{
  "id": 1,
  "lead_id": "364b99d5-236b-4df8-9357-b2971fcbea05",
  "event_type": "soldLead",
  "payout": 1,
  "created_at": "2026-10-08T23:22:37.571Z"
}
```

### C. `conversion_uploads`

```json
{
  "id": 1,
  "lead_id": "364b99d5-236b-4df8-9357-b2971fcbea05",
  "has_gclid": 0,
  "value": 1,
  "status": "pending",
  "created_at": "2026-10-08T23:22:37.571Z"
}
```

`has_gclid` is the supplied query's `gclid IS NOT NULL` result. Its value `0` means the stored gclid is null. A missing gclid is expected for this test lead. **G2 (T14) needs a real gclid**, pending/ack evidence, and one successful real AdKit upload. This pending row does not prove an upload.

### D. `continuations`

```json
{
  "lead_id": "364b99d5-236b-4df8-9357-b2971fcbea05",
  "brand_id": "brand_e210d8e7f5234dde",
  "expires_at": "2026-10-08T21:48:27.819Z",
  "used_at": "2026-10-08T21:18:28.029Z"
}
```

## Deviations and surprises

- Recorded payout and conversion value are `1`; the runbook example uses `5`. The positive payout created the required conversion row.
- The test lead has no gclid; the runbook example uses a synthetic value. Neither establishes G2.
- UTC rows fall on 2026-10-08. The postback is on 2026-10-09 at offset `+07:00`, consistent with the owner's reported date.
- This review uses supplied production evidence. It does not rerun the live runbook.

## Not checked

- **NOT_RUN / NOT_CHECKED:** separate wrong-token reachability probe and response headers; Cloudflare WAF/BIC configuration inspection. The PASS above covers the observed accepted request only.
- **NOT_RUN / NOT_CHECKED:** direct redirect header and raw `cid` capture, independent verification of aid and token configuration, and a separate LeadsGate Test sold log.
- **NOT_RUN / NOT_CHECKED:** replay/idempotency, Reject callback, and a new form submission.
- **NOT_RUN / NOT_CHECKED:** G2 drain pending/ack and real AdKit upload; T10 live install, G3 cross-account, and T16 approval.

## Approval (T16 only)

Not applicable to T13. No T16 approval is recorded here.
