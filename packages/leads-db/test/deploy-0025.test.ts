import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// scripts/drain/README.md "Deploy 0025" step 4 is a gate: a count that must be 0 before the adkit executor starts
// again. There is no SQL repair. This file reads the gate query from the README (between the `<!-- sql:count -->`
// marker and its code fence) and checks that it counts each row form the old core can leave during the deploy gap,
// and returns 0 for a table the new core wrote.
function gateSql(): string {
  const match = /<!-- sql:count -->\s*```sql\s*([\s\S]*?)```/.exec(env.DRAIN_README);
  if (!match) throw new Error("README has no sql:count block");
  return match[1]!.trim();
}
const count = async () => (await env.DB.prepare(gateSql()).first<{ n: number }>())!.n;

type Row = [id: string, kind: string, status: string, claimedAt: string | null, claimSeq: number | null, resultSeq: number | null];
let seq = 0;
async function insert([id, kind, status, claimedAt, claimSeq, resultSeq]: Row) {
  const result = status === "done" && kind === "campaign.status_check"
    ? '{"campaign_id":"22000000001","observed_status":"ENABLED","daily_budget":2500}' : null;
  await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id,
    claimed_at, created_at, updated_at, seq, claim_seq, result_seq)
    VALUES (?1, ?2, '{"campaign_id":"22000000001"}', ?3, ?4, 1, ?5, 'usr', ?6, ?7, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:01.000Z', ?8, ?9, ?10)`)
    .bind(id, kind, status, result, `key-${id}`, claimedAt ? `claim-${id}` : null, claimedAt, ++seq, claimSeq, resultSeq).run();
}

describe("Deploy 0025 step 4 gate query (from scripts/drain/README.md)", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await env.DB.prepare("DELETE FROM adkit_jobs").run();
  });

  const at = "2026-11-08T00:00:01.000Z";
  it.each<[string, Row, number]>([
    ["a status check the old core claimed (both NULL)", ["c1", "campaign.status_check", "claimed", at, null, null], 1],
    ["a done status check with both NULL", ["c2", "campaign.status_check", "done", at, null, null], 1],
    ["a done status check with result_seq set and claim_seq NULL", ["c3", "campaign.status_check", "done", at, null, 7], 1],
    ["a done enable with a NULL result_seq", ["c4", "campaign.enable", "done", at, 3, null], 1],
    ["a done enable with both NULL", ["c5", "campaign.enable", "done", at, null, null], 1],
    ["a held job refused on its recheck, with result_seq set", ["c6", "campaign.enable", "failed", null, null, 9], 0],
  ])("%s counts %i", async (_label, row, expected) => {
    await insert(row);
    expect(await count()).toBe(expected);
  });

  it("returns 0 for a populated table the new core wrote (every claim and final result numbered)", async () => {
    const rows: Row[] = [
      ["n1", "campaign.draft.create", "done", at, 1, 2],
      ["n2", "campaign.enable", "done", at, 3, 4],
      ["n3", "campaign.status_check", "done", at, 5, 6],
      ["n4", "campaign.pause", "queued", null, null, null],
      ["n5", "campaign.enable", "held", null, null, null],
      ["n6", "campaign.update_budget", "claimed", at, 7, null],
      ["n7", "campaign.update_budget", "unknown", at, 8, 9],
      ["n8", "campaign.enable", "failed", null, null, 10],
      ["n9", "conversion_action.create", "failed", at, 11, 12],
    ];
    for (const row of rows) await insert(row);
    expect(await count()).toBe(0);
  });
});
