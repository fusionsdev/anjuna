# Global LeadsGate Postback Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core accepts one tenant-wide LeadsGate postback token, so a new brand needs no postback setup in LeadsGate.

**Architecture:** Each tenant's core gets a Worker secret `POSTBACK_TOKEN`. `/api/postback` accepts a request when the token matches that secret or the lead's per-brand hash. The lead (found by `cid`) still decides the brand, so the global token does not change which brand gets credit. Per-brand tokens keep working, so existing LeadsGate entries do not break during the switch.

**Tech Stack:** Cloudflare Workers, D1, Miniflare + Vitest, zod contracts, React panel, GitHub Actions.

**Spec:** Owner request 2026-10-21: LeadsGate confirmed a postback URL can be global, the same value for every site. V1 (`fusion_formv_v1` @ 8404ec2) and `spike/core-worker/src/index.ts:123` already used one `POSTBACK_TOKEN`, so this restores V1 behavior (hard rule 1).

## Global Constraints

- Buyer handoff stays LeadsGate prepop redirect only. No server-side post to LeadsGate.
- No secrets in git. `POSTBACK_TOKEN` exists only as a GitHub environment secret and a core Worker secret.
- Tenants stay isolated. aduplift core and maimax core each have their own `POSTBACK_TOKEN`. The aduplift job reads `secrets.POSTBACK_TOKEN` (environment `aduplift`). The maimax job reads `secrets.MAIMAX_POSTBACK_TOKEN` (environment `maimax`).
- A global token shorter than 32 characters after trimming counts as unset.
- Postback and drain routes exist only on core (ADR-0002 decision 6). The brand Worker does not change.
- `bun run typecheck` and `bun run test` green before the PR.

## Review Focus

1. A global secret that is empty, whitespace or short must never authorize a request. Task 1 tests `""`, `"   "` and a 31-character value.
2. A brand B per-brand token must still be rejected for a brand A lead while the global token is configured. Task 1 keeps the existing isolation test and adds one with the global binding.
3. An unknown `cid` with the global token returns `ignored` and writes nothing. Task 1 tests it.
4. A deploy whose `POSTBACK_TOKEN` GitHub secret is empty must not overwrite the core secret with an empty string. Task 2 asserts a skip guard.
5. The panel must not show "not set" for a brand that the global token covers. Task 3 tests the `global` state.

## File Structure

- Create `workers/core/src/postback-token.ts`: one function, `globalPostbackDigest(env)`, used by the postback route and the admin API.
- Modify `workers/core/src/env.ts`: add `POSTBACK_TOKEN?: string`.
- Modify `workers/core/src/postback.ts`: accept the global digest.
- Modify `workers/core/src/admin/index.ts`: report `postback_token: "global"`.
- Modify `packages/contracts/src/admin-api.ts`: `PostbackTokenState` gains `"global"`.
- Modify `apps/web/src/client/screens/ConfigPanel.tsx`: label for `global`.
- Modify `.github/workflows/deploy.yml`: put `POSTBACK_TOKEN` in both tenant jobs.
- Modify `docs/adr/0002-leadsgate-prepop-and-postback.md`: record the decision.
- Modify `apps/web/src/server/lifecycle.ts`: computed `leadsgate_postbacks` checklist row (Task 5).
- Tests: `workers/core/test/postback-global.test.ts` (new), `workers/core/test/admin.test.ts`, `scripts/test/postback-deploy.test.ts` (new), `apps/web/test/config-panel-postback.ui.test.tsx` (new), `apps/web/test/lifecycle-api.test.ts`.

---

### Task 1: Core accepts the tenant-wide postback token

**Files:**
- Create: `workers/core/src/postback-token.ts`
- Modify: `workers/core/src/env.ts`, `workers/core/src/postback.ts:14-41`
- Test: `workers/core/test/postback-global.test.ts`

**Interfaces:**
- Produces: `globalPostbackDigest(env: Env): Promise<string | null>` (hex SHA-256 of the trimmed secret, or null when unset or shorter than 32 characters). `MIN_GLOBAL_POSTBACK_TOKEN_LENGTH = 32`.

- [ ] **Step 1: Write the failing test**

