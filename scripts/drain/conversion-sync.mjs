#!/usr/bin/env node
/**
 * conversion-sync: create the missing Google Ads conversion action per brand through AdKit (FUS-384).
 *
 *   node conversion-sync.mjs [--dry-run]
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * Optional: GOOGLE_PROJECT / ADKIT_PROJECT (fallback --project, as in drain.mjs).
 *
 *   1. GET ${FORM_BASE_URL}/api/conversions/setup/pending: brands with an account and no action.
 *   2. Per brand: adkit manage google conversions list --account <account> --limit 500 --json.
 *   3. Pick the name: the stored name from pending, else cv- plus 16 hex not present in the account.
 *   4. POST /api/conversions/setup/claim stores the name in core before any create.
 *   5. Name already in the account (a crashed earlier run): adopt its id. Otherwise
 *      adkit manage google conversions create ... --publish --json and read the new id. A duplicate-name
 *      error lists again and adopts that id.
 *   6. POST /api/conversions/setup/result with the id, or with the error text (500 characters at most).
 * --dry-run runs steps 1 to 3, prints one plan line per brand and sends no claim, create or result.
 * One failing brand does not stop the others; any failure makes the exit code 1.
 *
 * Plain Node 20, no dependencies. drain.mjs is not touched; run.sh and scheduler.mjs call this every tick.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NAME_TRIES = 5;
const ERROR_MAX = 500;
const ID = /^\d{1,20}$/;
const NAME = /^cv-[0-9a-f]{16}$/;
const DUPLICATE =/duplicate|already[\s_-]?exist/i;

/** The conversion name: opaque, never derived from a brand id, name or host. */
export function generateName(bytes = randomBytes) {
  return `cv-${bytes(8).toString("hex")}`;
}

/** A generated name that is not in `existing` (a Map or Set of names); throws after 5 collisions. */
export function pickUniqueName(existing, generate = generateName) {
  for (let i = 0; i < NAME_TRIES; i++) {
    const name = generate();
    if (!existing.has(name)) return name;
  }
  throw new Error(`no unique conversion name after ${NAME_TRIES} tries`);
}

const withProject = (args, route, fallbackProject) => {
  const project = route.project || fallbackProject;
  if (project) args.push("--project", project);
  return args;
};

/** The adkit argv that creates and publishes one conversion action. Every create flag lives here. */
export function conversionCreateArgs(route, name, fallbackProject) {
  const data = {
    name, type: "upload_clicks", category: "purchase", status: "enabled", countingType: "one",
    defaultValue: 0, currency: "USD", alwaysUseDefaultValue: false, isPrimary: true,
  };
  return withProject([
    "manage", "google", "conversions", "create",
    "--account", route.account,
    "--data", JSON.stringify(data),
    "--publish",
    "--json",
  ], route, fallbackProject);
}

/** The adkit argv that lists the account's existing conversion actions. */
export function conversionListArgs(route, fallbackProject) {
  return withProject([
    "manage", "google", "conversions", "list",
    "--account", route.account,
    "--limit", "500",
    "--json",
  ], route, fallbackProject);
}

/** Parse the JSON tail of adkit stdout (AdKit may print a notice line before the JSON). */
export function parseAdkitJson(stdout) {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((i) => i >= 0);
  return JSON.parse(starts.length ? stdout.slice(Math.min(...starts)) : stdout);
}

/** Map of conversion name -> platformId (string) from the list output; entries without both, and removed actions, are skipped. */
export function conversionsByName(out) {
  const list = Array.isArray(out) ? out : Array.isArray(out?.conversions) ? out.conversions : [];
  const map = new Map();
  for (const item of list) {
    if (String(item?.status ?? "").toLowerCase() === "removed") continue;
    const id = item?.platformId === undefined || item?.platformId === null ? "" : String(item.platformId);
    if (typeof item?.name === "string" && ID.test(id)) map.set(item.name, id);
  }
  return map;
}

/**
 * The new conversion id from the create output, at the top level or under conversion / result / data.
 * Specific keys (`platformId`, `conversionActionId`) win at every level before the generic `id`, then
 * a `customers/<c>/conversionActions/<id>` resource name. Throws when no id is found or the value is
 * not 1 to 20 digits.
 */
export function createdConversionId(out) {
  const holders = [out, out?.conversion, out?.result, out?.data].filter((h) => h && typeof h === "object");
  for (const key of ["platformId", "conversionActionId", "id", "resourceName"]) {
    for (const holder of holders) {
      const value = holder[key];
      if (value === undefined || value === null || value === "") continue;
      const text = String(value);
      const id = /conversionActions\/(\d+)$/.exec(text)?.[1] ?? text;
      if (!ID.test(id)) throw new Error(`create returned an invalid conversion id: ${text.slice(0, 60)}`);
      return id;
    }
  }
  throw new Error("create returned no conversion id");
}

