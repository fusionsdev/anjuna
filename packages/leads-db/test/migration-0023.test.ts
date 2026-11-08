import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0023 rebuilds adkit_jobs to widen two CHECKs. This file applies every migration before 0023, fills the
// old table with rows in each state, then applies 0023 and checks that rows, the unique key and the indexes survive.
describe("migration 0023 on a populated adkit_jobs", () => {
  it("keeps queued, claimed, done and failed rows byte for byte, the unique key and both indexes", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0023"));
    const rows = [
      ["j-queued", "queued", null, null, null, 0, null],
      ["j-claimed", "claimed", null, "claim-1", "2026-11-01T00:00:00.000Z", 1, null],
      ["j-done", "done", '{"conversion_action_id":"7300000001","name":"cv-0123456789abcdef","adopted":false}', "claim-2", "2026-11-01T00:00:00.000Z", 1, null],
      ["j-failed", "failed", '{"error":"rate limited"}', "claim-3", "2026-11-01T00:00:00.000Z", 5, null],
      ["j-retry", "queued", '{"error":"timeout"}', null, null, 2, "2026-11-02T00:00:00.000Z"],
    ] as const;
    await env.DB.batch(rows.map(([id, status, result, claimId, claimedAt, attempts, next]) => env.DB.prepare(`
      INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id, claimed_at,
        next_attempt_at, created_at, updated_at)
      VALUES (?1, 'conversion_action.create', '{"brand_draft_id":"b","account":"4811219623","project":null,"name":"cv-0123456789abcdef"}',
        ?2, ?3, ?4, ?5, 'usr_owner_01', ?6, ?7, ?8, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:01.000Z')`)
      .bind(id, status, result, attempts, `key-${id}`, claimId, claimedAt, next)));
    const before = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results;

    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0024"));
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>())!.name;
    expect(applied).toBe("0023_adkit_campaign_jobs.sql");

    expect((await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results).toEqual(before);
    await expect(env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at)
      VALUES ('j-dup', 'campaign.enable', '{}', 'queued', 0, 'key-j-done', 'usr', 'x', 'x')`).run()).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at)
      VALUES ('j-claim', 'campaign.enable', '{}', 'claimed', 0, 'key-claim', 'usr', 'x', 'x')`).run()).rejects.toThrow(/CHECK constraint failed/);
    await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at)
      VALUES ('j-held', 'campaign.enable', '{}', 'held', 0, 'key-held', 'usr', 'x', 'x')`).run();

    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adkit_jobs' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(["idx_adkit_jobs_campaign", "idx_adkit_jobs_status"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'adkit_jobs_0023'").first<{ n: number }>())!.n).toBe(0);
  });
});
