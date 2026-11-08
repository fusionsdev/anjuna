import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0024 adds adkit_jobs.seq (insert order) and backfills it. This file applies every migration before 0024,
// inserts rows whose created_at and id order differ from their insert order, applies 0024 and checks the rows, the
// backfill, the unique key, the CHECKs and the indexes.
describe("migration 0024 on a populated adkit_jobs", () => {
  it("keeps every row, numbers seq 1..n in insert order, and keeps the unique key, CHECKs and indexes", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0024"));
    // Insert order: z-held, a-done, m-queued, b-unknown. created_at runs the other way for the first two.
    const rows = [
      ["z-held", "campaign.enable", "held", null, "2026-11-08T00:00:09.000Z"],
      ["a-done", "conversion_action.create", "done", '{"conversion_action_id":"7300000001","name":"cv-0123456789abcdef","adopted":false}', "2026-11-08T00:00:01.000Z"],
      ["m-queued", "campaign.status_check", "queued", null, "2026-11-08T00:00:05.000Z"],
      ["b-unknown", "campaign.update_budget", "unknown", '{"error":"claim lease expired on the last attempt"}', "2026-11-08T00:00:05.000Z"],
    ] as const;
    for (const [id, kind, status, result, at] of rows) {
      await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, created_at, updated_at)
        VALUES (?1, ?2, '{"campaign_id":"22000000001"}', ?3, ?4, 1, ?5, 'usr_owner_01', ?6, ?6)`).bind(id, kind, status, result, `key-${id}`, at).run();
    }
    const before = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results;

    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0025"));
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>())!.name;
    expect(applied).toBe("0024_adkit_jobs_seq.sql");

    const after = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all<Record<string, unknown>>()).results;
    expect(after.map(({ seq: _seq, ...rest }) => rest)).toEqual(before);
    const bySeq = (await env.DB.prepare("SELECT id, seq FROM adkit_jobs ORDER BY seq").all<{ id: string; seq: number }>()).results;
    expect(bySeq).toEqual([{ id: "z-held", seq: 1 }, { id: "a-done", seq: 2 }, { id: "m-queued", seq: 3 }, { id: "b-unknown", seq: 4 }]);

    const insert = (id: string, status: string, key: string, seq: string) => env.DB.prepare(`INSERT INTO adkit_jobs
      (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
      VALUES (?1, 'campaign.enable', '{}', ?2, 0, ?3, 'usr', 'x', 'x', ${seq})`).bind(id, status, key).run();
    await expect(insert("dup", "queued", "key-a-done", "5")).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert("bad-status", "paused", "key-bad", "5")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("claimed-no-claim", "claimed", "key-claim", "5")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("null-seq", "queued", "key-null", "NULL")).rejects.toThrow(/NOT NULL constraint failed/);
    await insert("next", "queued", "key-next", "(SELECT COALESCE(MAX(seq), 0) + 1 FROM adkit_jobs)");
    expect((await env.DB.prepare("SELECT seq FROM adkit_jobs WHERE id = 'next'").first<{ seq: number }>())!.seq).toBe(5);
    await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at)
      VALUES ('old-core', 'campaign.enable', '{}', 'queued', 0, 'key-old', 'usr', 'x', 'x')`).run();
    expect((await env.DB.prepare("SELECT seq FROM adkit_jobs WHERE id = 'old-core'").first<{ seq: number }>())!.seq).toBe(0);

    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adkit_jobs' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(["idx_adkit_jobs_campaign", "idx_adkit_jobs_seq", "idx_adkit_jobs_status"]);
  });
});
