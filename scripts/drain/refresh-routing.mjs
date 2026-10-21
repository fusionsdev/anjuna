#!/usr/bin/env node
/**
 * refresh-routing: fetch the drain's BRAND_ROUTING_JSON from core and write it atomically.
 *
 *   node refresh-routing.mjs <out.json>
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * GETs ${FORM_BASE_URL}/api/conversions/routing, checks every entry has a 10-digit account and a
 * digit conversion action, writes <out.json>.tmp and renames it over <out.json>.
 * On any failure it prints the reason to stderr, leaves <out.json> untouched and exits 1, so the
 * caller keeps draining with the last good routing.
 *
 * Plain Node 20, no dependencies.
 */
import { renameSync, writeFileSync, rmSync } from "node:fs";

const ACCOUNT = /^\d{10}$/;
const ACTION = /^\d{1,20}$/;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;

function fail(message) {
  console.error(`refresh-routing: ${message}`);
  process.exit(1);
}

/** Returns the reason the map is invalid, or null when every entry is usable by drain.mjs. */
function invalidReason(map) {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return "response is not a JSON object";
  for (const [key, route] of Object.entries(map)) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) return `${key}: route is not an object`;
    if (typeof route.account !== "string" || !ACCOUNT.test(route.account)) return `${key}: account is not 10 digits`;
    if (typeof route.conversionAction !== "string" || !ACTION.test(route.conversionAction)) {
      return `${key}: conversionAction is not digits`;
    }
    if (route.project !== undefined && (typeof route.project !== "string" || !PROJECT.test(route.project))) {
      return `${key}: project is invalid`;
    }
  }
  return null;
}

async function main() {
  const out = process.argv[2];
  if (!out) fail("usage: node refresh-routing.mjs <out.json>");
  const { FORM_BASE_URL, DRAIN_TOKEN } = process.env;
  if (!FORM_BASE_URL) fail("missing env FORM_BASE_URL");
  if (!DRAIN_TOKEN) fail("missing env DRAIN_TOKEN");

  const url = `${FORM_BASE_URL.replace(/\/+$/, "")}/api/conversions/routing`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${DRAIN_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    fail(`fetch failed: ${e?.message || e}`);
  }
  if (!res.ok) fail(`HTTP ${res.status} from ${url}`);

  let map;
  try {
    map = JSON.parse(await res.text());
  } catch (e) {
    fail(`response is not valid JSON: ${e?.message || e}`);
  }
  const reason = invalidReason(map);
  if (reason) fail(reason);

  const tmp = `${out}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(map)}\n`);
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    fail(`write failed: ${e?.message || e}`);
  }
  console.log(`routing refreshed: ${Object.keys(map).length} brand(s)`);
}

await main();
