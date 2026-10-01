import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CONVERSION_UPLOADS_COLUMNS, LEADS_DB_MIGRATIONS } from "../src/index";

// Columns Anjuna adds to V1 tables (migration 0003). Everything else must match V1 exactly.
const ANJUNA_ADDED_COLUMNS: Record<string, string[]> = {
  leads: ["experiment_id", "variant", "keyword"],
  click_sessions: ["experiment_id", "variant", "keyword"],
};
const ANJUNA_TABLES = ["brand_runtime", "mailing_outbox"];

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function userTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE 'v1_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

async function tableInfo(db: D1Database, table: string): Promise<ColumnInfo[]> {
  const { results } = await db.prepare(`PRAGMA table_info("${table}")`).all<ColumnInfo>();
  return results;
}

/** Column definitions without the positional cid, so tables with appended columns compare. */
function columnDefs(cols: ColumnInfo[]) {
  return cols.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
}

async function indexes(db: D1Database, table: string) {
  const { results } = await db
    .prepare(`SELECT name, "unique", origin, partial FROM pragma_index_list("${table}") ORDER BY name`)
    .all<{ name: string; unique: number; origin: string; partial: number }>();
  const out: Record<string, { unique: number; origin: string; columns: (string | null)[] }> = {};
  for (const ix of results) {
    // Auto-index names depend on statement order; key them by their columns instead.
    const cols = await db
      .prepare(`SELECT name FROM pragma_index_info("${ix.name}") ORDER BY seqno`)
      .all<{ name: string | null }>();
    const columns = cols.results.map((c) => c.name);
    const key = ix.name.startsWith("sqlite_autoindex_") ? `auto(${columns.join(",")})` : ix.name;
    out[key] = { unique: ix.unique, origin: ix.origin, columns };
  }
  return out;
}

async function foreignKeys(db: D1Database, table: string) {
  const { results } = await db
    .prepare(`SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list("${table}")`)
    .all();
  return results;
}

/** Strip `--` comments and split on `;` (good enough for V1 010, which has no string literals with `;`). */
function splitSql(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const NOW = "2026-10-02T00:00:00.000Z";

function insertLead(db: D1Database, leadId: string) {
  return db
    .prepare(
      `INSERT INTO leads (lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
        requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone, address,
        city, state, zip, address_length_months, own_home, income_type, employer, job_title,
        employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income, tracking_json,
        metadata_json, created_at, click_id, experiment_id, variant, keyword)
       VALUES (?1, 's1', 'v1', 'lite_v1', 'site', 'brand-a', 'brand-a.test', 500, 'bills', 'Ann', 'Lee',
        '1990-01-01', 'ann@example.com', '5555550100', '1 Main St', 'Austin', 'TX', '73301', 12, 0,
        'EMPLOYMENT', 'Acme', 'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, '{}', '{}', ?2,
        replace(?1, '-', ''), 'exp-1', 'B', 'Fast Cash Loans')`,
    )
    .bind(leadId, NOW);
}

beforeAll(async () => {
  // V1 reference database: V1 db/schema.sql (fresh path) + V1 migration 010, both verbatim.
  await applyD1Migrations(env.V1_DB, env.V1_SCHEMA, "v1_migrations");
  const v1m010 = env.V1_MIGRATION_TEXTS["010_v2_sessions.sql"];
  if (!v1m010) throw new Error("V1 migration 010 missing");
  await env.V1_DB.batch(splitSql(v1m010).map((s) => env.V1_DB.prepare(s)));
});

describe("leads-db migrations", () => {
  it("apply cleanly to an empty D1", async () => {
    expect(await userTables(env.DB)).toEqual([]);

    await applyD1Migrations(env.DB, env.MIGRATIONS);

    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...LEADS_DB_MIGRATIONS]);
    expect(await userTables(env.DB)).toEqual(
      [
        "brand_runtime",
        "click_sessions",
        "client_errors",
        "consent_evidence",
        "conversion_uploads",
        "leads",
        "mailing_outbox",
        "postback_events",
        "suppressions",
        "traffic_events",
        "v2_session_submissions",
        "v2_sessions",
        "zip_lookup",
      ].sort(),
    );
    const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
  });

  it("re-applying is a no-op", async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").all<{ n: number }>();
    expect(results[0]?.n).toBe(LEADS_DB_MIGRATIONS.length);
  });

  it("LEADS_DB_MIGRATIONS lists the migration files in order", () => {
    expect(env.MIGRATIONS.map((m) => m.name)).toEqual([...LEADS_DB_MIGRATIONS]);
  });
});

