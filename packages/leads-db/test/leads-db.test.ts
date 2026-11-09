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
  suppressions: ["added_by"], // 0017, FUS-382
};
const ANJUNA_TABLES = ["brand_runtime", "mailing_outbox", "account_credentials", "continuations", "ad_spend", "traffic_velocity", "conversion_setup", "adkit_directory", "adkit_jobs", "campaign_brand_map", "ad_spend_unallocated", "bot_hits", "ad_spend_campaign"];

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
        "ad_spend_campaign",
        "ad_spend_unallocated",
        "adkit_directory",
        "adkit_jobs",
        "bot_hits",
        "brand_runtime",
        "campaign_brand_map",
        "click_sessions",
        "client_errors",
        "consent_evidence",
        "continuations",
        "conversion_setup",
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

    it("migration 0016 adds theme_json and refuses invalid JSON", async () => {
      const cols = (await tableInfo(env.DB, "brand_runtime")).filter((c) => c.name === "theme_json");
      expect(columnDefs(cols)).toEqual([{ name: "theme_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }]);
      await insert({ brand_id: "brand-theme", theme_json: '{"primary":"#0f766e","secondary":"#1e293b"}' });
      expect(await env.DB.prepare("SELECT theme_json FROM brand_runtime WHERE brand_id = 'brand-theme'").first())
        .toEqual({ theme_json: '{"primary":"#0f766e","secondary":"#1e293b"}' });
      await insert({ brand_id: "brand-theme-null" });
      expect(await env.DB.prepare("SELECT theme_json FROM brand_runtime WHERE brand_id = 'brand-theme-null'").first()).toEqual({ theme_json: null });
      await expect(insert({ brand_id: "brand-theme-bad", theme_json: "not json" })).rejects.toThrow(/CHECK constraint failed/);
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

    it("stores THB for a row written without a currency (0019: legacy rows are baht)", async () => {
      await env.DB.prepare("INSERT INTO ad_spend (brand_id, date, hour, cost, updated_at) VALUES ('brand-legacy', '2026-10-21', 7, 12448, 'x')").run();
      const row = await env.DB.prepare("SELECT cost, currency FROM ad_spend WHERE brand_id = 'brand-legacy'").first();
      expect(row).toEqual({ cost: 12448, currency: "THB" });
    });

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
      ["unknown currency", "INSERT INTO ad_spend (brand_id, date, hour, cost, currency, updated_at) VALUES ('b', '2026-10-21', 1, 1, 'EUR', 'x')"],
      ["unknown allocation", "INSERT INTO ad_spend (brand_id, date, hour, cost, allocation, updated_at) VALUES ('b', '2026-10-21', 1, 1, 'guess', 'x')"],
      ["short account", "INSERT INTO ad_spend (brand_id, date, hour, cost, account, updated_at) VALUES ('b', '2026-10-21', 1, 1, '538116393', 'x')"],
    ])("rejects %s", async (_name, sql) => {
      await expect(env.DB.prepare(sql).run()).rejects.toThrow(/CHECK constraint failed/);
    });

    it("stores exact and a NULL account for a row written without them (0022: earlier rows are exact)", async () => {
      await env.DB.prepare("INSERT INTO ad_spend (brand_id, date, hour, cost, updated_at) VALUES ('brand-alloc', '2026-10-21', 7, 1, 'x')").run();
      const row = await env.DB.prepare("SELECT allocation, account FROM ad_spend WHERE brand_id = 'brand-alloc'").first();
      expect(row).toEqual({ allocation: "exact", account: null });
    });
  });

  describe("campaign_brand_map and ad_spend_unallocated (0022)", () => {
    it("keeps one map row per account and campaign", async () => {
      const insert = (brand: string) => env.DB.prepare(`INSERT INTO campaign_brand_map
        (account, campaign_id, brand_id, source, first_seen, updated_at) VALUES ('5381163935', '987', ?1, 'click', 'x', 'x')`).bind(brand);
      await insert("brand-one").run();
      await expect(insert("brand-two").run()).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it.each([
      ["unknown source", "INSERT INTO campaign_brand_map VALUES ('5381163935', '1', 'b', 'guess', 'x', 'x')"],
      ["short account", "INSERT INTO campaign_brand_map VALUES ('538116393', '1', 'b', 'click', 'x', 'x')"],
      ["non-numeric campaign", "INSERT INTO campaign_brand_map VALUES ('5381163935', 'summer', 'b', 'click', 'x', 'x')"],
      ["negative unallocated cost", "INSERT INTO ad_spend_unallocated VALUES ('5381163935', '2026-10-21', 1, -1, 'THB', 'x')"],
      ["unallocated hour 24", "INSERT INTO ad_spend_unallocated VALUES ('5381163935', '2026-10-21', 24, 1, 'THB', 'x')"],
      ["unallocated currency", "INSERT INTO ad_spend_unallocated VALUES ('5381163935', '2026-10-21', 1, 1, 'EUR', 'x')"],
    ])("rejects %s", async (_name, sql) => {
      await expect(env.DB.prepare(sql).run()).rejects.toThrow(/CHECK constraint failed/);
    });

    it("indexes click_sessions by campaign and by brand, each with click_seen_at", async () => {
      const ix = await indexes(env.DB, "click_sessions");
      expect(ix.idx_click_sessions_campaign?.columns).toEqual(["utm_campaign", "click_seen_at"]);
      expect(ix.click_sessions_brand_seen?.columns).toEqual(["brand_id", "click_seen_at"]);
    });

    it("keys unallocated rows by account, date, hour (NULL = whole day) and currency", async () => {
      const insert = (hour: number | null, currency: string) => env.DB.prepare(
        "INSERT INTO ad_spend_unallocated VALUES ('1231231234', '2026-10-21', ?1, 1, ?2, 'x')").bind(hour, currency);
      await insert(null, "THB").run();
      await insert(null, "USD").run();
      await insert(3, "THB").run();
      await expect(insert(null, "THB").run()).rejects.toThrow(/UNIQUE constraint failed/);
    });
  });

  describe("ad_spend_campaign (0026)", () => {
    const insert = (hour: number | null, campaign: string, currency = "THB") => env.DB.prepare(
      "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', ?1, ?2, 1, ?3, 1, 1, 'x', 0)").bind(hour, campaign, currency);

    it("keys rows by account, date, hour (NULL = whole day), campaign and currency", async () => {
      await insert(null, "1").run();
      await insert(null, "1", "USD").run();
      await insert(3, "1").run();
      await insert(3, "2").run();
      await expect(insert(null, "1").run()).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(insert(3, "2").run()).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it.each([
      ["short account", "INSERT INTO ad_spend_campaign VALUES ('538116393', '2026-10-21', 1, '1', 1, 'THB', 1, 1, 'x', 0)"],
      ["non-numeric campaign", "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', 1, 'summer', 1, 'THB', 1, 1, 'x', 0)"],
      ["negative cost", "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', 1, '1', -1, 'THB', 1, 1, 'x', 0)"],
      ["hour 24", "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', 24, '1', 1, 'THB', 1, 1, 'x', 0)"],
      ["currency EUR", "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', 1, '1', 1, 'EUR', 1, 1, 'x', 0)"],
      ["negative clicks", "INSERT INTO ad_spend_campaign VALUES ('5381163935', '2026-10-21', 1, '1', 1, 'THB', -1, 1, 'x', 0)"],
    ])("rejects %s", async (_name, sql) => {
      await expect(env.DB.prepare(sql).run()).rejects.toThrow(/CHECK constraint failed/);
    });
  });

  describe("conversion_setup", () => {
    const insert = (account: string, name: string, actionId: string | null = null, lastError: string | null = null) =>
      env.DB
        .prepare(
          `INSERT INTO conversion_setup (brand_id, account, name, status, claim_id, claimed_at, last_error, conversion_action_id, updated_at)
           VALUES ('brand-cs', ?1, ?2, 'claimed', 'c', 'x', ?3, ?4, 'x')`,
        )
        .bind(account, name, lastError, actionId);
    const GOOD_NAME = "cv-0123456789abcdef";
    const GOOD_ACCOUNT = "1234567890";

    it("accepts a valid row", async () => {
      await insert(GOOD_ACCOUNT, GOOD_NAME, "7123456789").run();
      await env.DB.prepare("DELETE FROM conversion_setup WHERE brand_id = 'brand-cs'").run();
    });

    it("conversion_setup CHECKs reject a bad name, account and action id", async () => {
      const bad = [
        insert(GOOD_ACCOUNT, "cv-0123456789ABCDEF"),
        insert(GOOD_ACCOUNT, "cv-0123456789abcde"),
        insert(GOOD_ACCOUNT, "cv-0123456789abcdef0"),
        insert(GOOD_ACCOUNT, "brand-a-lead-form"),
        insert("123456789", GOOD_NAME),
        insert("12345678901", GOOD_NAME),
        insert("12345abcde", GOOD_NAME),
        insert(GOOD_ACCOUNT, GOOD_NAME, ""),
        insert(GOOD_ACCOUNT, GOOD_NAME, "12ab"),
        insert(GOOD_ACCOUNT, GOOD_NAME, "1".repeat(21)),
        insert(GOOD_ACCOUNT, GOOD_NAME, null, "e".repeat(501)),
      ];
      for (const stmt of bad) await expect(stmt.run()).rejects.toThrow(/CHECK constraint failed/);
      await insert(GOOD_ACCOUNT, GOOD_NAME, "1".repeat(20), "e".repeat(500)).run();
      await env.DB.prepare("DELETE FROM conversion_setup WHERE brand_id = 'brand-cs'").run();
    });
  });

  describe("adkit_directory and adkit_jobs", () => {
    const directory = (kind: string, currency: string | null) =>
      env.DB.prepare("INSERT INTO adkit_directory (kind, id, parent_id, name, currency, updated_at) VALUES (?1, 'd1', NULL, 'n', ?2, 'x')")
        .bind(kind, currency);
    const job = (id: string, key: string, status: string, claimId: string | null, payload = "{}") =>
      env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, claim_id, claimed_at, created_at, updated_at)
        VALUES (?1, 'conversion_action.create', ?2, ?3, 0, ?4, 'usr', ?5, ?6, 'x', 'x')`)
        .bind(id, payload, status, key, claimId, claimId === null ? null : "x");

    it("directory CHECKs reject an unknown kind and a bad currency", async () => {
      for (const stmt of [directory("campaign", null), directory("account", "thb"), directory("account", "USDT")]) {
        await expect(stmt.run()).rejects.toThrow(/CHECK constraint failed/);
      }
      await directory("account", "THB").run();
      await env.DB.prepare("DELETE FROM adkit_directory").run();
    });

    it("jobs keep one row per idempotency key and a claimed row needs its claim", async () => {
      await job("j1", "key-1", "queued", null).run();
      await expect(job("j2", "key-1", "queued", null).run()).rejects.toThrow(/UNIQUE constraint failed/);
      await expect(job("j3", "key-3", "claimed", null).run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(job("j4", "key-4", "running", null).run()).rejects.toThrow(/CHECK constraint failed/);
      await expect(job("j5", "key-5", "queued", null, "not json").run()).rejects.toThrow(/CHECK constraint failed/);
      await job("j6", "key-6", "claimed", "claim").run();
      await env.DB.prepare("DELETE FROM adkit_jobs").run();
    });

    it("0023 accepts the four campaign kinds and still rejects an unknown kind", async () => {
      const kinds = ["campaign.draft.create", "campaign.update_budget", "campaign.pause", "campaign.enable"];
      const insert = (id: string, kind: string) =>
        env.DB.prepare(`INSERT INTO adkit_jobs (id, kind, payload, status, attempts, idempotency_key, requested_by, created_at, updated_at)
          VALUES (?1, ?2, '{}', 'queued', 0, ?1, 'usr', 'x', 'x')`).bind(id, kind);
      for (const [i, kind] of kinds.entries()) await insert(`kind-job-${i}`, kind).run();
      await expect(insert("kind-job-x", "campaign.delete").run()).rejects.toThrow(/CHECK constraint failed/);
      await env.DB.prepare("DELETE FROM adkit_jobs").run();
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
