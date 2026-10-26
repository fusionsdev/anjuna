import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CHECKLIST_ITEMS, FACTORY_DB_MIGRATIONS, INSTALL_STEPS, effectiveThemeVarsSql } from "../src/index";

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
        "ads_account_events",
        "audit_log",
        "brand_assets",
        "brand_revisions",
        "brands",
        "builder_key_usage",
        "builder_keys",
        "certifications",
        "form_artifacts",
        "install_receipts",
        "installs",
        "template_theme_vars",
        "template_versions",
        "template_fingerprints",
        "templates",
        "template_upload_chunks",
        "template_uploads",
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

  it("holds one favicon and one logo per brand within the size and type checks", async () => {
    const insert = (brand: string, kind: string, type: string, length: number) => run(
      "INSERT INTO brand_assets (brand_id, kind, content_type, byte_length, sha256, body_base64, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'AAAA', 'u1', ?6)",
      brand, kind, type, length, "d".repeat(64), NOW,
    );
    await insert("b1", "favicon", "image/png", 10);
    await insert("b1", "logo", "image/svg+xml", 262144);
    await expect(insert("b1", "logo", "image/png", 10)).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert("b1", "banner", "image/png", 10)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("b1", "favicon", "image/gif", 10)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("b1", "favicon", "image/png", 262145)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert("missing", "favicon", "image/png", 10)).rejects.toThrow(/FOREIGN KEY/);
  });

  it("checks ads account event type, role and note length", async () => {
    let n = 0;
    const insert = (type: string, role: string, note: string) => run(
      "INSERT INTO ads_account_events (event_id, brand_id, type, occurred_at, note, created_by, created_role, created_at) VALUES (?1, 'b1', ?2, ?3, ?4, 'u1', ?5, ?3)",
      `ev-check-${++n}`, type, NOW, note, role,
    );
    await insert("ad_disapproved", "employee", "");
    await expect(insert("bogus", "employee", "")).rejects.toThrow(/CHECK constraint failed: type IN/);
    await expect(insert("other", "system", "")).rejects.toThrow(/CHECK constraint failed: created_role IN/);
    await expect(insert("other", "owner", "x".repeat(501))).rejects.toThrow(/CHECK constraint failed: length\(note\) <= 500/);
    await insert("other", "owner", "x".repeat(500));
  });

  it("indexes ads account events by brand and time", async () => {
    const row = await env.DB.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ads_account_events_brand'").first<{ tbl_name: string }>();
    expect(row?.tbl_name).toBe("ads_account_events");
  });

  it("has no foreign key on ads account event brand ids", async () => {
    await run(
      "INSERT INTO ads_account_events (event_id, brand_id, type, occurred_at, created_by, created_role, created_at) VALUES ('ev-core-only', 'core-only', 'other', ?1, 'u1', 'owner', ?1)",
      NOW,
    );
    const row = await env.DB.prepare("SELECT note FROM ads_account_events WHERE event_id = 'ev-core-only'").first<{ note: string }>();
    expect(row?.note).toBe("");
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

  it("migration 0010 adds theme_vars_json", async () => {
    await run("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t-theme', 'Themed', 'react_spa', 'bk_1', ?1)", NOW);
    await run(
      `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, created_by, created_at, theme_vars_json)
       VALUES ('tv-theme', 't-theme', 1, ?1, 'k', 'bk_1', ?2, ?3)`,
      "f".repeat(64), NOW, JSON.stringify({ primary: ["--brand"], primary_dark: [], secondary: [] }),
    );
    expect(await env.DB.prepare(
      "SELECT json_extract(theme_vars_json, '$.primary[0]') AS primary_var FROM template_versions WHERE template_version_id = 'tv-theme'",
    ).first()).toEqual({ primary_var: "--brand" });
    await expect(run("UPDATE template_versions SET theme_vars_json = 'not json' WHERE template_version_id = 'tv-theme'"))
      .rejects.toThrow(/CHECK constraint failed/);
  });

  it("migration 0011 adds template_theme_vars", async () => {
    await run("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t-bf', 'Backfilled', 'react_spa', 'bk_1', ?1)", NOW);
    await run(
      `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at)
       VALUES ('tv-bf', 't-bf', 1, ?1, 'k', 'sealed', 'owner1', ?2, 'bk_1', ?2)`,
      "1".repeat(64), NOW,
    );
    const vars = JSON.stringify({ primary: ["--brand"], primary_dark: [], secondary: [] });
    await run(
      "INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES ('tv-bf', ?1, 'owner1', ?2)",
      vars, NOW,
    );
    expect(await env.DB.prepare(
      "SELECT json_extract(theme_vars_json, '$.primary[0]') AS primary_var FROM template_theme_vars WHERE template_version_id = 'tv-bf'",
    ).first()).toEqual({ primary_var: "--brand" });
    await expect(run("UPDATE template_theme_vars SET theme_vars_json = 'not json' WHERE template_version_id = 'tv-bf'"))
      .rejects.toThrow(/CHECK constraint failed/);
    await expect(run(
      "INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES ('missing', ?1, 'owner1', ?2)",
      vars, NOW,
    )).rejects.toThrow(/FOREIGN KEY/);
  });

  it("effectiveThemeVarsSql prefers the backfill row", async () => {
    await run("INSERT INTO templates (template_id, name, framework, created_by, created_at) VALUES ('t-eff', 'Effective', 'react_spa', 'bk_1', ?1)", NOW);
    for (const [id, version, column] of [["tv-eff-null", 1, null], ["tv-eff-col", 2, '{"primary":["--col"],"primary_dark":[],"secondary":[]}']] as const) {
      await run(
        `INSERT INTO template_versions (template_version_id, template_id, version, sha256, r2_key, status, sealed_by, sealed_at, created_by, created_at, theme_vars_json)
         VALUES (?1, 't-eff', ?2, ?3, 'k', 'sealed', 'owner1', ?4, 'bk_1', ?4, ?5)`,
        id, version, String(version + 4).repeat(64), NOW, column,
      );
    }
    const read = (id: string) => env.DB.prepare(
      `SELECT ${effectiveThemeVarsSql("v")} AS theme_vars_json FROM template_versions v WHERE v.template_version_id = ?1`,
    ).bind(id).first<{ theme_vars_json: string | null }>();

    expect(await read("tv-eff-null")).toEqual({ theme_vars_json: null });
    expect(await read("tv-eff-col")).toEqual({ theme_vars_json: '{"primary":["--col"],"primary_dark":[],"secondary":[]}' });

    const backfill = '{"primary":["--back"],"primary_dark":[],"secondary":[]}';
    for (const id of ["tv-eff-null", "tv-eff-col"]) {
      await run(
        "INSERT INTO template_theme_vars (template_version_id, theme_vars_json, updated_by, updated_at) VALUES (?1, ?2, 'owner1', ?3)",
        id, backfill, NOW,
      );
      expect(await read(id)).toEqual({ theme_vars_json: backfill });
    }
    await expect(run("UPDATE template_versions SET theme_vars_json = '{}' WHERE template_version_id = 'tv-eff-null'"))
      .rejects.toThrow(/sealed template versions are immutable/);
  });

  it("effectiveThemeVarsSql rejects a bad alias", () => {
    expect(() => effectiveThemeVarsSql("v; DROP TABLE x")).toThrow("invalid alias");
    expect(() => effectiveThemeVarsSql("V")).toThrow("invalid alias");
    expect(() => effectiveThemeVarsSql("")).toThrow("invalid alias");
    expect(effectiveThemeVarsSql("template_versions")).toContain("template_versions.template_version_id");
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