describe("V1 parity", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  it("reference is the verbatim V1 db/schema.sql", () => {
    expect(env.V1_SCHEMA.map((m) => m.name)).toEqual(["schema.sql"]);
  });

  it("conversion_uploads is column-identical to V1", async () => {
    const ours = await tableInfo(env.DB, "conversion_uploads");
    const v1 = await tableInfo(env.V1_DB, "conversion_uploads");
    expect(v1.length).toBeGreaterThan(0);
    // Identical including column order, types, NOT NULL, defaults and PK.
    expect(ours).toEqual(v1);
    expect(await indexes(env.DB, "conversion_uploads")).toEqual(await indexes(env.V1_DB, "conversion_uploads"));
    expect(await foreignKeys(env.DB, "conversion_uploads")).toEqual(
      await foreignKeys(env.V1_DB, "conversion_uploads"),
    );
    expect(ours.map((c) => c.name)).toEqual([...CONVERSION_UPLOADS_COLUMNS]);
  });

  it("every V1 table exists with V1 columns, indexes and foreign keys (plus only the documented Anjuna columns)", async () => {
    const v1Tables = await userTables(env.V1_DB);
    expect(v1Tables.length).toBe(11);
    const ourTables = await userTables(env.DB);
    expect(ourTables.filter((t) => !ANJUNA_TABLES.includes(t))).toEqual(v1Tables);

    for (const table of v1Tables) {
      const added = ANJUNA_ADDED_COLUMNS[table] ?? [];
      const ours = await tableInfo(env.DB, table);
      const v1 = await tableInfo(env.V1_DB, table);
      expect(columnDefs(ours.filter((c) => !added.includes(c.name))), table).toEqual(columnDefs(v1));
      expect(ours.filter((c) => added.includes(c.name)).map((c) => c.name), table).toEqual(added);

      const ourIx = await indexes(env.DB, table);
      for (const [name, ix] of Object.entries(await indexes(env.V1_DB, table))) {
        expect(ourIx[name], `${table}.${name}`).toEqual(ix);
      }
      expect(await foreignKeys(env.DB, table), table).toEqual(await foreignKeys(env.V1_DB, table));
    }
  });

  it("carries the net effect of every V1 migration 001–010", async () => {
    const files = Object.keys(env.V1_MIGRATION_TEXTS).sort();
    expect(files).toHaveLength(10);
    const added = new Map<string, boolean>(); // "table.column" -> present?
    const tables = new Set<string>();
    const indexNames = new Set<string>();
    for (const file of files) {
      const sql = stripComments(env.V1_MIGRATION_TEXTS[file] ?? "");
      for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)) tables.add(m[1]!);
      for (const m of sql.matchAll(/CREATE INDEX IF NOT EXISTS\s+(\w+)/gi)) indexNames.add(m[1]!);
      for (const m of sql.matchAll(/ALTER TABLE\s+(\w+)\s+(ADD|DROP) COLUMN\s+(\w+)/gi)) {
        added.set(`${m[1]}.${m[3]}`, m[2]!.toUpperCase() === "ADD");
      }
    }
    expect(tables.size).toBeGreaterThan(0);
    const ourTables = await userTables(env.DB);
    for (const t of tables) expect(ourTables, t).toContain(t);

    const { results: ixRows } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all<{ name: string }>();
    const ourIndexes = ixRows.map((r) => r.name);
    for (const ix of indexNames) expect(ourIndexes, ix).toContain(ix);

    for (const [key, present] of added) {
      const [table, column] = key.split(".") as [string, string];
      const cols = (await tableInfo(env.DB, table)).map((c) => c.name);
      if (present) expect(cols, key).toContain(column);
      else expect(cols, key).not.toContain(column);
    }
  });
});

