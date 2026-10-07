# T14 (G2): real `drain.mjs` against core

Pass when: pending and ack work unchanged, and one real AdKit upload succeeds. The drain is the existing V1 VPS drain; only its base URL changes to core (ADR-0002 decision 4). The agent has not seen `drain.mjs` or the VPS. Everything about the VPS below is the owner's to confirm.

Core side, from `workers/core/src/conversions.ts` (V1 port):

- `GET /api/conversions/pending?limit=N` claims rows (status `processing`) and returns them with `brand` and `hostname`.
- `GET /api/conversions/pending?limit=N&peek=1` returns eligible rows **without claiming them**. Use it first.
- `POST /api/conversions/ack` accepts `uploaded`, `failed` or `deferred`; rows go `dead` after 6 attempts.
- Auth is `Authorization: Bearer <DRAIN_TOKEN>`, header only.

## Preconditions

- [ ] T13 produced at least one `conversion_uploads` row with status `pending`.
- [ ] A **real Google click id.** A synthetic `gclid` such as `TEST-NOT-REAL` creates a row but Google rejects the upload, so G2's "one real AdKit upload" needs a lead that carries a real `gclid` or `gbraid`. NOT_VERIFIED how you will get one (for example, click your own test ad). Plan it before you start.
- [ ] `DRAIN_TOKEN` is available to you as an environment variable. Never paste it.
- [ ] You know where the aduplift drain config lives on the VPS (`ssh hstgr`) and how `BRAND_ROUTING_JSON` is written. NOT_VERIFIED by the agent.

## Steps

1. **Peek from your own machine (no claim).**
   ```bash
   curl -s -H "Authorization: Bearer $DRAIN_TOKEN" "https://core.aduplift.ai/api/conversions/pending?limit=5&peek=1"
   ```
   Expect `{"conversions":[...]}` containing the T13 row with `brand` and `hostname`. Run it twice: the row must still be `pending` after both.
2. **Wrong token check.** Same call with `Bearer wrong`. Expect `401`.
3. **Add the brand route** for `levellendings.com` to the drain's `BRAND_ROUTING_JSON` on the VPS, copying the shape of an existing entry. Keep a copy of the old file first.
4. **Point a copy of `drain.mjs` at core** (base URL `https://core.aduplift.ai`) and run it in its dry-run or peek mode first, if it has one. Confirm it lists the same row.
5. **One real run** limited to one conversion. Expect: the drain claims the row, AdKit uploads it, the drain acks `uploaded`.
6. **Verify.**
   ```bash
   bunx wrangler d1 execute anjuna-leads --remote --command "SELECT lead_id, status, attempts, last_error FROM conversion_uploads ORDER BY created_at DESC LIMIT 3"
   ```
   Expect `status = uploaded`. Then confirm the conversion in AdKit and in the Google Ads account (it can take hours to appear).

## Expected result

Peek never changes status. One real upload ends `uploaded`. No code change was needed in the drain except the base URL.

## Evidence to capture

Both peek outputs, the `401` output, the redacted VPS config diff (no tokens), the drain log lines for the run, the D1 row after the ack, the Google Ads conversion screenshot.

## Stop and rollback

- Drain gets `401`: wrong `DRAIN_TOKEN` on the VPS. Stop; do not change core's check.
- Row stays `processing`: the drain crashed before ack. Core reclaims stale leases by itself (bounded, then `dead`). Record it and do not re-run more than once.
- `failed` with a Google error: expected for a synthetic `gclid`. That is not a G2 pass.
- Roll back by restoring the saved VPS config and the previous base URL.
