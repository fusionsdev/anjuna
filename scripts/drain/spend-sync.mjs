#!/usr/bin/env node
/**
 * spend-sync: copy each brand's Google Ads spend from AdKit into core (FUS-368).
 *
 *   node spend-sync.mjs [--dry-run] [--from YYYY-MM-DD [--to YYYY-MM-DD]]
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * Optional: GOOGLE_PROJECT / ADKIT_PROJECT (fallback --project, as in drain.mjs) and
 * SPEND_BREAKDOWN = hour (default, one row per day and hour) or day (one whole-day row per day).
 *
 *   1. GET ${FORM_BASE_URL}/api/conversions/routing: brand_id -> { account, project }.
 *   2. Per brand and per date (yesterday and today, UTC; AdKit 1.13.54 results has no list or
 *      --level): adkit manage google results --account <account> --breakdown <hour|day>
 *      --from <date> --to <date> --json [--project <project>]. One date per call, because an hour
 *      breakdown over several days would sum by hour of day. Hour rows carry no date, so the
 *      call's date is stamped on them.
 *   3. Map the output to { brand_id, date, hour, cost, currency, clicks, impressions } rows. cost is in
 *      the account's billing currency. results carries no currency field, so it comes from
 *      adkit manage google accounts list --json [--project <project>], asked once per project per run.
 *      A failed or unparsable list (no account with a currency) fails every brand of that project and
 *      sends none of their rows, because a row without currency is stored as THB and would overwrite
 *      a stored USD row. An account listed in a currency other than THB or USD fails its brand. An
 *      account a parsed list does not name sends rows without currency (core stores THB) and a warning.
 *   4. POST them to ${FORM_BASE_URL}/api/spend/ingest in chunks; core upserts, so re-sending a
 *      day replaces its values and every run can resend the whole window AdKit returns.
 * --dry-run prints the mapped rows per brand and POSTs nothing.
 * One failing brand does not stop the others; any failure makes the exit code 1.
 * Shared accounts instead list daily campaigns and fetch hours per positive-cost campaign, then
 * POST /api/spend/campaign-ingest (5000 rows per request). See README for offset configuration.
 *
 * Plain Node 20, no dependencies. drain.mjs is not touched; run.sh and scheduler.mjs call this hourly.
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { guardAdkit } from "./adkit-executor.mjs";

const exec = promisify(execFile);
const CHUNK = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}/;
/** The currencies core's ad_spend.currency accepts. */
const CURRENCIES = new Set(["THB", "USD"]);

/** Default date window remains yesterday and today in UTC; campaign hours use the configured offset. */
export function syncDates(now = new Date()) {
  const day = (d) => d.toISOString().slice(0, 10);
  return [day(new Date(now.getTime() - 86_400_000)), day(now)];
}

/** The adkit argv for one brand's account-level results on one date (AdKit CLI 1.13.54). */
export function adkitArgsFor(route, breakdown, fallbackProject, date) {
  const args = [
    "manage", "google", "results",
    "--account", route.account,
    "--breakdown", breakdown,
    "--from", date,
    "--to", date,
    "--json",
  ];
  const project = route.project || fallbackProject;
  if (project) args.push("--project", project);
  return args;
}

/** The adkit argv listing the Google Ads accounts of a project, with their billing currency. */
export function accountsListArgs(project) {
  const args = ["manage", "google", "accounts", "list", "--json"];
  if (project) args.push("--project", project);
  return args;
}

/** One date per call; hourly results have no campaign id, so bind it in the request. */
export function campaignResultsArgs(account, date, project, campaignId) {
  const args = ["manage", "google", "results", "campaigns", "--account", account];
  if (campaignId) args.push("--campaign", campaignId, "--breakdown", "hour", "--fields", "cost,clicks,impressions");
  args.push("--from", date, "--to", date, "--limit", "500", "--json");
  if (project) args.push("--project", project);
  return args;
}

function offsets(defaultValue, overrides) {
  const valid = n => Number.isInteger(n) && n >= -720 && n <= 840;
  const fallback = defaultValue === undefined ? 420 : /^-?\d+$/.test(defaultValue) ? Number(defaultValue) : NaN;
  let byAccount;
  try { byAccount = overrides === undefined ? {} : JSON.parse(overrides); }
  catch { throw new Error("invalid UTC offset overrides JSON"); }
  if (!valid(fallback) || !byAccount || typeof byAccount !== "object" || Array.isArray(byAccount)
    || Object.entries(byAccount).some(([account, n]) => !/^\d{10}$/.test(account) || !valid(n))) {
    throw new Error("UTC offset must be an integer from -720 to 840 keyed by 10 digit account");
  }
  return account => byAccount[account] ?? fallback;
}