```ts
// workers/core/test/postback-global.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

const GLOBAL = "g".repeat(40);
const path = (token: string, cid = "abc123") => `/api/postback?token=${token}&cid=${cid}&type=soldLead&payout=25`;

describe("tenant-wide postback token", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness({ bindings: { POSTBACK_TOKEN: GLOBAL } }); });
  beforeEach(async () => { await h.reset(); await h.seedBrand("brand-a", "T"); await h.seedLead(); });
  afterAll(async () => { await h?.mf.dispose(); });

  it("accepts the global token for a brand that has no per-brand token", async () => {
    await h.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL").run();
    const response = await h.request(path(GLOBAL));
    expect(await response.json()).toEqual({ status: "accepted", lead_id: "lead-1" });
    expect(await h.db.prepare("SELECT count(*) AS n FROM conversion_uploads").first()).toEqual({ n: 1 });
  });

  it("keeps the per-brand token working beside the global one", async () => {
    expect((await h.request(path("T"))).status).toBe(200);
  });

  it("still rejects another brand's token for this brand's lead", async () => {
    await h.seedBrand("brand-b", "U", "account-b");
    expect((await h.request(path("U"))).status).toBe(401);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
  });

  it("authenticates an unknown cid with the global token and writes nothing", async () => {
    const response = await h.request(path(GLOBAL, "unknown"));
    expect(await response.json()).toEqual({ status: "ignored", reason: "unknown_click" });
    expect((await h.request(path("wrong", "unknown"))).status).toBe(401);
    expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 });
  });

  it("accepts the global token from the Authorization header like V1", async () => {
    const response = await h.request("/api/postback?cid=abc123&type=soldLead&payout=25", {
      headers: { Authorization: `Bearer ${GLOBAL}` },
    });
    expect(response.status).toBe(200);
  });
});

describe.each([["empty", ""], ["whitespace", "   "], ["31 characters", "s".repeat(31)]])(
  "a %s global secret counts as unset", (_label, secret) => {
    let h: Harness;
    beforeAll(async () => { h = await createHarness({ bindings: { POSTBACK_TOKEN: secret } }); });
    beforeEach(async () => { await h.reset(); await h.seedBrand("brand-a", "T"); await h.seedLead(); });
    afterEach(async () => { expect(await h.db.prepare("SELECT count(*) AS n FROM postback_events").first()).toEqual({ n: 0 }); });
    afterAll(async () => { await h?.mf.dispose(); });

    it("rejects the secret value itself", async () => {
      await h.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL").run();
      expect((await h.request(path(encodeURIComponent(secret)))).status).toBe(401);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @anjuna/core test -- postback-global`
Expected: FAIL. "accepts the global token for a brand that has no per-brand token" gets 401.

- [ ] **Step 3: Write minimal implementation**

```ts
// workers/core/src/postback-token.ts
import { sha256 } from "./auth.js";
import type { Env } from "./env.js";

/** LeadsGate global postback: one secret per tenant core (V1 parity). Short or blank secrets count as unset. */
export const MIN_GLOBAL_POSTBACK_TOKEN_LENGTH = 32;

export async function globalPostbackDigest(env: Env): Promise<string | null> {
  const value = env.POSTBACK_TOKEN?.trim() ?? "";
  return value.length >= MIN_GLOBAL_POSTBACK_TOKEN_LENGTH ? sha256(value) : null;
}
```

In `workers/core/src/env.ts`, after `DRAIN_TOKEN?: string;`:

```ts
  /** Tenant-wide LeadsGate postback token (Worker secret). Accepted for every brand of this core. */
  POSTBACK_TOKEN?: string;
```

In `workers/core/src/postback.ts`, import `globalPostbackDigest` and replace the authorization block (lines 20-41):

```ts
  const digest = await sha256(token);
  const globalDigest = await globalPostbackDigest(env);
  const isGlobal = globalDigest !== null && hashesEqual(digest, globalDigest);
  // leads.brand is the trusted brand_id stored by core (T6c); buyer lead_id is never a join key.
  const lead = await env.LEADS.prepare(`
    SELECT l.lead_id, l.tracking_json, b.postback_token_hash
    FROM leads l LEFT JOIN brand_runtime b ON b.brand_id = l.brand
    WHERE l.click_id = ?1 LIMIT 1
  `).bind(v1Clean(query.cid, 128)).first<PostbackLead>();

  if (lead) {
    if (!isGlobal && !hashesEqual(digest, lead.postback_token_hash)) return unauthorized();
  } else if (!isGlobal) {
    // V1 authenticates even malformed/unmatched callbacks before returning 400/ignored.
    // With no lead to identify a brand, require a configured brand token, but never write.
    const { results } = await env.LEADS.prepare(
      "SELECT postback_token_hash FROM brand_runtime WHERE postback_token_hash IS NOT NULL",
    ).all<{ postback_token_hash: string }>();
    let authorized = false;
    for (const row of results) {
      if (hashesEqual(digest, row.postback_token_hash)) authorized = true;
    }
    if (!authorized) return unauthorized();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --filter @anjuna/core test`
