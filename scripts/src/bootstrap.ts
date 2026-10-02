/**
 * Tenant bootstrap command. Provisions Cloudflare resources for a fresh tenant installation:
 *   D1 databases (leads, factory, auth), R2 bucket, and seeds the owner login.
 *
 * Usage:
 *   bun run bootstrap --tenant aduplift
 *   bun run bootstrap --tenant friend --owner-password <password>
 *
 * Prerequisites:
 *   - CLOUDFLARE_API_TOKEN must be set in env (or .dev.vars) with the tenant's scoped token.
 *   - Run from the repo root.
 *
 * After running:
 *   1. Copy the printed D1 IDs into tenants/<name>.config.ts under the `d1` key.
 *   2. Update workers/core/wrangler.deploy.jsonc and apps/web/wrangler.jsonc with the new IDs.
 *   3. Commit and push — CI will deploy on the next release tag.
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TenantConfig } from "@anjuna/tenants/schema";
import { buildSeedStatements, renderSql, validateSeedUsers } from "../../apps/web/src/server/seed";
import type { SeedUser } from "../../apps/web/src/server/seed";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const tenantIdx = args.indexOf("--tenant");
const pwdIdx = args.indexOf("--owner-password");

if (tenantIdx === -1 || !args[tenantIdx + 1]) {
  console.error("Usage: bun run bootstrap --tenant <name> [--owner-password <password>]");
  process.exit(1);
}

const tenantName = args[tenantIdx + 1]!;
const ownerPassword = pwdIdx !== -1 ? args[pwdIdx + 1] : process.env["BOOTSTRAP_OWNER_PASSWORD"];

if (!ownerPassword) {
  console.error(
    "Owner password required: pass --owner-password <pwd> or set BOOTSTRAP_OWNER_PASSWORD env var.\n" +
      "Minimum 12 characters. Do not commit or log the password.",
  );
  process.exit(1);
}

if (ownerPassword.length < 12) {
  console.error("Owner password must be at least 12 characters.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load and validate tenant config
// ---------------------------------------------------------------------------

const configPath = join(process.cwd(), "tenants", `${tenantName}.config.ts`);
let raw: { default: unknown };
try {
  raw = await import(configPath);
} catch {
  console.error(`No config found at ${configPath}. Create it first.`);
  process.exit(1);
}

const parsed = TenantConfig.safeParse(raw.default);
if (!parsed.success) {
  console.error("Invalid tenant config:", parsed.error.format());
  process.exit(1);
}
const cfg = parsed.data;

const token = process.env["CLOUDFLARE_API_TOKEN"];
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN must be set to the tenant's scoped Cloudflare API token.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Wrangler helper
// ---------------------------------------------------------------------------

const wranglerEnv = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: cfg.accountId,
};

function wrangler(args: string): string {
  return execSync(`bun x wrangler ${args}`, {
    encoding: "utf8",
    env: wranglerEnv,
  }).trim();
}

/** Parse `database_id = "uuid"` from `wrangler d1 create` text output. */
function parseD1Id(output: string): string {
  const m = output.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/);
  if (!m) throw new Error(`Could not find database_id in wrangler output:\n${output}`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Bootstrap steps
// ---------------------------------------------------------------------------

const prefix = cfg.name;
console.log(`\n── Bootstrapping tenant "${cfg.name}" (account ${cfg.accountId}) ──\n`);

// 1. D1 databases
console.log("Creating D1 databases…");
const leadsId = parseD1Id(wrangler(`d1 create ${prefix}-leads`));
const factoryId = parseD1Id(wrangler(`d1 create ${prefix}-factory`));
const authId = parseD1Id(wrangler(`d1 create ${prefix}-auth`));
console.log(`  leads:   ${leadsId}`);
console.log(`  factory: ${factoryId}`);
console.log(`  auth:    ${authId}`);

// 2. Apply migrations
console.log("\nApplying migrations…");
wrangler(`d1 migrations apply ${prefix}-leads   --remote --migrations-dir packages/leads-db/migrations`);
wrangler(`d1 migrations apply ${prefix}-factory --remote --migrations-dir packages/factory-db/migrations`);
wrangler(`d1 migrations apply ${prefix}-auth    --remote --migrations-dir packages/auth-db/migrations`);
console.log("  Migrations applied.");

// 3. R2 bucket
console.log("\nCreating R2 bucket…");
const r2Name = cfg.r2Templates ?? `${prefix}-templates`;
wrangler(`r2 bucket create ${r2Name}`);
console.log(`  R2: ${r2Name}`);

// 4. Seed owner login
console.log("\nSeeding owner login…");
const seedUsers: SeedUser[] = [
  { email: cfg.ownerEmail, name: "Owner", role: "owner", password: ownerPassword },
  // Two placeholder employees — promote or invite more via the control panel.
  { email: `emp1@${cfg.appDomain}`, name: "Employee 1", role: "employee", password: ownerPassword },
  { email: `emp2@${cfg.appDomain}`, name: "Employee 2", role: "employee", password: ownerPassword },
];
validateSeedUsers(seedUsers);
const stmts = await buildSeedStatements(seedUsers);
const sql = renderSql(stmts);

const seedFile = join(process.cwd(), `.bootstrap-seed-${prefix}.sql`);
writeFileSync(seedFile, sql, "utf8");
wrangler(`d1 execute ${prefix}-auth --remote --file ${seedFile}`);
console.log(`  Owner ${cfg.ownerEmail} seeded.`);

// Remove the seed file — it contains hashed passwords, do not commit it.
import("node:fs").then(({ unlinkSync }) => { try { unlinkSync(seedFile); } catch {} });

// 5. Generate wrangler deploy configs
console.log("\nGenerating wrangler deploy configs…");

const coreDeployConfig = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: "anjuna-core",
  main: "src/index.ts",
  account_id: cfg.accountId,
  compatibility_date: "2026-08-01",
  compatibility_flags: ["global_fetch_strictly_public"],
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: cfg.coreDomain, custom_domain: true }],
  triggers: { crons: ["*/5 * * * *", "*/15 * * * *"] },
  d1_databases: [
    { binding: "LEADS", database_name: `${prefix}-leads`, database_id: leadsId, migrations_dir: "../../packages/leads-db/migrations" },
    { binding: "FACTORY", database_name: `${prefix}-factory`, database_id: factoryId, migrations_dir: "../../packages/factory-db/migrations" },
  ],
};

