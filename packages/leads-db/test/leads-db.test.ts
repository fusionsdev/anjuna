import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CONVERSION_UPLOADS_COLUMNS, LEADS_DB_MIGRATIONS } from "../src/index";

// Columns Anjuna adds to V1 tables (migration 0003). Everything else must match V1 exactly.
const ANJUNA_ADDED_COLUMNS: Record<string, string[]> = {
  leads: ["experiment_id", "variant", "keyword"],
  click_sessions: ["experiment_id", "variant", "keyword", "brand_id"],
  consent_evidence: ["consent_text_hash", "consent_brand", "gpc"],
  traffic_events: ["risk_score", "risk_signals"], // 0015, FUS-372
};
const ANJUNA_TABLES = ["brand_runtime", "mailing_outbox", "account_credentials", "continuations", "ad_spend", "traffic_velocity"];

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
  expect(await userTables(env.DB)).toEqual([]);
  await applyD1Migrations(env.DB, env.MIGRATIONS);

  // V1 reference database: V1 db/schema.sql (fresh path) + V1 migration 010, both verbatim.
  await applyD1Migrations(env.V1_DB, env.V1_SCHEMA, "v1_migrations");
  const v1m010 = env.V1_MIGRATION_TEXTS["010_v2_sessions.sql"];
  if (!v1m010) throw new Error("V1 migration 010 missing");
  await env.V1_DB.batch(splitSql(v1m010).map((s) => env.V1_DB.prepare(s)));
});

describe("leads-db migrations", () => {
  it("apply cleanly to an empty D1", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...LEADS_DB_MIGRATIONS]);
    expect(await userTables(env.DB)).toEqual(
      [
        "account_credentials",
        "ad_spend",
        "brand_runtime",
        "click_sessions",
        "client_errors",
        "consent_evidence",
        "continuations",
        "conversion_uploads",
        "leads",
        "mailing_outbox",
        "postback_events",
        "suppressions",
        "traffic_events",
        "traffic_velocity",
        "v2_session_submissions",
        "v2_sessions",
        "zip_lookup",
      ].sort(),
    );
    const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
  });

  it("re-applying is a no-op", async () => {
    // The file-level setup already applied every migration; this only checks the ledger.
    await applyD1Migrations(env.DB, env.MIGRATIONS);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").all<{ n: number }>();
    expect(results[0]?.n).toBe(LEADS_DB_MIGRATIONS.length);
  });

  it("LEADS_DB_MIGRATIONS lists the migration files in order", () => {
    expect(env.MIGRATIONS.map((m) => m.name)).toEqual([...LEADS_DB_MIGRATIONS]);
  });
});

