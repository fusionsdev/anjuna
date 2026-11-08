import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// scripts/drain/README.md "Deploy 0025" step 4 documents the count, list and repair statements. This file reads them
// from the README (between the `<!-- sql:name -->` markers), fills a table with every row form the old core can leave
// during the deploy gap, runs the repair exactly as documented and asserts the count reaches 0 and stays 0 on a rerun.
function readmeSql(name: string): string {
  const match = new RegExp(`<!-- sql:${name} -->\\s*\`\`\`sql\\s*([\\s\\S]*?)\`\`\``).exec(env.DRAIN_README);
  if (!match) throw new Error(`README has no sql:${name} block`);
  return match[1]!.trim();
}
const withId = (sql: string, id: string) => sql.replaceAll("'<id>'", `'${id.replaceAll("'", "''")}'`);

describe("Deploy 0025 step 4 repair statements (from scripts/drain/README.md)", () => {
  it("bring every old-core form to count 0 and are safe to run twice", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    // [id, kind, status, claimed_at, claim_seq, result_seq, claim_id]; times increase with the id letter.
    const rows: Array<[string, string, string, string | null, number | null, number | null, string | null]> = [
      // Rows the new core numbered (and backfilled rows): never match.
      ["a-done-enable", "campaign.enable", "done", "2026-11-08T00:00:01.000Z", 1, 2, "c-a"],
      ["b-queued", "campaign.pause", "queued", null, null, null, null],
      // Old-core forms.
      ["c-check-claimed", "campaign.status_check", "claimed", "2026-11-08T00:00:03.000Z", null, null, "c-c"],
      ["d-check-done-both-null", "campaign.status_check", "done", "2026-11-08T00:00:04.000Z", null, null, "c-d"],
      ["e-check-done-result-set", "campaign.status_check", "done", "2026-11-08T00:00:05.000Z", null, 7, "c-e"],
      ["f-enable-done-both-null", "campaign.enable", "done", "2026-11-08T00:00:06.000Z", null, null, "c-f"],
      ["g-budget-unknown-result-null", "campaign.update_budget", "unknown", "2026-11-08T00:00:07.000Z", 3, null, "c-g"],
      ["h-enable-claimed-claim-null", "campaign.enable", "claimed", "2026-11-08T00:00:08.000Z", null, null, "c-h"],
      ["i-failed-result-null", "campaign.pause", "failed", null, null, null, null],
    ];
    let seq = 1;
    for (const [id, kind, status, claimedAt, claimSeq, resultSeq, claimId] of rows) {
      const result = status === "done" && kind === "campaign.status_check"
        ? '{"campaign_id":"22000000001","observed_status":"ENABLED","daily_budget":1000}' : null;
      const at = claimedAt ?? `2026-11-08T00:00:0${seq}.500Z`;
      await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id,
        claimed_at, created_at, updated_at, seq, claim_seq, result_seq)
        VALUES (?1, ?2, '{"campaign_id":"22000000001"}', ?3, ?4, 1, ?5, 'usr', ?6, ?7, ?8, ?8, ?9, ?10, ?11)`)
        .bind(id, kind, status, result, `key-${id}`, claimId, claimedAt, at, seq++, claimSeq, resultSeq).run();
    }
    const count = async () => (await env.DB.prepare(readmeSql("count")).first<{ n: number }>())!.n;
    expect(await count()).toBe(7);

    const repair = async () => {
      const { results } = await env.DB.prepare(readmeSql("list")).all<{ id: string; kind: string }>();
      for (const row of results) {
        if (row.kind === "campaign.status_check") {
          await env.DB.prepare(withId(readmeSql("discard-check"), row.id)).run();
        } else {
          await env.DB.prepare(withId(readmeSql("number-claim"), row.id)).run();
          await env.DB.prepare(withId(readmeSql("number-result"), row.id)).run();
        }
      }
      return results.map((r) => r.id);
    };
    expect(await repair()).toEqual(["c-check-claimed", "d-check-done-both-null", "e-check-done-result-set",
      "f-enable-done-both-null", "g-budget-unknown-result-null", "h-enable-claimed-claim-null", "i-failed-result-null"]);
    expect(await count()).toBe(0);

    const snapshot = async () => (await env.DB.prepare("SELECT id, status, claimed_at, claim_seq, result_seq FROM adkit_jobs ORDER BY id").all()).results;
    const after = await snapshot();
    // Rerun every repair statement on every row: nothing changes and the count stays 0.
    for (const [id] of rows) {
      for (const name of ["discard-check", "number-claim", "number-result"]) await env.DB.prepare(withId(readmeSql(name), id)).run();
    }
    expect(await repair()).toEqual([]);
    expect(await count()).toBe(0);
    // A rerun of discard-check on a non-check row and of number-* on a numbered row is a no-op.
    expect(await snapshot()).toEqual(after);

    const byId = Object.fromEntries((after as Array<{ id: string; status: string; claimed_at: string | null; claim_seq: number | null; result_seq: number | null }>)
      .map((r) => [r.id, r]));
    // Status checks are discarded and never numbered as claims; an existing result_seq is kept.
    for (const id of ["c-check-claimed", "d-check-done-both-null", "e-check-done-result-set"]) {
      expect(byId[id]).toMatchObject({ status: "failed", claimed_at: null, claim_seq: null });
    }
    expect(byId["e-check-done-result-set"]!.result_seq).toBe(7);
    // Other rows get numbers above every earlier value, a row's claim before its result.
    expect(byId["f-enable-done-both-null"]!.claim_seq!).toBeLessThan(byId["f-enable-done-both-null"]!.result_seq!);
    expect(byId["f-enable-done-both-null"]!.claim_seq!).toBeGreaterThan(7);
    expect(byId["a-done-enable"]).toMatchObject({ claim_seq: 1, result_seq: 2 });
  });
});
