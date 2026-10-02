/**
 * Seed 1 owner + 2 employees into the AUTH D1 (writes SQL; does not touch Cloudflare).
 *
 * Emails come from env (SEED_OWNER_EMAIL, SEED_EMPLOYEE_EMAILS="a@x.com,b@x.com") or from the
 * gitignored `seed.users.json`: {"owner": "...", "employees": ["...", "..."]}.
 * Passwords: SEED_PASSWORD (all three) or, by default, a random one per user printed once here.
 *
 *   bun run seed                      # writes seed.generated.sql (gitignored)
 *   wrangler d1 execute AUTH --local  --file seed.generated.sql
 *   wrangler d1 execute AUTH --remote --file seed.generated.sql   # owner-gated
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSeedStatements, renderSql, type SeedUser } from "../src/server/seed.js";

const root = path.join(import.meta.dirname, "..");

function loadEmails(): { owner: string; employees: string[] } {
  const file = path.join(root, "seed.users.json");
  if (process.env.SEED_OWNER_EMAIL && process.env.SEED_EMPLOYEE_EMAILS) {
    return {
      owner: process.env.SEED_OWNER_EMAIL,
      employees: process.env.SEED_EMPLOYEE_EMAILS.split(",").map((e) => e.trim()).filter(Boolean),
    };
  }
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  throw new Error("Set SEED_OWNER_EMAIL and SEED_EMPLOYEE_EMAILS, or create apps/web/seed.users.json (gitignored).");
}

const randomPassword = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);

const { owner, employees } = loadEmails();
const users: SeedUser[] = [
  { email: owner, name: "Owner", role: "owner", password: process.env.SEED_PASSWORD ?? randomPassword() },
  ...employees.map((email, i): SeedUser => ({
    email,
    name: `Employee ${i + 1}`,
    role: "employee",
    password: process.env.SEED_PASSWORD ?? randomPassword(),
  })),
];

const out = path.join(root, "seed.generated.sql");
writeFileSync(out, renderSql(await buildSeedStatements(users)));
console.log(`Wrote ${out} (gitignored).`);
if (!process.env.SEED_PASSWORD) {
  console.log("Initial passwords (shown once, change after first sign-in):");
  for (const u of users) console.log(`  ${u.role.padEnd(8)} ${u.email}  ${u.password}`);
}