describe("V1 parity", () => {
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
        form_route: "/request",
        form_version: "form@8ba11d3",
        applied_revision_id: null,
        last_lifecycle_install_id: null,
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

    it("stores per-brand site text and enforces the length limits", async () => {
      await insert({ brand_id: "brand-text", brand_name: "Quick Funds", site_title: "Quick Funds | Options", site_description: "Compare options." });
      expect(await env.DB.prepare("SELECT brand_name, site_title, site_description FROM brand_runtime WHERE brand_id = 'brand-text'").first())
        .toEqual({ brand_name: "Quick Funds", site_title: "Quick Funds | Options", site_description: "Compare options." });
      await expect(insert({ brand_id: "brand-text-2", site_title: "T".repeat(71) })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-text-3", site_description: "d".repeat(161) })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-text-4", brand_name: "" })).rejects.toThrow(/CHECK constraint failed/);
    });

    it("stores the per-brand drain route and enforces its shape", async () => {
      await insert({ brand_id: "brand-route", google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A-1" });
      expect(await env.DB.prepare("SELECT google_ads_account, google_conversion_action, adkit_project FROM brand_runtime WHERE brand_id = 'brand-route'").first())
        .toEqual({ google_ads_account: "1234567890", google_conversion_action: "7754587837", adkit_project: "proj_A-1" });
      await insert({ brand_id: "brand-route-null" });
      expect(await env.DB.prepare("SELECT google_ads_account, google_conversion_action, adkit_project FROM brand_runtime WHERE brand_id = 'brand-route-null'").first())
        .toEqual({ google_ads_account: null, google_conversion_action: null, adkit_project: null });
      await expect(insert({ brand_id: "brand-route-2", google_ads_account: "123-456-7890" })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-route-3", google_ads_account: "123456789" })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-route-4", google_conversion_action: "" })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-route-5", google_conversion_action: "12a" })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-route-6", adkit_project: "a b" })).rejects.toThrow(/CHECK constraint failed/);
    });

    it("stores the per-brand listmonk list id: null by default, a positive integer otherwise", async () => {
      await insert({ brand_id: "brand-list" });
      expect(await env.DB.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = 'brand-list'").first()).toEqual({ listmonk_list_id: null });
      await insert({ brand_id: "brand-list-2", listmonk_list_id: 42 });
      expect(await env.DB.prepare("SELECT listmonk_list_id FROM brand_runtime WHERE brand_id = 'brand-list-2'").first()).toEqual({ listmonk_list_id: 42 });
      await expect(insert({ brand_id: "brand-list-3", listmonk_list_id: 0 })).rejects.toThrow(/CHECK constraint failed/);
      await expect(insert({ brand_id: "brand-list-4", listmonk_list_id: "list-7" })).rejects.toThrow(/CHECK constraint failed/);
    });

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

    it("round-trips lifecycle revision and bundle metadata", async () => {
      await insert({ brand_id: "brand-lifecycle", applied_revision_id: "rev-1", last_lifecycle_install_id: "install-1" });
      const row = await env.DB
        .prepare("SELECT form_version, applied_revision_id, last_lifecycle_install_id FROM brand_runtime WHERE brand_id = 'brand-lifecycle'")
        .first();
      expect(row).toEqual({ form_version: "form@8ba11d3", applied_revision_id: "rev-1", last_lifecycle_install_id: "install-1" });
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

  describe("ad_spend", () => {
    const UPSERT = `INSERT INTO ad_spend (brand_id, date, hour, cost, clicks, impressions, source, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'google', ?7)
      ON CONFLICT (brand_id, date, COALESCE(hour, -1), source)
      DO UPDATE SET cost = excluded.cost, clicks = excluded.clicks, impressions = excluded.impressions, updated_at = excluded.updated_at`;
    const upsert = (hour: number | null, cost: number, at = NOW) =>
      env.DB.prepare(UPSERT).bind("brand-spend", "2026-10-21", hour, cost, 3, 90, at).run();
    const rows = () => env.DB.prepare("SELECT hour, cost, updated_at FROM ad_spend WHERE brand_id = 'brand-spend' ORDER BY hour").all();

    it("upserts one row per (brand, date, hour, source), whole-day NULL hour included", async () => {
      await upsert(5, 1.25);
      await upsert(null, 10);
      await upsert(5, 2.5, "2026-10-21T06:00:00.000Z");
      await upsert(null, 12, "2026-10-21T06:00:00.000Z");
      expect((await rows()).results).toEqual([
        { hour: null, cost: 12, updated_at: "2026-10-21T06:00:00.000Z" },
        { hour: 5, cost: 2.5, updated_at: "2026-10-21T06:00:00.000Z" },
      ]);
    });

    it.each([
      ["hour 24", "INSERT INTO ad_spend (brand_id, date, hour, cost, updated_at) VALUES ('b', '2026-10-21', 24, 1, 'x')"],
      ["negative cost", "INSERT INTO ad_spend (brand_id, date, hour, cost, updated_at) VALUES ('b', '2026-10-21', 1, -1, 'x')"],
      ["timestamp date", "INSERT INTO ad_spend (brand_id, date, hour, cost, updated_at) VALUES ('b', '2026-10-21T00', 1, 1, 'x')"],
      ["unknown source", "INSERT INTO ad_spend (brand_id, date, hour, cost, source, updated_at) VALUES ('b', '2026-10-21', 1, 1, 'bing', 'x')"],
    ])("rejects %s", async (_name, sql) => {
      await expect(env.DB.prepare(sql).run()).rejects.toThrow(/CHECK constraint failed/);
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

  describe("traffic risk (0015, FUS-372)", () => {
    const event = (score: unknown, signals: unknown) =>
      env.DB.prepare(
        `INSERT INTO traffic_events (event_type, session_id, hostname, occurred_at, created_at, risk_score, risk_signals)
         VALUES ('landing_viewed', 's-risk', 'brand-a.test', ?1, ?1, ?2, ?3)`,
      ).bind(NOW, score, signals);

    it("adds nullable risk_score INTEGER and risk_signals TEXT to traffic_events", async () => {
      const cols = (await tableInfo(env.DB, "traffic_events")).filter((c) => c.name.startsWith("risk_"));
      expect(columnDefs(cols)).toEqual([
        { name: "risk_score", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
        { name: "risk_signals", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      ]);
      await event(null, null).run();
      await event(70, '["known_bot_ua","timezone_geo_mismatch"]').run();
      const rows = await env.DB.prepare("SELECT risk_score, risk_signals FROM traffic_events WHERE session_id = 's-risk' ORDER BY id").all();
      expect(rows.results).toEqual([
        { risk_score: null, risk_signals: null },
        { risk_score: 70, risk_signals: '["known_bot_ua","timezone_geo_mismatch"]' },
      ]);
    });

    it("rejects a negative score and signals that are not JSON", async () => {
      await expect(event(-1, "[]").run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(event(20, "known_bot_ua").run()).rejects.toThrow(/CHECK constraint failed/);
    });

    it("counts telemetry per hour and IP hash, never a raw IP", async () => {
      const bump = (hash: string) =>
        env.DB.prepare(
          `INSERT INTO traffic_velocity (hour, ip_hash, events) VALUES ('2026-10-02T00', ?1, 1)
           ON CONFLICT (hour, ip_hash) DO UPDATE SET events = events + 1 RETURNING events`,
        ).bind(hash).first<{ events: number }>();
      const hash = "f".repeat(64);
      expect(await bump(hash)).toEqual({ events: 1 });
      expect(await bump(hash)).toEqual({ events: 2 });
      await expect(bump("203.0.113.9")).rejects.toThrow(/CHECK constraint failed/);
    });
  });
});
