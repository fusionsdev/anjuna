import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0025 adds adkit_jobs.claim_seq and result_seq (one shared event counter) and backfills them from
// claimed_at and the final updated_at. This file applies every migration before 0025, inserts rows in each state,
// applies 0025 and checks the rows, the backfilled order, the unique key, the CHECKs and the indexes.
describe("migration 0025 on a populated adkit_jobs", () => {
  it("keeps every row, numbers claims and results in time order, and keeps the unique key, CHECKs and indexes", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0025"));
    // [id, status, claimed_at, updated_at, claim_id]
    const rows = [
      ["q-queued", "queued", null, "2026-11-08T00:00:01.000Z", null],
      ["c-claimed", "claimed", "2026-11-08T00:00:05.000Z", "2026-11-08T00:00:05.000Z", "claim-c"],
      ["d-done", "done", "2026-11-08T00:00:02.000Z", "2026-11-08T00:00:06.000Z", "claim-d"],
      ["u-unknown", "unknown", "2026-11-08T00:00:03.000Z", "2026-11-08T00:00:04.000Z", "claim-u"],
      ["f-failed", "failed", null, "2026-11-08T00:00:07.000Z", null],
      ["h-held", "held", null, "2026-11-08T00:00:08.000Z", null],
    ] as const;
    let seq = 1;
    for (const [id, status, claimedAt, updatedAt, claimId] of rows) {
      await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id,
        claimed_at, created_at, updated_at, seq)
        VALUES (?1, 'campaign.status_check', '{"campaign_id":"22000000001"}', ?2, NULL, 1, ?3, 'core', ?4, ?5, '2026-11-08T00:00:00.000Z', ?6, ?7)`)
        .bind(id, status, `key-${id}`, claimId, claimedAt, updatedAt, seq++).run();
    }
    const before = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results;

    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0026"));
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>())!.name;
    expect(applied).toBe("0025_adkit_jobs_claim_seq.sql");

    const after = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all<Record<string, unknown>>()).results;
    expect(after.map(({ claim_seq: _c, result_seq: _r, ...rest }) => rest)).toEqual(before);
    // Events by time: d claim 02, u claim 03, u result 04, c claim 05, d result 06, f result 07.
    const seqs = Object.fromEntries((await env.DB.prepare("SELECT id, claim_seq, result_seq FROM adkit_jobs").all<{ id: string; claim_seq: number | null; result_seq: number | null }>())
      .results.map((r) => [r.id, [r.claim_seq, r.result_seq]]));
    expect(seqs).toEqual({
      "q-queued": [null, null], "h-held": [null, null],
      "d-done": [1, 5], "u-unknown": [2, 3], "c-claimed": [4, null], "f-failed": [null, 6],
    });

    const insert = (id: string, status: string, key: string) => env.DB.prepare(`INSERT INTO adkit_jobs
      (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
      VALUES (?1, 'campaign.enable', '{}', ?2, 0, ?3, 'usr', 'x', 'x', 99)`).bind(id, status, key).run();
    await expect(insert("dup", "queued", "key-d-done")).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert("bad-status", "paused", "key-bad")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("claimed-no-claim", "claimed", "key-claim")).rejects.toThrow(/CHECK constraint failed/);
    await insert("next", "queued", "key-next");
    expect(await env.DB.prepare("SELECT claim_seq, result_seq FROM adkit_jobs WHERE id = 'next'").first()).toEqual({ claim_seq: null, result_seq: null });
    const next = await env.DB.prepare("SELECT MAX(COALESCE(MAX(claim_seq), 0), COALESCE(MAX(result_seq), 0)) + 1 AS n FROM adkit_jobs").first<{ n: number }>();
    expect(next!.n).toBe(7);

    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adkit_jobs' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(["idx_adkit_jobs_campaign", "idx_adkit_jobs_claim_seq", "idx_adkit_jobs_result_seq", "idx_adkit_jobs_seq", "idx_adkit_jobs_status"]);
  });
});
