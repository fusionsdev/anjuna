import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CHECKLIST_ITEMS, FACTORY_DB_MIGRATIONS, INSTALL_STEPS } from "../src/index";

const NOW = "2026-10-02T00:00:00.000Z";

async function userTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();

async function seed() {
  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t1', 'Harbor', 'astro', 'u1', ?1)")
      .bind(NOW),
    env.DB
      .prepare(
        `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, created_by, created_at)
         VALUES ('tv1', 't1', 1, ?1, 'templates/t1/1.tar', 'u1', ?2)`,
      )
      .bind("b".repeat(64), NOW),
    env.DB
      .prepare(
        "INSERT INTO form_artifacts (form_artifact_id, git_sha, r2_key, bundle_form_version, manifest_sha256, created_at) VALUES ('f1', 'abc1234', 'form@abc1234', 'form@8ba11d3', ?1, ?2)",
      )
      .bind("c".repeat(64), NOW),
    env.DB
      .prepare(
        `INSERT INTO brands (brand_id, name, account, domain, created_by, created_at, updated_at)
         VALUES ('b1', 'Brand A', 'owner', 'brand-a.test', 'u1', ?1, ?1)`,
      )
      .bind(NOW),
    env.DB
      .prepare(
        `INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
         VALUES ('r1', 'b1', 1, 'tv1', 'f1', '{}', 'u1', ?1)`,
      )
      .bind(NOW),
    env.DB
      .prepare(
        `INSERT INTO installs (install_id, brand_id, kind, to_revision_id, started_by, started_at)
         VALUES ('i1', 'b1', 'install', 'r1', 'u1', ?1)`,
      )
      .bind(NOW),
  ]);
}

describe("factory-db migrations", () => {
  it("apply cleanly to an empty D1", async () => {
    expect(await userTables(env.DB)).toEqual([]);
    await applyD1Migrations(env.DB, env.MIGRATIONS);

    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...FACTORY_DB_MIGRATIONS]);
    expect(await userTables(env.DB)).toEqual(
      [
        "audit_log",
        "brand_revisions",
        "brands",
        "builder_key_usage",
        "builder_keys",
        "certifications",
        "form_artifacts",
        "install_receipts",
        "installs",
        "template_versions",
        "template_fingerprints",
        "templates",
        "brand_checklist",
      ].sort(),
    );
  });

  it("re-applying is a no-op", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });
});