async function runAdkitCli(args) {
  const { stdout } = await exec("adkit", args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return stdout;
}

// execFile puts the whole argv in e.message, so prefer what the CLI printed (stderr, stdout).
const errorFull = (e) => {
  const printed = [e?.stderr, e?.stdout].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
  return String(printed || e?.message || e || "unknown error") || "unknown error";
};
const errorText = (e) => errorFull(e).slice(0, ERROR_MAX);

/**
 * The whole job. `runAdkit(args) -> stdout` and `fetchImpl` are injectable so tests never call
 * AdKit or core. Returns the number of failures.
 */
export async function syncConversions({
  baseUrl, token, fallbackProject, dryRun = false, generate = generateName,
  runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error,
}) {
  const origin = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const post = (path, body) => fetchImpl(`${origin}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const res = await fetchImpl(`${origin}/api/conversions/setup/pending`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`pending: HTTP ${res.status}`);
  const pending = await res.json();
  if (!Array.isArray(pending?.brands)) throw new Error("pending: no brands array");

  let created = 0;
  let failures = 0;
  const list = async (route) => {
    const out = parseAdkitJson(await runAdkit(conversionListArgs(route, fallbackProject)));
    if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
    return conversionsByName(out);
  };

  for (const brand of pending.brands) {
    const id = brand.brand_id;
    try {
      let route = { account: brand.account, project: brand.project };
      let existing = await list(route);
      let name = brand.name ?? pickUniqueName(existing, generate);
      if (!NAME.test(String(name))) throw new Error(`invalid conversion name: ${String(name).slice(0, 40)}`);
      if (dryRun) {
        log(existing.has(name)
          ? `conversion-sync: ${id} plan adopt ${existing.get(name)} name=${name}`
          : `conversion-sync: ${id} plan create name=${name}`);
        continue;
      }

      const claimRes = await post("/api/conversions/setup/claim", { brand_id: id, name });
      if (claimRes.status === 409) {
        log(`conversion-sync: ${id} busy`);
        continue;
      }
      if (!claimRes.ok) throw new Error(`claim: HTTP ${claimRes.status}: ${(await claimRes.text()).slice(0, 200)}`);
      const claim = await claimRes.json();
      name = claim.name;
      route = { account: claim.account, project: claim.project };

      // After a successful claim every path posts exactly one result, so nothing below may escape this try.
      let conversionId;
      let how = "adopted";
      let failure = "";
      try {
        if (!NAME.test(String(name))) throw new Error(`claimed name is invalid: ${String(name).slice(0, 40)}`);
        if (claim.account !== brand.account || (claim.project ?? null) !== (brand.project ?? null)) existing = await list(route);
        conversionId = existing.get(name);
        if (!conversionId) {
          try {
            const out = parseAdkitJson(await runAdkit(conversionCreateArgs(route, name, fallbackProject)));
            if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
            conversionId = createdConversionId(out);
            how = "created";
          } catch (e) {
            failure = errorText(e);
            if (DUPLICATE.test(errorFull(e))) {
              try {
                existing = await list(route);
                conversionId = existing.get(name);
                if (conversionId) {
                  how = "adopted";
                  failure = "";
                }
              } catch (listError) {
                failure = `${failure.slice(0, 300)}; list: ${errorText(listError)}`.slice(0, ERROR_MAX);
              }
            }
          }
        }
      } catch (e) {
        conversionId = undefined;
        failure = errorText(e);
      }

      const result = await post("/api/conversions/setup/result", conversionId
        ? { brand_id: id, claim_id: claim.claim_id, conversion_action_id: conversionId }
        : { brand_id: id, claim_id: claim.claim_id, error: failure || "conversion id not found" });
      if (result.status === 409) {
        error(`conversion-sync: ${id} result stale${conversionId ? ` (orphan conversion ${conversionId} name=${name})` : ""}`);
        failures++;
      } else if (!result.ok) {
        error(`conversion-sync: ${id} result HTTP ${result.status}: ${(await result.text()).slice(0, 300)}`);
        failures++;
      } else if (conversionId) {
        log(`conversion-sync: ${id} ${how} ${conversionId} name=${name}`);
        created++;
      } else {
        error(`conversion-sync: ${id} failed: ${failure || "conversion id not found"}`);
        failures++;
      }
    } catch (e) {
      error(`conversion-sync: ${id} failed: ${e?.message || e}`);
      failures++;
    }
  }
  if (dryRun) log(`conversion-sync: dry run, ${pending.brands.length} brand(s) planned, nothing sent`);
  else log(`conversion-sync: ${created} created, ${failures} failed`);
  return failures;
}

async function main() {
  const { FORM_BASE_URL, DRAIN_TOKEN, GOOGLE_PROJECT, ADKIT_PROJECT } = process.env;
  if (!FORM_BASE_URL || !DRAIN_TOKEN) {
    console.error("conversion-sync: missing env FORM_BASE_URL or DRAIN_TOKEN");
    process.exit(1);
  }
  try {
    const failures = await syncConversions({
      baseUrl: FORM_BASE_URL, token: DRAIN_TOKEN,
      fallbackProject: GOOGLE_PROJECT || ADKIT_PROJECT, dryRun: process.argv.includes("--dry-run"),
    });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`conversion-sync: ${e?.message || e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
