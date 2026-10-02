import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { PendingResponse, type PendingConversion } from "@anjuna/contracts";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const DRAIN_TOKEN = "core-test-drain-only";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const fixtureText = (file: string) => readFileSync(join(ROOT, "packages/contracts/fixtures", file), "utf8");
export const goldenRows = () => PendingResponse.parse(JSON.parse(fixtureText("drain/pending.response.json"))).conversions;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, "workers/core", entry)], bundle: true, write: false,
    format: "esm", platform: "neutral", external: ["cloudflare:workers"],
  });
  return result.outputFiles[0]!.text;
}

export async function createHarness() {
  const [production, testWorker, leadsMigrations, factoryMigrations] = await Promise.all([
    bundle("src/index.ts"), bundle("test/worker.ts"),
    readD1Migrations(join(ROOT, "packages/leads-db/migrations")),
    readD1Migrations(join(ROOT, "packages/factory-db/migrations")),
  ]);
  const common = {
    modules: true, compatibilityDate: "2026-08-01",
    compatibilityFlags: ["global_fetch_strictly_public"],
    d1Databases: { LEADS: "core-test-leads", FACTORY: "core-test-factory" },
    bindings: { DRAIN_TOKEN },
    outboundService: () => { throw new Error("External requests forbidden in core tests"); },
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: [
      { ...common, name: "production", script: production },
      { ...common, name: "test-core", script: testWorker },
      { ...common, name: "no-drain-token", script: production, bindings: {} },
      {
        name: "panel", modules: true, compatibilityDate: "2026-08-01",
        serviceBindings: {
          CORE_ADMIN: { name: "test-core", entrypoint: "TestAdminService" },
          PRODUCTION_ADMIN: { name: "production", entrypoint: "AdminService" },
        },
        script: `export default {fetch(req, env) {
          return (req.headers.has("x-production") ? env.PRODUCTION_ADMIN : env.CORE_ADMIN).fetch(req);
        }};`,
      },
    ],
  }));
  const db = await mf.getD1Database("LEADS", "production");
  const factory = await mf.getD1Database("FACTORY", "production");
  for (const migration of leadsMigrations) await db.batch(migration.queries.map((query) => db.prepare(query)));
  for (const migration of factoryMigrations) await factory.batch(migration.queries.map((query) => factory.prepare(query)));
  const core = await mf.getWorker("production");
  let hiddenOrphan = false;

  return {
    mf, db, factory, core,
    async reset() {
      if (hiddenOrphan) {
        await db.batch([db.prepare("DROP VIEW leads"), db.prepare("ALTER TABLE fixture_leads RENAME TO leads")]);
        hiddenOrphan = false;
      }
      await db.batch(["conversion_uploads", "postback_events", "leads", "brand_runtime", "account_credentials"]
        .map((table) => db.prepare(`DELETE FROM ${table}`)));
    },
    async seedBrand(id = "brand-a", token = "T", account = "account-a") {
      await db.prepare(`INSERT INTO brand_runtime
        (brand_id, account, hostnames, drain_key, postback_token_hash, aid, prepop_base, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'test-aid', 'https://prepop.example/apply', ?6, ?6)`)
        .bind(id, account, JSON.stringify([`${id}.example`]), `drain-${id}`, hash(token), "2026-01-01T00:00:00.000Z").run();
    },
    async seedAccount(account = "account-a", token = "account-a-token") {
      await db.prepare("INSERT INTO account_credentials (account, credential_hash, created_at) VALUES (?1, ?2, ?3)")
        .bind(account, hash(token), "2026-01-01T00:00:00.000Z").run();
    },
    async seedLead(id = "lead-1", cid = "abc123", brand = "brand-a", tracking: Record<string, string> = {}) {
      await db.prepare(`INSERT INTO leads (
        lead_id, session_id, form_version, form_variant, site_id, brand, hostname,
        requested_amount, loan_purpose, first_name, last_name, birth_date, email, home_phone,
        address, city, state, zip, address_length_months, own_home, income_type, employer,
        job_title, employed_months, pay_date1, pay_frequency, direct_deposit, monthly_income,
        tracking_json, metadata_json, created_at, click_id
      ) VALUES (?1, 'session', 'test', 'lite_v1', 'form-default', ?2, ?3,
        1000, 'OTHER', 'Test', 'Applicant', '1990-01-01', 'test@example.com', '2145550123',
        '100 Example St', 'Dallas', 'TX', '75201', 24, 0, 'EMPLOYMENT', 'Example',
        'Clerk', 24, '2026-10-09', 'BIWEEKLY', 1, 3000, ?4, '{}', ?5, ?6)`)
        .bind(id, brand, `${brand}.example`, JSON.stringify(tracking), "2026-01-01T00:00:00.000Z", cid).run();
    },
    async seedConversion(id = "lead-1", overrides: Record<string, unknown> = {}) {
      const row = {
        lead_id: id, gclid: "fixture-click", value: 25, currency: "USD",
        occurred_at: "2026-01-01T00:00:00.000Z", google_order_id: id,
        created_at: "2026-01-01T00:00:00.000Z", ...overrides,
      };
      await db.prepare(`INSERT INTO conversion_uploads (${Object.keys(row).join(",")})
        VALUES (${Object.keys(row).map(() => "?").join(",")})`).bind(...Object.values(row)).run();
    },
    async seedGoldens() {
      const rows = goldenRows();
      for (const [index, row] of rows.entries()) {
        await this.seedLead(row.lead_id, row.lead_id.replace(/-/g, ""), row.brand ?? "orphan");
        await db.prepare("UPDATE leads SET hostname = ?1 WHERE lead_id = ?2")
          .bind(row.hostname ?? "orphan.example", row.lead_id).run();
        const { brand: _brand, hostname: _host, ...conversion } = row;
        await this.seedConversion(row.lead_id, { ...conversion, created_at: `2026-01-01T00:00:0${index}.000Z` });
      }
      // The golden deliberately contains an orphan. D1 correctly forbids creating one via
      // normal writes. Hide its parent behind a test-only view to exercise V1's LEFT JOIN
      // fallback without weakening the actual conversion table or its foreign key.
      await db.batch([
        db.prepare("ALTER TABLE leads RENAME TO fixture_leads"),
        db.prepare(`CREATE VIEW leads AS SELECT * FROM fixture_leads WHERE lead_id != '${rows[3]!.lead_id}'`),
      ]);
      hiddenOrphan = true;
    },
    async request(path: string, init: RequestInit = {}) {
      const response = await core.fetch(`https://core.aduplift.ai${path}`, init as Parameters<typeof core.fetch>[1]);
      // Always drain the local HTTP transport, including tests that only inspect status.
      return new Response(await response.arrayBuffer(), {
        status: response.status, headers: Object.fromEntries(response.headers),
      });
    },
    pending(query = "?limit=100") {
      return this.request(`/api/conversions/pending${query}`, { headers: { Authorization: `Bearer ${DRAIN_TOKEN}` } });
    },
    ack(results: unknown) {
      return this.request("/api/conversions/ack", {
        method: "POST", headers: { Authorization: `Bearer ${DRAIN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ results }),
      });
    },
    async queue(id = "lead-1") {
      return db.prepare("SELECT * FROM conversion_uploads WHERE lead_id = ?1").bind(id).first<{
        status: string; attempts: number; next_attempt_at: string | null; last_error: string | null;
        updated_at: string | null; value: number; gclid: string | null; msclkid: string | null;
      }>();
    },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
export type { PendingConversion };

/** The actual V1 process talks HTTP to a relay that forwards every byte to Miniflare core. */
export async function runRealDrain(harness: Harness, extraEnv: Record<string, string> = {}) {
  const exchanges: Array<{
    method: string; url: string; authorization?: string; contentType?: string;
    body: string; status: number; response: string; responseContentType: string | null;
  }> = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const reply = await harness.request(req.url!, {
        method: req.method!, headers: {
          Authorization: req.headers.authorization ?? "",
          "Content-Type": req.headers["content-type"] ?? "",
        }, ...(body ? { body } : {}),
      });
      const response = await reply.text();
      exchanges.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization,
        contentType: req.headers["content-type"], body, status: reply.status, response,
        responseContentType: reply.headers.get("Content-Type") });
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      res.end(response);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const emptyBin = mkdtempSync(join(tmpdir(), "core-no-adkit-"));
  try {
    const env = {
      PATH: emptyBin, FORM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      DRAIN_TOKEN, BRAND_ROUTING_JSON: "{}", DRAIN_LIMIT: "25", ...extraEnv,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(ROOT, "packages/contracts/test/v1/drain.mjs")],
        { env, timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
          resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr });
        });
    });
    return { ...output, exchanges };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmdirSync(emptyBin); // Empty, uniquely-created directory; no recursive deletion.
  }
}
