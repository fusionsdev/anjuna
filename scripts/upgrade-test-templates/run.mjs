#!/usr/bin/env node
/**
 * Imports, certifies and (with --seal) seals the two upgrade-test templates through the template MCP.
 *
 *   TEMPLATE_MCP_KEY=... node scripts/upgrade-test-templates/run.mjs                  # import A and B, certify both
 *   TEMPLATE_MCP_KEY=... OWNER_SECRET=... SEALED_BY=... node scripts/upgrade-test-templates/run.mjs --seal
 *
 * Env: TEMPLATE_MCP_KEY (bearer key, required), OWNER_SECRET and SEALED_BY (required with --seal),
 *      CREATED_BY (optional, defaults to SEALED_BY or "upgrade-test"), MCP_URL (default https://mcp.aduplift.ai/mcp).
 *
 * A and B share one template_id, so B becomes version 2 and the factory can upgrade A -> B ("same template family").
 * Order matters: both versions are imported and certified BEFORE either is sealed. similarityCheck compares only
 * sealed versions, so B passes while A is unsealed. A re-run imports new versions (v3, v4) and would fail
 * similarity against the already sealed v1/v2.
 * Secrets are read from env and never printed.
 */
import { deflateRawSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.MCP_URL || "https://mcp.aduplift.ai/mcp";
const KEY = process.env.TEMPLATE_MCP_KEY;
const OWNER_SECRET = process.env.OWNER_SECRET;
const SEALED_BY = process.env.SEALED_BY;
const CREATED_BY = process.env.CREATED_BY || SEALED_BY || "upgrade-test";
const SEAL = process.argv.includes("--seal");
const TEMPLATE_ID = "upgrade-test";

function fail(message) {
  console.error(message);
  process.exit(1);
}
if (!KEY && !process.argv.includes("--zip-only")) fail("TEMPLATE_MCP_KEY is not set.");
if (SEAL && (!OWNER_SECRET || !SEALED_BY)) fail("--seal needs OWNER_SECRET and SEALED_BY.");

// ── Minimal ZIP writer (deflate, no extras, fixed timestamp) ─────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}
function zipDir(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const path of listFiles(dir)) {
    const data = readFileSync(join(dir, path));
    const packed = deflateRawSync(data);
    const name = Buffer.from(path, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    local.copy(central, 8, 6, 30); // flags .. name length are identical in both headers
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

// Offline check: `--zip-only <outdir>` writes a.zip and b.zip and exits, with no network and no key.
const zipOnly = process.argv.indexOf("--zip-only");
if (zipOnly !== -1) {
  const out = process.argv[zipOnly + 1];
  if (!out) fail("--zip-only needs an output directory.");
  for (const key of ["a", "b"]) writeFileSync(join(out, `${key}.zip`), zipDir(join(here, key)));
  console.log(`wrote ${join(out, "a.zip")} and ${join(out, "b.zip")}`);
  process.exit(0);
}

// ── MCP streamable-HTTP client ───────────────────────────────────────────────────
let sessionId;
let nextId = 1;
async function rpc(method, params, notify = false) {
  const body = { jsonrpc: "2.0", method, params, ...(notify ? {} : { id: nextId++ }) };
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionId = res.headers.get("mcp-session-id") || sessionId;
  const raw = await res.text();
  if (!res.ok) fail(`MCP ${method} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
  if (notify) return undefined;
  const dataLines = (res.headers.get("content-type") || "").includes("text/event-stream")
    ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [raw];
  for (const line of dataLines) {
    const msg = JSON.parse(line);
    if (msg.id === body.id) {
      if (msg.error) fail(`MCP ${method} error: ${JSON.stringify(msg.error).slice(0, 300)}`);
      return msg.result;
    }
  }
  fail(`MCP ${method}: no response with id ${body.id}`);
}
async function call(tool, args) {
  const result = await rpc("tools/call", { name: tool, arguments: args });
  const text = result.content?.map((c) => c.text).join("") ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { isError: Boolean(result.isError), ...parsed };
}

// ── Flow ─────────────────────────────────────────────────────────────────────────
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "upgrade-test-templates", version: "1.0.0" } });
await rpc("notifications/initialized", {}, true);

const ids = {};
for (const key of ["a", "b"]) {
  const zip = zipDir(join(here, key));
  const r = await call("import_template_version", {
    zip_base64: zip.toString("base64"),
    template_id: TEMPLATE_ID,
    template_name: "Upgrade test",
    framework: "astro",
    created_by: CREATED_BY,
  });
  if (!r.pass) fail(`import ${key.toUpperCase()} failed: ${JSON.stringify(r).slice(0, 500)}`);
  ids[key] = r.template_version_id;
  console.log(`import ${key.toUpperCase()}: ${r.template_version_id} (version ${r.version}, sha256 ${r.sha256}, ${zip.length} bytes)`);
}

const certified = {};
for (const key of ["a", "b"]) {
  const r = await call("certify_template_version", { template_version_id: ids[key] });
  certified[key] = r.status === "certified";
  console.log(`certify ${key.toUpperCase()} ${ids[key]}: ${r.status ?? "error"}`);
  for (const c of r.checks ?? []) console.log(`  ${c.check_name}: ${c.result}`);
  for (const m of r.repair_messages ?? []) console.log(`  repair: ${m}`);
  if (!r.checks) console.log(`  ${JSON.stringify(r).slice(0, 500)}`);
}

if (SEAL) {
  if (!certified.a || !certified.b) fail("Not sealing: both versions must be certified first.");
  for (const key of ["a", "b"]) {
    const r = await call("seal_template_version", { template_version_id: ids[key], owner_secret: OWNER_SECRET, sealed_by: SEALED_BY });
    console.log(`seal ${key.toUpperCase()} ${ids[key]}: ${r.pass ? `sealed at ${r.sealed_at}` : `FAILED ${JSON.stringify(r).slice(0, 300)}`}`);
    if (!r.pass) process.exitCode = 1;
  }
} else {
  console.log("Not sealed (run with --seal to seal A then B).");
}
if (!certified.a || !certified.b) process.exitCode = 1;
console.log(`Upgrade from ${ids.a} to ${ids.b}.`);
