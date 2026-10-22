#!/usr/bin/env node
/**
 * spend-sync: copy each brand's Google Ads spend from AdKit into core (FUS-368).
 *
 *   node spend-sync.mjs [--dry-run]
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * Optional: GOOGLE_PROJECT / ADKIT_PROJECT (fallback --project, as in drain.mjs) and
 * SPEND_BREAKDOWN = hour (default, one row per day and hour) or day (one whole-day row per day).
 *
 *   1. GET ${FORM_BASE_URL}/api/conversions/routing: brand_id -> { account, project }.
 *   2. Per brand: adkit manage google results list --account <account> --level account
 *      --breakdown <hour|day> --json [--project <project>].
 *   3. Map the output to { brand_id, date, hour, cost, clicks, impressions } rows (cost in USD).
 *   4. POST them to ${FORM_BASE_URL}/api/spend/ingest in chunks; core upserts, so re-sending a
 *      day replaces its values and every run can resend the whole window AdKit returns.
 * --dry-run prints the mapped rows per brand and POSTs nothing.
 * One failing brand does not stop the others; any failure makes the exit code 1.
 *
 * Plain Node 20, no dependencies. drain.mjs is not touched; run.sh and scheduler.mjs call this hourly.
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CHUNK = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** The adkit argv for one brand's account-level results. */
export function adkitArgsFor(route, breakdown, fallbackProject) {
  const args = [
    "manage", "google", "results", "list",
    "--account", route.account,
    "--level", "account",
    "--breakdown", breakdown,
    "--json",
  ];
  const project = route.project || fallbackProject;
  if (project) args.push("--project", project);
  return args;
}

/** Parse the JSON tail of adkit stdout (AdKit may print a notice line before the JSON). */
export function parseAdkitJson(stdout) {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((i) => i >= 0);
  return JSON.parse(starts.length ? stdout.slice(Math.min(...starts)) : stdout);
}

/** The result rows array: the output itself, or the first array under a known key. */
function resultRows(out) {
  if (Array.isArray(out)) return out;
  for (const key of ["results", "rows", "data", "items"]) {
    const value = out?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = resultRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function num(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const pick = (sources, keys) => {
  for (const source of sources) for (const key of keys) if (source?.[key] !== undefined) return source[key];
  return undefined;
};

/**
 * Map adkit results output to ingest rows for one brand. Reads date/hour from the row or its
 * `segments`, cost from `cost` (USD) or `costMicros` / `cost_micros` (micros), clicks and
 * impressions from the row or its `metrics`. Rows sharing a date and hour are summed. Returns the
 * rows plus how many input rows were skipped for a missing date, hour or cost.
 */
export function spendRowsFromAdkit(out, brandId, breakdown) {
  const merged = new Map();
  let skipped = 0;
  for (const item of resultRows(out)) {
    const sources = [item, item?.segments, item?.metrics];
    const rawDate = pick(sources, ["date", "day"]);
    const date = typeof rawDate === "string" && DATE.test(rawDate) ? rawDate.slice(0, 10) : null;
    const rawHour = breakdown === "hour" ? num(pick(sources, ["hour", "hourOfDay", "hour_of_day"])) : null;
    const hour = rawHour === null ? null : Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : undefined;
    const usd = num(pick(sources, ["cost", "spend"]));
    const micros = num(pick(sources, ["costMicros", "cost_micros"]));
    const cost = usd !== undefined ? usd : micros !== undefined ? micros / 1_000_000 : undefined;
    if (!date || hour === undefined || cost === undefined || cost < 0) {
      skipped++;
      continue;
    }
    const clicks = Math.max(0, Math.round(num(pick(sources, ["clicks"])) ?? 0));
    const impressions = Math.max(0, Math.round(num(pick(sources, ["impressions"])) ?? 0));
    const key = `${date}|${hour}`;
    const prev = merged.get(key);
    merged.set(key, prev
      ? { ...prev, cost: prev.cost + cost, clicks: prev.clicks + clicks, impressions: prev.impressions + impressions }
      : { brand_id: brandId, date, hour, cost, clicks, impressions });
  }
  const rows = [...merged.values()]
    .map((r) => ({ ...r, cost: Math.round(r.cost * 1_000_000) / 1_000_000 }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.hour ?? -1) - (b.hour ?? -1));
  return { rows, skipped };
}

async function runAdkitCli(args) {
  const { stdout } = await exec("adkit", args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return stdout;
}

/**
 * The whole job. `runAdkit(args) -> stdout` and `fetchImpl` are injectable so tests never call
 * AdKit or core. Returns the number of failures (brands plus POSTs).
 */
export async function syncSpend({
  baseUrl, token, breakdown = "hour", fallbackProject, dryRun = false,
  runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error,
}) {
  const origin = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetchImpl(`${origin}/api/conversions/routing`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`routing: HTTP ${res.status}`);
  const routing = await res.json();
  if (routing === null || typeof routing !== "object" || Array.isArray(routing)) throw new Error("routing: not a JSON object");

  let failures = 0;
  const rows = [];
  const accounts = new Map();
  for (const [brandId, route] of Object.entries(routing)) {
    if (accounts.has(route.account)) {
      error(`spend-sync: ${brandId} shares account ${route.account} with ${accounts.get(route.account)}; account-level spend would count twice, skipped`);
      failures++;
      continue;
    }
    accounts.set(route.account, brandId);
    try {
      const out = parseAdkitJson(await runAdkit(adkitArgsFor(route, breakdown, fallbackProject)));
      if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error).slice(0, 200));
      const mapped = spendRowsFromAdkit(out, brandId, breakdown);
      log(`spend-sync: ${brandId} rows=${mapped.rows.length} skipped=${mapped.skipped}`);
      if (dryRun) for (const row of mapped.rows) log(JSON.stringify(row));
      rows.push(...mapped.rows);
    } catch (e) {
      error(`spend-sync: ${brandId} adkit failed: ${e?.message || e}`);
      failures++;
    }
  }
  if (dryRun) {
    log(`spend-sync: dry run, ${rows.length} row(s) not sent`);
    return failures;
  }

  let sent = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const post = await fetchImpl(`${origin}/api/spend/ingest`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ rows: chunk }),
      signal: AbortSignal.timeout(30_000),
    });
    if (post.ok) sent += chunk.length;
    else {
      error(`spend-sync: ingest HTTP ${post.status}: ${(await post.text()).slice(0, 300)}`);
      failures++;
    }
  }
  log(`spend-sync: sent ${sent} row(s) for ${accounts.size} brand(s)`);
  return failures;
}

async function main() {
  const { FORM_BASE_URL, DRAIN_TOKEN, GOOGLE_PROJECT, ADKIT_PROJECT } = process.env;
  const breakdown = process.env.SPEND_BREAKDOWN || "hour";
  if (!FORM_BASE_URL || !DRAIN_TOKEN) {
    console.error("spend-sync: missing env FORM_BASE_URL or DRAIN_TOKEN");
    process.exit(1);
  }
  if (breakdown !== "hour" && breakdown !== "day") {
    console.error("spend-sync: SPEND_BREAKDOWN must be hour or day");
    process.exit(1);
  }
  try {
    const failures = await syncSpend({
      baseUrl: FORM_BASE_URL, token: DRAIN_TOKEN, breakdown,
      fallbackProject: GOOGLE_PROJECT || ADKIT_PROJECT, dryRun: process.argv.includes("--dry-run"),
    });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`spend-sync: ${e?.message || e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