Expected: PASS, including the unchanged `core.test.ts` postback goldens and isolation tests.

- [ ] **Step 5: Commit**

```bash
git add workers/core/src/postback-token.ts workers/core/src/env.ts workers/core/src/postback.ts workers/core/test/postback-global.test.ts
git commit -m "feat(core): accept a tenant-wide LeadsGate postback token (V1 parity)"
```

### Task 2: Deploy puts POSTBACK_TOKEN on each tenant core

**Files:**
- Modify: `.github/workflows/deploy.yml` (steps "Set core secrets (aduplift)" and "Set core secrets (maimax)")
- Test: `scripts/test/postback-deploy.test.ts`

**Interfaces:**
- Consumes: Worker secret name `POSTBACK_TOKEN` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test/postback-deploy.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
type Step = { name?: string; run?: string; env?: Record<string, string> };

describe("global postback token deploy", () => {
  const workflow = parseDocument(readFileSync(new URL(".github/workflows/deploy.yml", root), "utf8")).toJS() as {
    jobs: Record<string, { steps: Step[] }>;
  };
  it.each([
    ["aduplift", "POSTBACK_TOKEN", "workers/core/wrangler.deploy.aduplift.jsonc"],
    ["maimax", "MAIMAX_POSTBACK_TOKEN", "workers/core/wrangler.deploy.maimax.jsonc"],
  ])("%s sets POSTBACK_TOKEN from its own secret and skips when empty", (tenant, secret, config) => {
    const step = workflow.jobs[`deploy-${tenant}`]!.steps.find((s) => s.name === `Set postback token (${tenant})`);
    expect(step, tenant).toBeDefined();
    expect(step!.env).toEqual({ POSTBACK_TOKEN: `\${{ secrets.${secret} }}` });
    expect(step!.run).toContain('[ -z "$POSTBACK_TOKEN" ] && echo "');
    expect(step!.run).toContain(`printf '%s' "$POSTBACK_TOKEN" | bun x wrangler secret put POSTBACK_TOKEN --config ${config}`);
    const names = workflow.jobs[`deploy-${tenant}`]!.steps.map((s) => s.name);
    expect(names.indexOf(`Set postback token (${tenant})`)).toBeLessThan(names.indexOf(`Smoke test core (${tenant})`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @anjuna/scripts test -- postback-deploy`
Expected: FAIL, step "Set postback token (aduplift)" is undefined.

- [ ] **Step 3: Write minimal implementation**

In `deploy.yml`, right after "Set core secrets (aduplift)":

```yaml
      - name: Set postback token (aduplift)
        env:
          POSTBACK_TOKEN: ${{ secrets.POSTBACK_TOKEN }}
        run: |
          [ -z "$POSTBACK_TOKEN" ] && echo "POSTBACK_TOKEN not set, keeping the current core secret" && exit 0
          printf '%s' "$POSTBACK_TOKEN" | bun x wrangler secret put POSTBACK_TOKEN --config workers/core/wrangler.deploy.aduplift.jsonc
```

Right after "Set core secrets (maimax)":

```yaml
      - name: Set postback token (maimax)
        env:
          POSTBACK_TOKEN: ${{ secrets.MAIMAX_POSTBACK_TOKEN }}
        run: |
          [ -z "$POSTBACK_TOKEN" ] && echo "MAIMAX_POSTBACK_TOKEN not set, keeping the current core secret" && exit 0
          printf '%s' "$POSTBACK_TOKEN" | bun x wrangler secret put POSTBACK_TOKEN --config workers/core/wrangler.deploy.maimax.jsonc
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --filter @anjuna/scripts test`
Expected: PASS, including `template-mcp-deploy.test.ts` step-order assertions.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml scripts/test/postback-deploy.test.ts
git commit -m "ci(deploy): set the tenant postback token on each core"
```

### Task 3: Panel shows the global postback state

**Files:**
- Modify: `packages/contracts/src/admin-api.ts:127`, `workers/core/src/admin/index.ts:208-230` and `:295`, `:321`, `:356`, `:442`, `apps/web/src/client/screens/ConfigPanel.tsx:218`, `apps/web/src/server/mock-core.ts:59`
- Test: `workers/core/test/admin.test.ts`, `apps/web/test/config-panel-postback.ui.test.tsx`

**Interfaces:**
- Consumes: `globalPostbackDigest(env)` from Task 1.
- Produces: `PostbackTokenState = "set" | "not_set" | "global"`. `"set"` = the brand has its own token. `"global"` = no own token, tenant token configured. `"not_set"` = neither.

- [ ] **Step 1: Write the failing tests**

Append to `workers/core/test/admin.test.ts`:

```ts
describe("postback token state with a tenant-wide token", () => {
  let g: Harness;
  beforeAll(async () => {
    g = await createHarness({ bindings: { POSTBACK_TOKEN: "g".repeat(40) } });
    await g.seedBrand("brand-a", "own", "main");
    await g.seedBrand("brand-c", "unused", "main");
    await g.db.prepare("UPDATE brand_runtime SET postback_token_hash = NULL WHERE brand_id = 'brand-c'").run();
  });
  afterAll(async () => { await g?.mf.dispose(); });

  it("reports global for a brand without its own token and set for one with it", async () => {
    const own = GetBrandResponse.parse(await (await g.admin("/admin/brands/brand-a", owner)).json());
    const covered = GetBrandResponse.parse(await (await g.admin("/admin/brands/brand-c", owner)).json());
    expect([own.brand.postback_token, covered.brand.postback_token]).toEqual(["set", "global"]);
    expect(JSON.stringify(covered)).not.toContain("g".repeat(40));
  });
});
```

Create `apps/web/test/config-panel-postback.ui.test.tsx` following the render helper used in `apps/web/test/builder-keys.ui.test.tsx`. Assert that a brand fixture with `postback_token: "global"` renders the text `ใช้ postback กลาง (global)` and does not render `ยังไม่ได้ตั้งค่า`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --filter @anjuna/core test -- admin` and `bun run --filter @anjuna/web test -- config-panel-postback`
Expected: FAIL. Core returns `not_set` for brand-c. zod rejects `"global"`.

- [ ] **Step 3: Write minimal implementation**

`packages/contracts/src/admin-api.ts:127`:

```ts
export const PostbackTokenState = z.enum(["set", "not_set", "global"]);
```

`workers/core/src/admin/index.ts`: change the signature and the field, then pass the flag from every caller.

```ts
function brandConfig(row: BrandRow, globalPostback = false): BrandConfig {
  // ...unchanged fields...
    postback_token: row.postback_token_hash ? "set" : globalPostback ? "global" : "not_set",
```

In `getBrand` and the PATCH handler (lines 321, 356, 442), compute once and pass it:

```ts
  const globalPostback = (await globalPostbackDigest(env)) !== null;
  return json({ brand: brandConfig(row, globalPostback) });
```

The list handler (line 295) reads only non-token fields, so it keeps `brandConfig(row)`.

`apps/web/src/client/screens/ConfigPanel.tsx:218`:

```tsx
        <span>โทเคน postback (Postback token): <b>{brand.postback_token === "set" ? "ตั้งค่าแล้ว (เฉพาะเว็บนี้)" : brand.postback_token === "global" ? "ใช้ postback กลาง (global)" : "ยังไม่ได้ตั้งค่า"}</b></span>
```

`apps/web/src/server/mock-core.ts:59`: keep `"not_set"`; the mock stays valid because the enum only grew.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun run test`
Expected: PASS on all packages. The contracts fixtures still parse because `"set"` remains valid.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/admin-api.ts workers/core/src/admin/index.ts apps/web/src/client/screens/ConfigPanel.tsx workers/core/test/admin.test.ts apps/web/test/config-panel-postback.ui.test.tsx
git commit -m "feat(panel): show when the tenant postback token covers a brand"
```

### Task 4: Record the decision

**Files:**
- Modify: `docs/adr/0002-leadsgate-prepop-and-postback.md` (decision 3 and the FA-4 consequence), `docs/runbooks/gates/README.md:33`

- [ ] **Step 1: Edit ADR-0002 decision 3**

Replace "`token` is a per-brand postback secret; a mismatch returns 401." with:

```markdown
   - `token` is the tenant postback secret (`POSTBACK_TOKEN` on that tenant's core, V1 parity, owner decision 2026-10-21). A per-brand token minted in the panel is also accepted for that brand only. Any other token returns 401.
   - LeadsGate holds one global postback entry per LeadsGate account (aid). A new brand needs no LeadsGate postback setup.
```

- [ ] **Step 2: Edit the gates README item 5**

```markdown
5. **Postback token.** Core accepts the tenant secret `POSTBACK_TOKEN` (GitHub environment secret `POSTBACK_TOKEN` or `MAIMAX_POSTBACK_TOKEN`) and any per-brand token. Only hashes of per-brand tokens are stored.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0002-leadsgate-prepop-and-postback.md docs/runbooks/gates/README.md
git commit -m "docs(adr): LeadsGate postback token is tenant-wide"
```

### Task 5: Checklist ticks `leadsgate_postbacks` for a brand the global token covers

**Files:**
- Modify: `apps/web/src/server/lifecycle.ts` (GET `/api/brands/:id/checklist`)
- Test: `apps/web/test/lifecycle-api.test.ts`

**Interfaces:**
- Consumes: `postback_token: "global"` from core `getBrand` (Task 3), through `callCore(env, ctx, { endpoint: "getBrand", params: { id } })` in `apps/web/src/server/core.ts`.

- [ ] **Step 1: Write the failing tests**

Append a `describe("checklist with the tenant postback token")` block. Each test creates a draft brand (`brand_checklist.brand_id` references `brands`) and passes `makeEnv({ MOCK_CORE: undefined, CORE: <stub> })`, where the stub answers `/admin/brands/:id` with the `brand.get.response.json` fixture and the wanted `postback_token`.
- `global`: the GET returns `drain_route`, `final_url`, `leadsgate_postbacks`, `test_sold` in that order. The computed row has `confirmed_by: "system:global-postback"` and `confirmed_role: "system"`, its evidence parses with `ChecklistEvidence`, and `brand_checklist` holds no `leadsgate_postbacks` row.
- `set` and `not_set`: no row.
- Core throws, or answers 404: no row.
- A stored `leadsgate_postbacks` attestation is returned as stored (`confirmed_role: "employee"`), with no computed duplicate.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --filter @anjuna/web test -- lifecycle-api`
Expected: FAIL. The `global` test gets no `leadsgate_postbacks` row.

- [ ] **Step 3: Write minimal implementation**

In `lifecycle.ts`, add `globalPostbackRow(env, ctx, brandId)`. It returns null for an invalid `BrandId`, a non-200 core result, any `postback_token` other than `"global"`, or a thrown error. Otherwise it returns `{ item: "leadsgate_postbacks", evidence: { brand_id, item, actor_id: "system:global-postback", verified_at: now }, confirmed_by: "system:global-postback", confirmed_role: "system", confirmed_at: now }`. The GET handler calls it only when no stored `leadsgate_postbacks` row exists, appends the result and re-sorts by `item` (binary order, like the SQL `ORDER BY item`). Nothing is written to D1. `brand_checklist.confirmed_role` allows only owner and employee, so the computed row cannot be stored as is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/lifecycle.ts apps/web/test/lifecycle-api.test.ts docs/superpowers/plans/2026-10-21-global-postback-token.md
git commit -m "feat(web): tick the LeadsGate postback checklist item for brands the tenant token covers"
```

## Rollout (owner, after merge and release)

1. Generate one token per tenant: `openssl rand -hex 32`.
2. aduplift: `gh secret set POSTBACK_TOKEN --env aduplift`. maimax: `gh secret set MAIMAX_POSTBACK_TOKEN --env maimax` (add `POSTBACK_TOKEN` to `maimax-handover/maimax-secrets.env` and a line in `04-owner-apply.sh`).
3. Release; Deploy puts the secret on both cores.
4. In each LeadsGate account, add one global postback URL: `https://core.<tenant domain>/api/postback?token=<POSTBACK_TOKEN>&cid=<cid macro>&payout=<payout macro>&lead_id=<lead id macro>&type=<status macro>`.
5. Press LeadsGate "Test sold" on one live brand. Expect a `postback_events` row and `{"status":"accepted"}`.
6. After one day of global postbacks arriving, delete the old per-brand LeadsGate entries.

## Questions for the owner before Task 4 ships

- LeadsGate macro names for cid, payout, lead id and status (`docs/runbooks/gates/README.md` item 4 is still NOT_VERIFIED).
- aduplift config uses aid `10001`, maimax uses `17244`. If both tenants share one LeadsGate account, one global URL cannot reach two cores.
- Whether the brand checklist item `leadsgate_postbacks` should disappear. Task 5 ticks it automatically for brands the global token covers and leaves it a manual tick for the rest.
