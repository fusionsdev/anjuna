# T16: first production brand

Done when (`docs/TASKS.md` T16): full end-to-end is green and the owner approval is recorded. Do not start before G1, G2 and G3 have evidence files that say PASS.

## Preconditions

- [ ] T10 live, T13 (G1), T14 (G2), T15 (G3) evidence files exist and say PASS. G4 evidence is in the README.
- [ ] A **unique** template for this brand from a builder (owner decision: never reuse one template across brands), registered as a template version the factory accepts (README question 2: no `check-template` gate). A similarity check against the other brands has been done. NOT_VERIFIED that the similarity check tool exists in the repo.
- [ ] The two leaked maimax Cloudflare API tokens were rotated by the owner.
- [ ] Production aid for this brand is configured (not the test aid `13119`). See README question 1.

## Steps

1. **Create and install** the brand from Domain and Keyword in the panel (Employee or Owner). Expect READY.
2. **Add-brand checklist** in the panel, all four items (brief FA-4):
   - brand route added to the VPS drain (`BRAND_ROUTING_JSON`);
   - LeadsGate Sold and Reject postback entries point at core;
   - "Test sold" produced a `postback_events` row (the panel verifies this against core);
   - the Google Ads campaign Final URL suffix contains `keyword={keyword}`.
3. **Smoke by hand** with the commands from the T10 runbook step 4, plus a full form submission and the LeadsGate redirect.
4. **Alerts armed** (brief FA-5): pending conversion age, no postbacks in 24 hours, submit error rate, reject rate.
5. **Owner approval recorded.** Write the approval in Linear FUS-352 as a comment (date, brand, domain, template version id, evidence file names). The panel audit log already records every config change.
6. **Watch for 24 hours:** funnel report, alerts, `conversion_uploads` pending age.

## Expected result

READY, four checklist items confirmed, alerts armed, approval comment present.

## Evidence to capture

Brand id, template version id and its SHA-256, install id, checklist screenshot, the evidence files of the earlier gates, the Linear comment URL.

## Stop and rollback

- Any gate evidence is missing or says anything other than PASS: stop.
- A problem after launch: pause the brand in the panel (neutral page for every visitor, brief BR-10), then roll back.