const webDeployConfig = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: "anjuna-web",
  main: "src/server/index.ts",
  account_id: cfg.accountId,
  compatibility_date: "2026-08-01",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: cfg.appDomain, custom_domain: true }],
  assets: { directory: "./dist/client", binding: "ASSETS", run_worker_first: true, not_found_handling: "single-page-application" },
  d1_databases: [
    { binding: "AUTH", database_name: `${prefix}-auth`, database_id: authId, migrations_dir: "../../packages/auth-db/migrations" },
    { binding: "FACTORY", database_name: `${prefix}-factory`, database_id: factoryId, migrations_dir: "../../packages/factory-db/migrations" },
  ],
  services: [{ binding: "CORE", service: "anjuna-core", entrypoint: "AdminService" }],
  vars: {
    ACCESS_TEAM_DOMAIN: `<FILL: ${cfg.name} Access team domain>`,
    ACCESS_AUD: `<FILL: ${cfg.name} Access AUD tag>`,
    BETTER_AUTH_URL: `https://${cfg.appDomain}`,
    MOCK_CORE: "0",
  },
};

const coreDeployPath = `workers/core/wrangler.deploy.${prefix}.jsonc`;
const webDeployPath = `apps/web/wrangler.deploy.${prefix}.jsonc`;
writeFileSync(join(process.cwd(), coreDeployPath), JSON.stringify(coreDeployConfig, null, 2), "utf8");
writeFileSync(join(process.cwd(), webDeployPath), JSON.stringify(webDeployConfig, null, 2), "utf8");
console.log(`  Written: ${coreDeployPath}`);
console.log(`  Written: ${webDeployPath}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`
── Bootstrap complete for "${cfg.name}" ──────────────────────────

Next steps:
  1. Fill in ACCESS_TEAM_DOMAIN and ACCESS_AUD in:
       ${webDeployPath}
  2. Add these wrangler secret(s) for the tenant worker:
       CLOUDFLARE_API_TOKEN env var already handles deploy auth.
       Set remaining secrets with: bun x wrangler secret put <SECRET_NAME>
         ${Object.values(cfg.secrets).join(", ")}
  3. Commit ${coreDeployPath} and ${webDeployPath}.
  4. Create a GitHub Environment named "${cfg.name}" with the secrets above.
  5. Push a release tag (e.g. v1.0.0) to trigger the CI deploy.

D1 IDs (update tenants/${cfg.name}.config.ts and wrangler deploy configs):
  leads:   ${leadsId}
  factory: ${factoryId}
  auth:    ${authId}
`);
