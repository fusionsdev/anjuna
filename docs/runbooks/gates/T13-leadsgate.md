# T13 (G1): real LeadsGate prepop and "Test sold" postback to core

Pass when (brief section 10): LeadsGate echoes our `click_id` in `cid`; the postback is not blocked by Cloudflare; a `conversion_uploads` row is created.

Money path facts, from `docs/adr/0002-leadsgate-prepop-and-postback.md` and `workers/core/src/postback.ts`:

- Core builds the prepop URL with `aid` and `click_id` = `lead_id` without hyphens. The browser only ever sees `<formRoute>/provider?c=<continuation>`, which answers 302 to the prepop URL with `Referrer-Policy: no-referrer`.
- Postback: `GET https://core.aduplift.ai/api/postback?token&cid&payout&lead_id&type`. `cid` is matched against `leads.click_id`. `type` is `newLead`, `soldLead` or `rejectLead`. Payout is clamped to 230.
- Responses: `401` bad token, `400` invalid query, `{"status":"ignored","reason":"unknown_click"}`, `{"status":"accepted"}`, `{"status":"duplicate"}`.
- Every `soldLead` with payout above 0 inserts a `conversion_uploads` row, whether or not the lead has a click id.

## Preconditions

- [ ] T10 live passed and `levellendings.com` is serving the brand (READY).
- [ ] README open question 1 (aid `13119` vs tenant `10001`) is resolved and the brand really redirects with aid `13119`.
- [ ] README questions 4 and 5 answered: LeadsGate macro names and the per-brand postback token.
- [ ] The LeadsGate manager has created the Sold and Reject postback entries for the test domain pointing at core.
- [ ] You can run read-only D1 queries: `bunx wrangler d1 execute anjuna-leads --remote --command "SELECT 1"` from `workers/core` with your own Cloudflare login.

## Steps

1. **No-write reachability check (WAF).** From your machine, with a wrong token. This writes nothing.
   ```bash
   curl -s -i -A "curl/8" "https://core.aduplift.ai/api/postback?token=wrong&cid=x&payout=1&lead_id=x&type=soldLead" | head -12
   ```
   Expect `401`. A Cloudflare `403` HTML page means the WAF skip rule is missing: stop (brief CO-6).
2. **Submit a test lead** on `https://levellendings.com/?keyword=test%20loan&gclid=TEST-NOT-REAL` through the real form with the owner's own test data and consent. Open the browser network tab first and keep it open.
3. **Check the redirect.** In the network tab: `POST /api/leads` returns `redirect_url` ending in `/provider?c=...`. The next response is a 302 whose `Location` is the LeadsGate prepop URL. Record the `aid` and `click_id` query values only. Expect `aid=13119` and `click_id` equal to the lead id without hyphens. The URL also carries the lead's form fields as GET params (V1 prepop), so use test data and do not paste the full URL anywhere.
4. **Find the lead.**
   ```bash
   bunx wrangler d1 execute anjuna-leads --remote --command "SELECT lead_id, click_id, brand, status, created_at FROM leads ORDER BY created_at DESC LIMIT 3"
   ```
   Expect `click_id` equal to the value in step 3 and `brand` equal to the brand id.
5. **Manager triggers "Test sold"** in LeadsGate for that lead with payout `5`.
6. **Verify the writes.**
   ```bash
   bunx wrangler d1 execute anjuna-leads --remote --command "SELECT lead_id, event_type, payout, created_at FROM postback_events ORDER BY created_at DESC LIMIT 3"
   bunx wrangler d1 execute anjuna-leads --remote --command "SELECT lead_id, status, value, attempts FROM conversion_uploads ORDER BY created_at DESC LIMIT 3"
   ```
   Expect one `postback_events` row of type `soldLead` and one `conversion_uploads` row with status `pending` and value `5`.
7. **Replay is idempotent.** Ask the manager to send the same Test sold again. Expect `duplicate` and no extra rows.

## Expected result

All three G1 conditions hold: `cid` matched the `click_id` we sent, the postback returned `accepted` (not `401` or a Cloudflare `403`), and a `conversion_uploads` row exists.

## Evidence to capture

Step 1 output, the `aid` and `click_id` from the `Location` header (not the full URL, it holds the test lead's fields), the three D1 outputs, LeadsGate's own "Test sold" log line.

## Stop and rollback

- `401` on a correct token: the plaintext token and the stored hash differ. Stop. Do not loosen the check.
- `unknown_click`: LeadsGate did not echo our `click_id`. This is a G1 failure; record what `cid` it sent.
- A row appears twice: stop and record. Idempotency is a V1 contract.
- To undo, pause the brand in the panel. Test rows stay in D1 and are marked by the test domain.
