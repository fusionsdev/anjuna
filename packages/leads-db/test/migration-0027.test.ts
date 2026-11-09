import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0027 rebuilds adkit_jobs so the kind CHECK accepts 'terminal.run' (T13-6). This file applies every
// migration before 0027, inserts rows in several kinds and states, applies 0027 and checks that every column of
// every row is unchanged, the new kind is accepted, an unknown kind and the other CHECKs still refuse, the unique key
// holds and the five indexes are back.
describe("migration 0027 on a populated adkit_jobs", () => {
  it("keeps every row and column, accepts terminal.run, and keeps the CHECKs, the unique key and the indexes", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS.filter((m) => m.name < "0027"));
    const rows = [
      ["a-conv", "conversion_action.create", "done", null, null, null],
      ["b-enable", "campaign.enable", "unknown", "claim-b", "2026-11-08T00:00:03.000Z", 4],
      ["c-draft", "campaign.draft.create", "held", null, null, null],
      ["d-check", "campaign.status_check", "claimed", "claim-d", "2026-11-08T00:00:05.000Z", null],
    ] as const;
    let seq = 1;
    for (const [id, kind, status, claimId, claimedAt, resultSeq] of rows) {
      await env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, result, attempts, idempotency_key, requested_by, claim_id,
        claimed_at, next_attempt_at, created_at, updated_at, seq, claim_seq, result_seq)
        VALUES (?1, ?2, '{"campaign_id":"22000000001"}', ?3, NULL, 2, ?4, 'usr', ?5, ?6, NULL, '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:06.000Z', ?7, ?8, ?9)`)
        .bind(id, kind, status, `key-${id}`, claimId, claimedAt, seq, seq === 4 ? 9 : null, resultSeq).run();
      seq++;
    }
    const before = (await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results;

    await applyD1Migrations(env.DB, env.MIGRATIONS);
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations WHERE name LIKE '0027%'").first<{ name: string }>())!.name;
    expect(applied).toBe("0027_adkit_terminal_jobs.sql");
    expect((await env.DB.prepare("SELECT * FROM adkit_jobs ORDER BY id").all()).results).toEqual(before);

    const insert = (id: string, kind: string, status: string, key: string) => env.DB.prepare(`INSERT INTO adkit_jobs
      (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at, seq)
      VALUES (?1, ?2, '{}', ?3, 0, ?4, 'usr', 'x', 'x', 99)`).bind(id, kind, status, key).run();
    await insert("term", "terminal.run", "queued", "terminal:1");
    await expect(insert("shell", "shell.run", "queued", "key-shell")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("bad-status", "terminal.run", "paused", "key-bad")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("claimed-no-claim", "terminal.run", "claimed", "key-claim")).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("dup", "terminal.run", "queued", "terminal:1")).rejects.toThrow(/UNIQUE constraint failed/);

    const indexes = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adkit_jobs' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>()).results.map((r) => r.name);
    expect(indexes).toEqual(["idx_adkit_jobs_campaign", "idx_adkit_jobs_claim_seq", "idx_adkit_jobs_result_seq", "idx_adkit_jobs_seq", "idx_adkit_jobs_status"]);
  });
});