describe("factory-db constraints", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await seed();
  });

  it("enforces foreign keys", async () => {
    await expect(
      run(
        `INSERT INTO brand_revisions (revision_id, brand_id, revision, template_version_id, form_artifact_id, config_json, created_by, created_at)
         VALUES ('r9', 'missing', 1, 'tv1', 'f1', '{}', 'u1', ?1)`,
        NOW,
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("records one receipt per install step (idempotent re-runs)", async () => {
    for (const step of INSTALL_STEPS) {
      await run("INSERT INTO install_receipts (install_id, step, status, created_at) VALUES ('i1', ?1, 'ok', ?2)", step, NOW);
    }
    await expect(
      run("INSERT INTO install_receipts (install_id, step, status, created_at) VALUES ('i1', 'deploy', 'ok', ?1)", NOW),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      run("INSERT INTO install_receipts (install_id, step, status, created_at) VALUES ('i1', 'publish', 'ok', ?1)", NOW),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("accepts lifecycle receipt steps and preserves rebuilt receipt rows", async () => {
    const rows = await env.DB
      .prepare("SELECT step, status FROM install_receipts WHERE install_id = 'i1' ORDER BY id")
      .all();
    expect(rows.results).toHaveLength(INSTALL_STEPS.length);
    expect(rows.results.map((row) => row.step)).toContain("provision_runtime");
    expect(rows.results.map((row) => row.step)).toContain("sync_runtime");
    await expect(
      run("INSERT INTO install_receipts (install_id, step, status, created_at) VALUES ('i1', 'unknown', 'ok', ?1)", NOW),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("stores separately registered form version metadata and makes both metadata fields immutable", async () => {
    await run(
      "INSERT INTO form_artifacts (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at) VALUES ('missing-version', 'missing1', 'forms/form@r2-key', ?1, ?2)",
      "e".repeat(64), NOW,
    );
    const unregistered = await env.DB.prepare("SELECT bundle_form_version FROM form_artifacts WHERE form_artifact_id = 'missing-version'").first();
    expect(unregistered).toEqual({ bundle_form_version: null });

    await run("UPDATE form_artifacts SET payload_version = '2026-01' WHERE form_artifact_id = 'f1'");
    await expect(
      run("UPDATE form_artifacts SET payload_version = '2026-02' WHERE form_artifact_id = 'f1'"),
    ).rejects.toThrow(/payload_version is immutable/);
    await expect(
      run("UPDATE form_artifacts SET bundle_form_version = 'form@other' WHERE form_artifact_id = 'f1'"),
    ).rejects.toThrow(/bundle_form_version is immutable/);
    await run(
      "INSERT INTO form_artifacts (form_artifact_id, git_sha, r2_key, bundle_form_version, manifest_sha256, created_at) VALUES ('f2', 'def5678', 'form@def5678', 'form@def5678', ?1, ?2)",
      "d".repeat(64),
      NOW,
    );
    const row = await env.DB.prepare("SELECT payload_version FROM form_artifacts WHERE form_artifact_id = 'f2'").first();
    expect(row).toEqual({ payload_version: null });
  });

  it("stores one checklist evidence row per brand and item", async () => {
    for (const [index, item] of CHECKLIST_ITEMS.entries()) {
      await run(
        `INSERT INTO brand_checklist (brand_id, item, evidence_json, confirmed_by, confirmed_role, confirmed_at)
         VALUES ('b1', ?1, '{"confirmed":true}', 'u1', 'owner', ?2)`,
        item,
        `${NOW.slice(0, -5)}${String(index).padStart(2, "0")}.000Z`,
      );
    }
    const rows = await env.DB.prepare("SELECT item FROM brand_checklist WHERE brand_id = 'b1' ORDER BY item").all<{ item: string }>();
    expect(rows.results.map((row) => row.item).sort()).toEqual([...CHECKLIST_ITEMS].sort());
    await expect(
      run(
        `INSERT INTO brand_checklist (brand_id, item, evidence_json, confirmed_by, confirmed_role, confirmed_at)
         VALUES ('b1', 'drain_route', '{"confirmed":true}', 'u1', 'owner', ?1)`,
        NOW,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("makes a sealed template version immutable", async () => {
    await run(
      "UPDATE template_versions SET status = 'sealed', sealed_by = 'owner1', sealed_at = ?1 WHERE template_version_id = 'tv1'",
      NOW,
    );
    await expect(
      run("UPDATE template_versions SET r2_key = 'other' WHERE template_version_id = 'tv1'"),
    ).rejects.toThrow(/sealed template versions are immutable/);
  });

  it("requires sealed_at exactly when sealed", async () => {
    await expect(
      run(
        `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, created_by, created_at)
         VALUES ('tv2', 't1', 2, ?1, 'k', 'sealed', 'u1', ?2)`,
        "d".repeat(64),
        NOW,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("keeps the audit log append-only", async () => {
    await run(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json, created_at)
       VALUES ('owner1', 'owner', 'brand.pause', 'brand', 'b1', '{"paused":true}', ?1)`,
      NOW,
    );
    await expect(run("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(
      run(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, created_at)
         VALUES ('x', 'admin', 'a', 'b', 'c', ?1)`,
        NOW,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("stores a submission's text defaults and submitter on the template version", async () => {
    await run("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t-sub', 'Submitted', 'react_spa', 'bk_1', ?1)", NOW);
    await run(
      `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, created_by, created_at,
         text_defaults_json, submitted_by_key_id, submitted_by_label)
       VALUES ('tv-sub', 't-sub', 1, ?1, 'k', 'bk_1', ?2, ?3, 'bk_1', 'Somchai (bolt.new)')`,
      "e".repeat(64), NOW, JSON.stringify({ brand_name: "Harbor", title: "Harbor | Funding", description: null }),
    );
    expect(await env.DB.prepare(
      "SELECT submitted_by_label, json_extract(text_defaults_json, '$.title') AS title FROM template_versions WHERE template_version_id = 'tv-sub'",
    ).first()).toEqual({ submitted_by_label: "Somchai (bolt.new)", title: "Harbor | Funding" });
    await expect(run("UPDATE template_versions SET text_defaults_json = 'not json' WHERE template_version_id = 'tv-sub'"))
      .rejects.toThrow(/CHECK constraint failed/);
  });

  it("allows one brand per domain", async () => {
    await expect(
      run(
        `INSERT INTO brands (brand_id, name, account, domain, created_by, created_at, updated_at)
         VALUES ('b2', 'Brand B', 'owner', 'brand-a.test', 'u1', ?1, ?1)`,
        NOW,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
