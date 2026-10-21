#!/usr/bin/env node
/**
 * routing-env: decide what BRAND_ROUTING_JSON the drain gets from a routing.json file.
 *
 *   node routing-env.mjs <routing.json>
 *
 * Prints the file's JSON and exits 0 only when it parses to an object with at least 1 key.
 * Otherwise prints nothing and exits 1, and the caller leaves BRAND_ROUTING_JSON unset.
 * drain.mjs treats a set-but-empty map as "routing active, 0 keys" and skips every row, which
 * would switch off the legacy single-account mode (GOOGLE_ADS_ACCOUNT) a VPS may still use.
 *
 * Plain Node 20, no dependencies. scheduler.mjs imports routingFromFile.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The compact JSON to export, or null when the text is not an object with at least 1 key. */
export function routingFromText(text) {
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return null;
  }
  if (map === null || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0) return null;
  return JSON.stringify(map);
}

/** routingFromText for a file; a missing or unreadable file is null. */
export function routingFromFile(file) {
  try {
    return routingFromText(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const routing = process.argv[2] ? routingFromFile(process.argv[2]) : null;
  if (routing === null) process.exit(1);
  process.stdout.write(routing);
}
