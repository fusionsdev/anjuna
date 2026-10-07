# T15 (G3): a brand in account B talks to core in account A

Pass when (brief section 10): submit and postback work, there is no Cloudflare error 1042, and the per-account credential cannot write for a brand outside its account.

Design facts (brief BR-12, CO-2, section 9):

- Same account as core: Service Binding. Another account: HTTPS to `core.aduplift.ai` with a per-account **write-only** credential and `compatibility_flags: ["global_fetch_strictly_public"]` (otherwise a Worker fetching another Worker in the same zone fails with error 1042).
- Core's `/rpc/*` endpoints require that credential and reject any `brand_id` that is not owned by the calling account (`ownsBrand` in `workers/core/src/auth.ts`).

## Preconditions

- [ ] An aduplift-owned **account B** with an active test zone. NOT_CHECKED that it exists; the maimax account does not count, it runs its own core.
- [ ] A scoped token for account B stored in its own GitHub Environment or `wrangler secret`. Never in chat.
- [ ] A per-account credential created in core's `account_credentials` for account B. NOT_VERIFIED how it is issued today; find the bootstrap step before you begin.
- [ ] T10 live and T13 passed for the account-A brand.

## Steps

1. **Install a brand in account B** with the same flow as the T10 runbook, using account B's token.
2. **Submit a test lead** on that brand. Expect the lead in core's `leads` table with `brand` equal to the account-B brand id. Check with the D1 query from the T13 runbook.
3. **Postback** for that lead as in T13 step 5 to 6. Expect `accepted`.
4. **Check for 1042.** Look at the brand Worker logs for the submit and the postback path. Expect none.
5. **Negative test (core must refuse).** Using account B's credential, call core's RPC for a brand id that belongs to account A. Expect a rejection. The exact route, request body and status code are NOT_VERIFIED; read `workers/core/src/rpc/` first and write the expected status into the evidence file before sending anything. Use a throwaway test lead, never a real one.

## Expected result

Account-B submit and postback succeed. No 1042. The foreign-brand write is rejected.

## Evidence to capture

Install receipts for the account-B brand, the D1 rows, the log excerpt showing no 1042, the rejected request (status and body, credential redacted).

## Stop and rollback

- Error 1042: the brand Worker is missing `global_fetch_strictly_public`. Stop and fix the Worker config, not core.
- The foreign-brand write **succeeds**: this is a security failure. Stop all gates, revoke the credential, and record it.
- Roll back the account-B brand from the panel.
