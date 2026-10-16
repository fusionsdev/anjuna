#!/usr/bin/env node
// Mint a builder API key. Prints the key ONCE and the SQL that stores only its SHA-256 hash.
//   node scripts/mint-key.mjs "v0 - harbor"
// Then run the SQL against the factory D1, e.g.:
//   wrangler d1 execute aduplift-factory --remote --command "<SQL>"
// Revoke:  UPDATE builder_keys SET revoked_at = datetime('now') WHERE key_id = '<key_id>';
import { createHash, randomBytes, randomUUID } from "node:crypto";

const label = process.argv[2];
if (!label) {
  console.error('usage: mint-key.mjs "<builder label>"');
  process.exit(1);
}
const key = `anj_mcp_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const id = `bk_${randomUUID()}`;
const esc = (s) => s.replaceAll("'", "''");
console.log(`API key (shown once, give it to the builder): ${key}\n`);
console.log(
  `INSERT INTO builder_keys (key_id, label, key_hash, created_by, created_at) VALUES ('${id}', '${esc(label)}', '${hash}', 'system', '${new Date().toISOString()}');`,
);