describe("Anjuna additions", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.MIGRATIONS);
  });

  it("clicks and leads carry experiment_id / variant / keyword", async () => {
    const leadId = "11111111-1111-4111-8111-111111111111";
    await env.DB.batch([
      insertLead(env.DB, leadId),
      env.DB
        .prepare(
          `INSERT INTO click_sessions (click_session_id, gclid, click_seen_at, first_seen_at, last_seen_at,
            created_at, hostname, experiment_id, variant, keyword)
           VALUES ('cs1', 'g1', ?1, ?1, ?1, ?1, 'brand-a.test', 'exp-1', 'B', 'Fast Cash Loans')`,
        )
        .bind(NOW),
    ]);
    const lead = await env.DB
      .prepare("SELECT experiment_id, variant, keyword FROM leads WHERE lead_id = ?1")
      .bind(leadId)
      .first();
    expect(lead).toEqual({ experiment_id: "exp-1", variant: "B", keyword: "Fast Cash Loans" });
    const click = await env.DB
      .prepare("SELECT experiment_id, variant, keyword FROM click_sessions WHERE click_session_id = 'cs1'")
      .first();
    expect(click).toEqual({ experiment_id: "exp-1", variant: "B", keyword: "Fast Cash Loans" });
  });

  describe("brand_runtime", () => {
    const insert = (overrides: Record<string, unknown> = {}) => {
      const row = {
        brand_id: "brand-a",
        account: "owner",
        hostnames: '["brand-a.test","www.brand-a.test"]',
        drain_key: "brand-a",
        postback_token_hash: "a".repeat(64),
        aid: "12345",
        prepop_base: "https://prepop.invalid/form",
        amount_buckets: "[100,200,300,500,1000]",
        ab_config_json: '{"experiment_id":"exp-1","variants":[{"id":"A","weight":50},{"id":"B","weight":50}]}',
        keyword_default: "Cash Loans",
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
      };
      const cols = Object.keys(row);
      return env.DB
        .prepare(`INSERT INTO brand_runtime (${cols.join(",")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(",")})`)
        .bind(...Object.values(row))
        .run();
    };

    it("stores a brand with defaults param gate and not paused", async () => {
      await insert();
      const row = await env.DB
        .prepare("SELECT flow_gate_mode, paused FROM brand_runtime WHERE brand_id = 'brand-a'")
        .first();
      expect(row).toEqual({ flow_gate_mode: "param", paused: 0 });
    });

    it("accepts signed_cookie gate mode", async () => {
      await insert({ brand_id: "brand-b", flow_gate_mode: "signed_cookie", paused: 1 });
    });

    it.each([
      [{ brand_id: "x1", flow_gate_mode: "cookie" }],
      [{ brand_id: "x2", paused: 2 }],
      [{ brand_id: "x3", hostnames: "brand-a.test" }],
      [{ brand_id: "x4", amount_buckets: '{"a":1}' }],
      [{ brand_id: "x5", ab_config_json: "not json" }],
    ])("rejects invalid row %j", async (overrides) => {
      await expect(insert(overrides)).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe("mailing_outbox", () => {
    const outbox = (leadId: string) =>
      env.DB
        .prepare("INSERT INTO mailing_outbox (lead_id, brand, created_at) VALUES (?1, 'brand-a', ?2)")
        .bind(leadId, NOW);

    it("is written in the same batch as the lead and starts pending", async () => {
      const leadId = "22222222-2222-4222-8222-222222222222";
      await env.DB.batch([insertLead(env.DB, leadId), outbox(leadId)]);
      const row = await env.DB
        .prepare("SELECT status, attempts, next_attempt_at FROM mailing_outbox WHERE lead_id = ?1")
        .bind(leadId)
        .first();
      expect(row).toEqual({ status: "pending", attempts: 0, next_attempt_at: null });
    });

    it("never holds two rows for one lead", async () => {
      const leadId = "33333333-3333-4333-8333-333333333333";
      await env.DB.batch([insertLead(env.DB, leadId), outbox(leadId)]);
      await expect(outbox(leadId).run()).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it("requires an existing lead", async () => {
      await expect(outbox("44444444-4444-4444-8444-444444444444").run()).rejects.toThrow(/FOREIGN KEY/);
    });

    it("rejects unknown statuses", async () => {
      const leadId = "55555555-5555-4555-8555-555555555555";
      await env.DB.batch([insertLead(env.DB, leadId), outbox(leadId)]);
      await expect(
        env.DB.prepare("UPDATE mailing_outbox SET status = 'queued' WHERE lead_id = ?1").bind(leadId).run(),
      ).rejects.toThrow(/CHECK constraint failed/);
    });
  });
});