export function dateRange(from, to, now) {
  if (from === undefined && to === undefined) return syncDates(now);
  const end = to ?? now.toISOString().slice(0, 10);
  const valid = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (!valid(from) || !valid(end) || from > end) throw new Error("invalid --from/--to date range");
  const dates = [];
  for (let time = Date.parse(from); time <= Date.parse(end); time += 86_400_000) dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
}

function campaignOutput(stdout) {
  const out = parseAdkitJson(stdout);
  if (out?.error) throw new Error(JSON.stringify(out.error).slice(0, 200));
  if (out?.warnings?.some(w => w.code === "row_limit_reached")) throw new Error("row_limit_reached: incomplete campaign results");
  if (!Array.isArray(out?.results)) throw new Error("missing campaign results array");
  return out.results;
}

export function campaignRowsFromAdkit(items, campaignId, date) {
  return items.map(item => {
    const hour = item.hour ?? null;
    if (!(hour === null || Number.isInteger(hour) && hour >= 0 && hour <= 23)
      || !Number.isFinite(item.cost) || item.cost < 0
      || !Number.isInteger(item.clicks) || item.clicks < 0
      || !Number.isInteger(item.impressions) || item.impressions < 0) throw new Error("invalid campaign metrics");
    return { campaign_id: campaignId, date, hour, cost: item.cost, clicks: item.clicks, impressions: item.impressions };
  });
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

const accountKey = (id) => String(id ?? "").replace(/\D/g, "");

/**
 * Account id (digits only, so 123-456-7890 matches 1234567890) to upper-case currency code, from
 * accounts list output. Reads the id from id / account / accountId / customerId and the currency from
 * currency / currencyCode / currency_code, on the item or its `customer` object.
 */
export function accountCurrencies(out) {
  const items = Array.isArray(out) ? out : Array.isArray(out?.accounts) ? out.accounts : resultRows(out);
  const currencies = new Map();
  for (const item of items) {
    const sources = [item, item?.customer];
    const id = accountKey(pick(sources, ["id", "account", "accountId", "account_id", "customerId", "customer_id"]));
    const currency = pick(sources, ["currency", "currencyCode", "currency_code"]);
    if (id && typeof currency === "string" && currency.trim()) currencies.set(id, currency.trim().toUpperCase());
  }
  return currencies;
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
 * `segments`, cost from `cost` (account currency) or `costMicros` / `cost_micros` (micros), clicks and
 * impressions from the row or its `metrics`. Rows sharing a date and hour are summed. Returns the
 * rows plus how many input rows were skipped for a missing date, hour or cost. `defaultDate`
 * (YYYY-MM-DD) stamps rows that carry no date, as hour-breakdown rows do.
 */
export function spendRowsFromAdkit(out, brandId, breakdown, defaultDate) {
  const merged = new Map();
  let skipped = 0;
  for (const item of resultRows(out)) {
    const sources = [item, item?.segments, item?.metrics];
    const rawDate = pick(sources, ["date", "day"]);
    const date = typeof rawDate === "string" && DATE.test(rawDate) ? rawDate.slice(0, 10) : defaultDate && DATE.test(defaultDate) ? defaultDate.slice(0, 10) : null;
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
  runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error, now = new Date(),
  from, to, utcOffsetMinutes, utcOffsetByAccount,
}) {
  const offsetFor = offsets(utcOffsetMinutes, utcOffsetByAccount);
  const dates = dateRange(from, to, now);
  const runCampaign = guardAdkit(runAdkit);
  const origin = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetchImpl(`${origin}/api/conversions/routing`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`routing: HTTP ${res.status}`);
  const routing = await res.json();
  if (routing === null || typeof routing !== "object" || Array.isArray(routing)) throw new Error("routing: not a JSON object");

  // One accounts list per project for the whole run; null when the call failed or named no account.
  const currencyLists = new Map();
  const currencyListFor = async (route) => {
    const project = route.project || fallbackProject;
    const key = project ?? "";
    if (!currencyLists.has(key)) {
      let list = null;
      try {
        list = accountCurrencies(parseAdkitJson(await runAdkit(accountsListArgs(project))));
        if (list.size === 0) throw new Error("no account with a currency in the output");
      } catch (e) {
        list = null;
        error(`spend-sync: accounts list failed: ${e?.message || e}${project ? ` (project ${project})` : ""}`);
      }
      currencyLists.set(key, list);
    }
    return currencyLists.get(key);
  };

  let failures = 0;
  const rows = [];
  const campaignBatches = [];
  const accounts = new Map();
  const accountBrands = new Map();
  for (const route of Object.values(routing)) {
    const key = accountKey(route.account);
    accountBrands.set(key, (accountBrands.get(key) ?? 0) + 1);
  }
  for (const [brandId, route] of Object.entries(routing)) {
    const account = accountKey(route.account);
    if (accounts.has(account)) continue;
    accounts.set(account, brandId);
    const list = await currencyListFor(route);
    if (list === null) {
      error(`spend-sync: ${brandId} skipped: no accounts list to read the currency of account ${route.account}`);
      failures++;
      continue;
    }
    const currency = list.get(accountKey(route.account));
    const shared = accountBrands.get(account) > 1;
    if (shared && currency === undefined) {
      error(`spend-sync: account ${account} missing currency; campaign spend skipped`);
      failures++;
      continue;
    }
    if (currency === undefined) {
      error(`spend-sync: ${brandId} account ${route.account} has no currency in accounts list; core stores THB`);
    } else if (!CURRENCIES.has(currency)) {
      error(`spend-sync: ${brandId} account ${route.account} bills in ${currency}; core stores THB or USD only, skipped`);
      failures++;
      continue;
    }
    if (shared) {
      const campaignRows = [];
      for (const date of dates) {
        try {
          const campaigns = campaignOutput(await runCampaign(campaignResultsArgs(account, date, route.project || fallbackProject)));
          for (const campaign of campaigns) {
            try {
              if (typeof campaign.id !== "string" || !/^\d+$/.test(campaign.id)) throw new Error("missing campaign id");
              if (!Number.isFinite(campaign.cost) || campaign.cost < 0) throw new Error("invalid campaign cost");
              if (campaign.cost === 0) continue;
              const hours = campaignOutput(await runCampaign(campaignResultsArgs(account, date, route.project || fallbackProject, campaign.id)));
              if (hours.some(row => row.hour === undefined || row.hour === null)) throw new Error("missing campaign hour");
              campaignRows.push(...campaignRowsFromAdkit(hours.length ? hours : [{ ...campaign, hour: null }], campaign.id, date));
            } catch (e) {
              failures++;
              error(`spend-sync: account ${account} campaign ${campaign.id ?? "unknown"} ${date}: ${e?.message || e}`);
            }
          }
        } catch (e) {
          failures++;
          error(`spend-sync: account ${account} ${date}: ${e?.message || e}`);
        }
      }
      log(`spend-sync: account ${account} campaign rows=${campaignRows.length}`);
      if (dryRun) for (const row of campaignRows) log(JSON.stringify({ account, currency, utc_offset_minutes: offsetFor(account), ...row }));
      campaignBatches.push({ account, currency, utc_offset_minutes: offsetFor(account), rows: campaignRows });
      continue;
    }
    try {
      const brandRows = [];
      let skipped = 0;
      for (const date of dates) {
        const out = parseAdkitJson(await runAdkit(adkitArgsFor(route, breakdown, fallbackProject, date)));
        if (out && !Array.isArray(out) && out.error) throw new Error(`${date}: ${String(out.error).slice(0, 200)}`);
        const mapped = spendRowsFromAdkit(out, brandId, breakdown, date);
        brandRows.push(...(currency ? mapped.rows.map((row) => ({ ...row, currency })) : mapped.rows));
        skipped += mapped.skipped;
      }
      log(`spend-sync: ${brandId} rows=${brandRows.length} skipped=${skipped}`);
      if (dryRun) for (const row of brandRows) log(JSON.stringify(row));
      rows.push(...brandRows);
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
  for (const batch of campaignBatches) {
    for (let i = 0; i < batch.rows.length; i += 5000) {
      const chunk = batch.rows.slice(i, i + 5000);
      try {
        const post = await fetchImpl(`${origin}/api/spend/campaign-ingest`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ...batch, rows: chunk }), signal: AbortSignal.timeout(30_000),
        });
        if (!post.ok) throw new Error(`HTTP ${post.status}: ${(await post.text()).slice(0, 300)}`);
        if ((await post.json())?.status !== "accepted") throw new Error("response not accepted");
        sent += chunk.length;
      } catch (e) {
        failures++;
        error(`spend-sync: campaign ingest ${batch.account}: ${e?.message || e}`);
      }
    }
  }
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
      from: process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] ?? "" : undefined,
      to: process.argv.includes("--to") ? process.argv[process.argv.indexOf("--to") + 1] ?? "" : undefined,
      utcOffsetMinutes: process.env.ADKIT_UTC_OFFSET_MINUTES,
      utcOffsetByAccount: process.env.ADKIT_UTC_OFFSET_BY_ACCOUNT,
    });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`spend-sync: ${e?.message || e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
