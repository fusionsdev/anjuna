#!/usr/bin/env node
/**
 * adkit-executor: run the AdKit jobs the panel queued in core (panel redesign T9, ADR-0005).
 *
 *   node adkit-executor.mjs
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * Optional: GOOGLE_PROJECT / ADKIT_PROJECT (fallback --project, as in drain.mjs).
 *
 *   1. GET  ${FORM_BASE_URL}/api/adkit/jobs/pending
 *   2. POST /api/adkit/jobs/claim per job. A 409 means another run holds it: skip.
 *   3. Run the job through adkit. Only the allowlisted command shapes can run (ALLOWED_COMMANDS). Anything else
 *      is rejected before a process is spawned. `campaigns create` and `campaigns update` also need the job kind:
 *      a draft is created without --publish, and only campaign.enable may publish ENABLED.
 *   4. POST /api/adkit/jobs/result with the result, or with the error text (500 characters at most).
 *
 * conversion_action.create: list the account's actions; when the job's name is already there (a crashed earlier
 * run), adopt that id. Otherwise create it with --publish. A duplicate-name error lists again and adopts the id
 * (ADR-0005 decision 9, the same rule as conversion-sync.mjs).
 *
 * campaign.draft.create: the same adopt-by-name rule over `campaigns list`, then `campaigns create` WITHOUT
 * --publish, so AdKit keeps a draft. campaign.enable / campaign.pause: `campaigns update` with exactly
 * {"status":"ENABLED"} / {"status":"PAUSED"} and --publish. campaign.update_budget: `campaigns update` with exactly
 * {"dailyBudget":n} and no --publish. There is no delete, no raw API request and no passthrough.
 *
 * Plain Node 20, no dependencies. drain.mjs, conversion-sync.mjs and spend-sync.mjs are not touched.
 * Install and scheduling on the VPS are owner actions (Wave 4 gate).
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  conversionCreateArgs,
  conversionListArgs,
  conversionsByName,
  createdConversionId,
  parseAdkitJson,
} from "./conversion-sync.mjs";

const exec = promisify(execFile);
const ERROR_MAX = 500;
/** Most time one adkit call may run (execFile timeout). */
const ADKIT_CALL_MS = 120_000;
const DUPLICATE = /duplicate|already[\s_-]?exist/i;

/** `<resource> <verb>` after `manage google`. Nothing else may run. */
export const ALLOWED_COMMANDS = Object.freeze([
  "accounts list", "conversions list", "results list", "conversions create",
  "campaigns list", "campaigns create", "campaigns update", "results campaigns",
]);

/** A value argument: never empty and never option-like, so it cannot smuggle a flag such as `--help`. */
const value = (pattern) => (arg) => typeof arg === "string" && arg !== "" && !arg.startsWith("-") && pattern.test(arg);
export const PROJECT_ARG = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ACCOUNT = value(/^\d{10}$/);
const PROJECT = value(PROJECT_ARG);
const DATE = value(/^\d{4}-\d{2}-\d{2}$/);
const BREAKDOWN = value(/^(hour|day)$/);
const CAMPAIGN = value(/^\d{1,20}$/);
const PAGE_TOKEN = value(/^[A-Za-z0-9_=.~+/-]{1,512}$/);
const parseObject = (arg) => {
  if (!value(/^\{/)(arg)) return null;
  try {
    const parsed = JSON.parse(arg);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const DATA = (arg) => parseObject(arg) !== null;

/**
 * The exact argument vectors of each allowed command: literal strings and value checks, in order. A trailing
 * `--project <p>` is the only optional part. Any other flag, an extra argument or a missing one is rejected.
 * `campaigns update` has two shapes: a status change with --publish, a budget change without it.
 */
const SHAPES = {
  "accounts list": [["manage", "google", "accounts", "list", "--json"]],
  "conversions list": [["manage", "google", "conversions", "list", "--account", ACCOUNT, "--limit", "500", "--json"]],
  "results list": [["manage", "google", "results", "list", "--account", ACCOUNT, "--breakdown", BREAKDOWN, "--from", DATE, "--to", DATE, "--json"]],
  "conversions create": [["manage", "google", "conversions", "create", "--account", ACCOUNT, "--data", DATA, "--publish", "--json"]],
  "campaigns list": [
    ["manage", "google", "campaigns", "list", "--account", ACCOUNT, "--limit", "500", "--json"],
    ["manage", "google", "campaigns", "list", "--account", ACCOUNT, "--limit", "500", "--page-token", PAGE_TOKEN, "--json"],
  ],
  "campaigns create": [["manage", "google", "campaigns", "create", "--account", ACCOUNT, "--data", DATA, "--json"]],
  "campaigns update": [
    ["manage", "google", "campaigns", "update", "--account", ACCOUNT, "--campaign", CAMPAIGN, "--data", DATA, "--publish", "--json"],
    ["manage", "google", "campaigns", "update", "--account", ACCOUNT, "--campaign", CAMPAIGN, "--data", DATA, "--json"],
  ],
};

const matches = (shape, args) => args.length === shape.length
  && shape.every((part, i) => (typeof part === "string" ? args[i] === part : part(args[i])));

/** True when the value holds a `status` or `publish` key at any depth. */
const holdsStatus = (v) => v !== null && typeof v === "object"
  && (Array.isArray(v) ? v.some(holdsStatus) : Object.entries(v).some(([k, x]) => k === "status" || k === "publish" || holdsStatus(x)));

const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/**
 * The job-kind rule of the commands that write campaigns. The argv shape alone is not enough: the data and the
 * --publish flag must be the ones that kind is allowed to send.
 */
function kindAllows(command, args, kind) {
  if (command !== "campaigns create" && command !== "campaigns update") return true;
  const data = parseObject(args[args.indexOf("--data") + 1]);
  if (data === null) return false;
  if (command === "campaigns create") return kind === "campaign.draft.create" && !holdsStatus(data);
  const publish = args.includes("--publish");
  if (kind === "campaign.enable") return publish && sameKeys(data, ["status"]) && data.status === "ENABLED";
  if (kind === "campaign.pause") return publish && sameKeys(data, ["status"]) && data.status === "PAUSED";
  if (kind === "campaign.update_budget") {
    return !publish && sameKeys(data, ["dailyBudget"]) && typeof data.dailyBudget === "number"
      && Number.isFinite(data.dailyBudget) && data.dailyBudget > 0 && data.dailyBudget <= BUDGET_MAX;
  }
  return false;
}
const BUDGET_MAX = 1_000_000;
const campaignBase = ["manage", "google", "results", "campaigns", "--account", ACCOUNT];
const campaignTail = ["--from", DATE, "--to", DATE, "--limit", "500", "--json"];
const campaignShapes = [
  [...campaignBase, ...campaignTail],
  [...campaignBase, "--campaign", value(/^\d+$/), "--breakdown", "hour", "--fields", "cost,clicks,impressions", ...campaignTail],
];

export class CommandNotAllowedError extends Error {}

/**
 * Throws unless argv is exactly one allowed command shape, with or without a trailing `--project <p>`, and the job
 * kind may send it. `kind` is the job's kind; the campaign write commands are refused without one.
 */
export function assertAllowed(args, kind) {
  const command = Array.isArray(args) ? `${args[2]} ${args[3]}` : "";
  const shapes = !Array.isArray(args) ? [] : command === "results campaigns" ? campaignShapes : Object.hasOwn(SHAPES, command) ? SHAPES[command] : [];
  const ok = shapes.length > 0 && args.every((arg) => typeof arg === "string")
    && shapes.some((shape) => matches(shape, args) || matches([...shape, "--project", PROJECT], args))
    && kindAllows(command, args, kind);
  if (!ok) {
    const shown = Array.isArray(args) ? args.slice(0, 4).map(String).join(" ") : String(args);
    throw new CommandNotAllowedError(`adkit command not allowed: ${shown.slice(0, 80) || "(empty)"}`);
  }
}

/** Throws when a configured fallback project is option-like or malformed, before any job runs. */
export function assertProject(project) {
  if (project !== undefined && project !== null && project !== "" && !PROJECT(project)) {
    throw new CommandNotAllowedError(`invalid adkit project: ${String(project).slice(0, 64)}`);
  }
}

/** Wrap a runner so every call passes the allowlist first; a rejected command never reaches `run`. */
export function guardAdkit(run) {
  return async (args, kind) => {
    assertAllowed(args, kind);
    return run(args, kind);
  };
}

/** The adkit runner over an `execFile`-shaped function (promisified); tests pass a spy, main passes the real one. */
export function makeAdkitCli(execImpl) {
  return guardAdkit(async (args) => {
    const { stdout } = await execImpl("adkit", args, { maxBuffer: 16 * 1024 * 1024, timeout: ADKIT_CALL_MS });
    return stdout;
  });
}

/** The real runner: allowlist, then spawn `adkit` from PATH. */
export const runAdkitCli = makeAdkitCli(exec);

// execFile puts the whole argv in e.message, so prefer what the CLI printed (stderr, stdout).
const errorFull = (e) => {
  const printed = [e?.stderr, e?.stdout].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
  return String(printed || e?.message || e || "unknown error") || "unknown error";
};
const errorText = (e) => errorFull(e).slice(0, ERROR_MAX);

class JobFailure extends Error {
  constructor(message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

/** Create (or adopt) the job's conversion action. Returns the result body core stores. */
export async function runConversionActionCreate(payload, run, fallbackProject) {
  // Core validated the payload; the executor checks again before any value becomes an adkit argument.
  if (!/^\d{10}$/.test(String(payload?.account)) || !/^cv-[0-9a-f]{16}$/.test(String(payload?.name))
    || !(payload.project === null || payload.project === undefined || PROJECT(payload.project))) {
    throw new JobFailure("invalid conversion_action.create payload", false);
  }
  const route = { account: payload.account, project: payload.project };
  const list = async () => {
    const out = parseAdkitJson(await run(conversionListArgs(route, fallbackProject)));
    if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
    return conversionsByName(out);
  };
  const existing = await list();
  const known = existing.get(payload.name);
  if (known) return { conversion_action_id: known, name: payload.name, adopted: true };
  try {
    const out = parseAdkitJson(await run(conversionCreateArgs(route, payload.name, fallbackProject)));
    if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
    return { conversion_action_id: createdConversionId(out), name: payload.name, adopted: false };
  } catch (e) {
    if (e instanceof CommandNotAllowedError || !DUPLICATE.test(errorFull(e))) throw e;
    const adopted = (await list()).get(payload.name);
    if (!adopted) throw e;
    return { conversion_action_id: adopted, name: payload.name, adopted: true };
  }
}

// --- campaign jobs (T13 Part B) --------------------------------------------------------------------

const CAMPAIGN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}-search-[1-9][0-9]{0,3}$/;
const CAMPAIGN_ID = /^\d{1,20}$/;
const BID = { maximize_conversions: "MAXIMIZE_CONVERSIONS", maximize_clicks: "MAXIMIZE_CLICKS" };

const budgetOk = (n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= BUDGET_MAX && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const routeOk = (payload) => /^\d{10}$/.test(String(payload?.account))
  && (payload.project === null || payload.project === undefined || PROJECT(payload.project));
const refOk = (payload) => routeOk(payload) && CAMPAIGN_ID.test(String(payload?.campaign_id)) && CAMPAIGN_NAME.test(String(payload?.name));

function geoTargets(geo) {
  if (geo && typeof geo === "object" && sameKeys(geo, ["country"]) && /^[A-Z]{2}$/.test(String(geo.country))) return [{ country: geo.country }];
  if (geo && typeof geo === "object" && sameKeys(geo, ["city_code"]) && /^\d{1,10}$/.test(String(geo.city_code))) return [{ cityCode: geo.city_code }];
  return null;
}

function draftData(payload) {
  const geo = geoTargets(payload?.geo);
  const keywords = Array.isArray(payload?.keywords) && payload.keywords.length >= 1 && payload.keywords.length <= 200
    && payload.keywords.every((k) => typeof k === "string" && k.trim() !== "" && k.length <= 80 && !/\p{Cc}/u.test(k))
    ? payload.keywords : null;
  let finalUrl = null;
  try {
    finalUrl = new URL(String(payload?.final_url)).protocol === "https:" ? String(payload.final_url) : null;
  } catch {
    finalUrl = null;
  }
  if (!routeOk(payload) || !CAMPAIGN_NAME.test(String(payload?.name)) || !budgetOk(payload?.daily_budget)
    || !Object.hasOwn(BID, String(payload?.bid_strategy)) || !geo || !keywords || !finalUrl) return null;
  return {
    campaigns: [{
      name: payload.name, type: "SEARCH", dailyBudget: payload.daily_budget, biddingStrategy: BID[payload.bid_strategy],
      geoTargets: geo, keywords, finalUrl,
    }],
  };
}

const withRoute = (args, payload, fallbackProject) => {
  const project = payload.project || fallbackProject;
  if (project) args.push("--project", project);
  return args;
};


/** Upper-case status AdKit reports for a campaign row (ENABLED, PAUSED, DRAFT, REMOVED), or "" when absent. */
const rowStatus = (item) => String(item?.status ?? "").trim().toUpperCase();

/** Daily budget of a list row: dailyBudget, daily_budget, budget(.amount) or budgetAmountMicros / 1e6; null when absent. */
function rowBudget(item) {
  const micros = item?.budgetAmountMicros ?? item?.budget?.amountMicros;
  const raw = item?.dailyBudget ?? item?.daily_budget ?? (typeof item?.budget === "object" ? item?.budget?.amount : item?.budget)
    ?? (micros !== undefined && micros !== null ? Number(micros) / 1e6 : undefined);
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * One `campaigns list` output, validated. `ok` is false when the output has no rows array (an array, `campaigns` or
 * `data`), when any raw row lacks a string name or a numeric id, or when the next page token is neither absent nor a
 * string. `rawCount` counts the raw rows before any check, so a dropped row can never make a page look short.
 */
export function campaignPage(out) {
  const list = Array.isArray(out) ? out : Array.isArray(out?.campaigns) ? out.campaigns : Array.isArray(out?.data) ? out.data : null;
  if (!list) return { rows: [], rawCount: 0, ok: false, token: null };
  const rows = list.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item.platformId ?? item.campaignId ?? item.id;
    const id = raw === undefined || raw === null ? "" : String(raw);
    return typeof item.name === "string" && CAMPAIGN_ID.test(id)
      ? [{ id, name: item.name, status: rowStatus(item), dailyBudget: rowBudget(item) }] : [];
  });
  const t = Array.isArray(out) ? undefined
    : out.nextPageToken ?? out.next_page_token ?? out.pagination?.nextPageToken ?? out.pageInfo?.nextPageToken;
  const tokenOk = t === undefined || t === null || typeof t === "string";
  const token = typeof t === "string" && t !== "" ? t : null;
  // A next-page signal under a name the executor cannot follow (cursor, hasMore, hasNextPage, nextOffset, ...) means
  // more rows exist that this lookup cannot read: the page is not ok unless a known token is present.
  const strayMore = !token && !Array.isArray(out) && [out, out.pagination, out.pageInfo].some(morePageSignal);
  return { rows, rawCount: list.length, ok: rows.length === list.length && tokenOk && !strayMore, token };
}

const KNOWN_TOKEN_KEYS = new Set(["nextPageToken", "next_page_token"]);
const MORE_KEY = /cursor|next|more|offset|continu/i;

/** True when an object holds a truthy value under a pagination-like key other than the known token names. */
function morePageSignal(holder) {
  if (!holder || typeof holder !== "object" || Array.isArray(holder)) return false;
  return Object.entries(holder).some(([key, value]) => !KNOWN_TOKEN_KEYS.has(key) && MORE_KEY.test(key)
    && value !== null && value !== undefined && value !== false && value !== "" && value !== 0);
}

/** The parsed campaign rows of one `campaigns list` output (rows that do not parse are left out). */
export const campaignRows = (out) => campaignPage(out).rows;

const LIST_LIMIT = 500;
/** Most `campaigns list` pages one lookup reads (4,000 campaigns). Past it the lookup is incomplete. */
export const LIST_MAX_PAGES = 8;
/**
 * A job must post its result inside the 30 min claim lease, or another run may claim it again. A list page starts
 * only when its 120 s CLI timeout still ends before this deadline (from the claim); otherwise the lookup is incomplete.
 */
export const JOB_DEADLINE_MS = 25 * 60_000;

/**
 * Every campaign of the account across pages: `--limit 500`, then `--page-token <t>` while the output names a next
 * page. `complete` is true only when every page validated (campaignPage ok) and the last page has no next token and
 * fewer than 500 raw rows. A malformed page, a dropped row, a full page without a token (AdKit may not page) or more
 * than LIST_MAX_PAGES pages counts as incomplete, so no caller creates or reports NOT_FOUND from it.
 */
export async function listAllCampaigns(run, payload, fallbackProject, { now = Date.now, deadline = now() + JOB_DEADLINE_MS } = {}) {
  const rows = [];
  let token = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    if (now() + ADKIT_CALL_MS > deadline) return { rows, complete: false };
    const out = checked(await run(withRoute([
      "manage", "google", "campaigns", "list", "--account", payload.account, "--limit", String(LIST_LIMIT),
      ...(token ? ["--page-token", token] : []), "--json",
    ], payload, fallbackProject)));
    const page = campaignPage(out);
    rows.push(...page.rows);
    if (!page.ok) return { rows, complete: false };
    token = page.token;
    if (!token) return { rows, complete: page.rawCount < LIST_LIMIT };
  }
  return { rows, complete: false };
}

/** campaign.status_check: report what AdKit lists for the campaign id. NOT_FOUND only when the listing is complete. */
export async function runCampaignStatusCheck(payload, run, fallbackProject, { listCampaigns = listAllCampaigns, clock } = {}) {
  if (!refOk(payload)) throw new JobFailure("invalid campaign.status_check payload", false);
  const { rows, complete } = await listCampaigns(run, payload, fallbackProject, clock);
  const row = rows.find((r) => r.id === payload.campaign_id);
  if (!row) {
    if (!complete) throw new JobFailure("lookup_incomplete", false);
    return { campaign_id: payload.campaign_id, observed_status: "NOT_FOUND", daily_budget: null };
  }
  const observed = ["ENABLED", "PAUSED", "DRAFT", "REMOVED"].includes(row.status) ? row.status : null;
  if (!observed) throw new JobFailure(`status_unreadable: ${row.status.slice(0, 40) || "(none)"}`, false);
  return { campaign_id: payload.campaign_id, observed_status: observed, daily_budget: row.dailyBudget !== null && row.dailyBudget > 0 ? row.dailyBudget : null };
}

/** The new campaign id from the create output: platformId, campaignId, id or a campaigns/<id> resource name. */
export function createdCampaignId(out) {
  const first = (v) => (Array.isArray(v) ? v[0] : undefined);
  const holders = [out, out?.campaign, out?.result, out?.data, first(out?.campaigns), first(out?.results), first(out?.data), first(out)]
    .filter((h) => h && typeof h === "object" && !Array.isArray(h));
  for (const key of ["platformId", "campaignId", "id", "resourceName"]) {
    for (const holder of holders) {
      const raw = holder[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const id = /campaigns\/(\d+)$/.exec(String(raw))?.[1] ?? String(raw);
      if (CAMPAIGN_ID.test(id)) return id;
    }
  }
  throw new Error("adkit campaigns create returned no campaign id");
}

const checked = (stdout) => {
  const out = parseAdkitJson(stdout);
  if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
  return out;
};

/** Create (or adopt) the job's draft campaign. Never sends --publish. */
/**
 * Create (or adopt) the job's draft campaign. Never sends --publish. The name is looked up across every page first;
 * when the lookup cannot prove the name is absent, the job fails for good instead of risking a second campaign.
 */
export async function runCampaignDraftCreate(payload, run, fallbackProject, { listCampaigns = listAllCampaigns, clock } = {}) {
  const data = draftData(payload);
  if (!data) throw new JobFailure("invalid campaign.draft.create payload", false);
  const lookup = async () => {
    const { rows, complete } = await listCampaigns(run, payload, fallbackProject, clock);
    const row = rows.find((r) => r.name === payload.name && r.status !== "REMOVED");
    if (!row && !complete) throw new JobFailure("lookup_incomplete", false);
    return row ?? null;
  };
  // Adopt only a full match: a campaign with this name but another status or budget is not this job's draft.
  const adopt = (row) => {
    if (row.status !== "PAUSED" && row.status !== "DRAFT") {
      throw new JobFailure(`adopt_status_${row.status.toLowerCase().replace(/[^a-z]/g, "") || "unreadable"}`, false);
    }
    if (row.dailyBudget === null || Math.round(row.dailyBudget * 100) !== Math.round(payload.daily_budget * 100)) {
      throw new JobFailure("adopt_budget_mismatch", false);
    }
    return { campaign_id: row.id, name: payload.name, adopted: true, status: row.status, daily_budget: payload.daily_budget };
  };
  const known = await lookup();
  if (known) return adopt(known);
  let out;
  try {
    out = checked(await run(withRoute([
      "manage", "google", "campaigns", "create", "--account", payload.account, "--data", JSON.stringify(data), "--json",
    ], payload, fallbackProject)));
  } catch (e) {
    if (e instanceof CommandNotAllowedError || e instanceof JobFailure) throw e;
    // The create started, so it may have made the campaign. A retry could create a second one if `campaigns list`
    // does not show it, so every failure from here on is final; only a duplicate the lookup can see is adopted.
    let adopted = null;
    try {
      adopted = DUPLICATE.test(errorFull(e)) ? await lookup() : null;
    } catch (lookupError) {
      // A JobFailure (lookup_incomplete) is already final; any other lookup error is made final too.
      if (lookupError instanceof JobFailure) throw lookupError;
      throw new JobFailure(`create_failed: ${errorText(e)}; lookup: ${errorText(lookupError)}`.slice(0, ERROR_MAX), false);
    }
    if (!adopted) throw new JobFailure(`create_failed: ${errorText(e)}`.slice(0, ERROR_MAX), false);
    return adopt(adopted);
  }
  try {
    return { campaign_id: createdCampaignId(out), name: payload.name, adopted: false, status: "DRAFT", daily_budget: payload.daily_budget };
  } catch (e) {
    // The create may have succeeded: a retry must adopt by name, never create again blindly.
    throw new JobFailure(`created_without_id: ${String(e?.message ?? e).slice(0, 200)}`, false);
  }
}

const updateArgs = (payload, data, publish, fallbackProject) => withRoute([
  "manage", "google", "campaigns", "update", "--account", payload.account, "--campaign", payload.campaign_id,
  "--data", JSON.stringify(data), ...(publish ? ["--publish"] : []), "--json",
], payload, fallbackProject);

const statusJob = (kind, status) => async (payload, run, fallbackProject) => {
  if (!refOk(payload)) throw new JobFailure(`invalid ${kind} payload`, false);
  checked(await run(updateArgs(payload, { status }, true, fallbackProject)));
  return { campaign_id: payload.campaign_id, status };
};

export const runCampaignEnable = statusJob("campaign.enable", "ENABLED");
export const runCampaignPause = statusJob("campaign.pause", "PAUSED");

/** Set the daily budget. No --publish: the guard refuses a budget change that publishes. */
/**
 * Set the daily budget, then read it back from `campaigns list`. Done only when AdKit lists the new budget.
 * Without --publish AdKit may keep the change unapplied, so a mismatch or an unreadable listing fails the job
 * (non-retryable, after a write: core keeps the larger budget counted and queues a status check).
 */
export async function runCampaignUpdateBudget(payload, run, fallbackProject, { listCampaigns = listAllCampaigns, clock } = {}) {
  if (!refOk(payload) || !budgetOk(payload?.daily_budget)) throw new JobFailure("invalid campaign.update_budget payload", false);
  checked(await run(updateArgs(payload, { dailyBudget: payload.daily_budget }, false, fallbackProject)));
  const { rows } = await listCampaigns(run, payload, fallbackProject, clock);
  const row = rows.find((r) => r.id === payload.campaign_id);
  if (!row || row.dailyBudget === null) throw new JobFailure("budget_unverified", false);
  if (Math.round(row.dailyBudget * 100) !== Math.round(payload.daily_budget * 100)) {
    throw new JobFailure(`budget_not_applied: AdKit reports ${row.dailyBudget}`, false);
  }
  return { campaign_id: payload.campaign_id, daily_budget: payload.daily_budget };
}

/** Jobs whose lost outcome may have changed what a live campaign spends (core marks them unknown, not failed). */
const SPEND_KINDS = new Set(["campaign.enable", "campaign.update_budget"]);

const KINDS = {
  "conversion_action.create": runConversionActionCreate,
  "campaign.draft.create": runCampaignDraftCreate,
  "campaign.enable": runCampaignEnable,
  "campaign.pause": runCampaignPause,
  "campaign.update_budget": runCampaignUpdateBudget,
  "campaign.status_check": runCampaignStatusCheck,
};


/**
 * The whole run. `runAdkit(args) -> stdout` and `fetchImpl` are injectable so tests never call AdKit or core.
 * An injected runner is wrapped by the allowlist too. Returns the number of failed jobs.
 */
export async function executeJobs({
  baseUrl, token, fallbackProject, runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error,
  listCampaigns = listAllCampaigns, now = Date.now,
}) {
  assertProject(fallbackProject);
  const run = guardAdkit(runAdkit);
  const origin = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const post = (path, body) => fetchImpl(`${origin}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const res = await fetchImpl(`${origin}/api/adkit/jobs/pending`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`pending: HTTP ${res.status}`);
  const pending = await res.json();
  if (!Array.isArray(pending?.jobs)) throw new Error("pending: no jobs array");

  let done = 0;
  let failures = 0;
  for (const listed of pending.jobs) {
    const id = listed.id;
    try {
      const claimRes = await post("/api/adkit/jobs/claim", { job_id: id });
      if (claimRes.status === 409) {
        log(`adkit-executor: ${id} busy`);
        continue;
      }
      if (!claimRes.ok) throw new Error(`claim: HTTP ${claimRes.status}: ${(await claimRes.text()).slice(0, 200)}`);
      const claim = await claimRes.json();
      const job = claim.job;
      // Every lookup of this job ends before the deadline, so the result lands inside the claim lease.
      const clock = { now, deadline: now() + JOB_DEADLINE_MS };

      // After a successful claim every path posts exactly one result, so nothing below may escape this try.
      let outcome;
      let failure;
      // Set once a campaigns create or update is about to run: from then on the remote outcome is open.
      let wrote = false;
      const jobRun = (args) => {
        assertAllowed(args, job.kind);
        if (args[2] === "campaigns" && (args[3] === "create" || args[3] === "update")) wrote = true;
        return run(args, job.kind);
      };
      try {
        const handler = Object.hasOwn(KINDS, job.kind) ? KINDS[job.kind] : undefined;
        if (!handler) throw new JobFailure(`unknown job kind: ${String(job.kind).slice(0, 60)}`, false);
        outcome = await handler(job.payload, jobRun, fallbackProject, { listCampaigns, clock });
      } catch (e) {
        failure = e instanceof JobFailure ? e : new JobFailure(errorText(e), !(e instanceof CommandNotAllowedError));
      }

      const body = outcome
        ? { job_id: id, claim_id: claim.claim_id, result: outcome }
        : {
          job_id: id, claim_id: claim.claim_id, error: failure.message.slice(0, ERROR_MAX),
          ...(failure.retryable ? {} : { retryable: false }),
          // Core keeps a spend job's budget counted unless the executor says no write ran.
          ...(SPEND_KINDS.has(job.kind) && !wrote ? { wrote: false } : {}),
        };
      const result = await post("/api/adkit/jobs/result", body);
      if (!result.ok) {
        error(`adkit-executor: ${id} result HTTP ${result.status}: ${(await result.text()).slice(0, 300)}`
          + (outcome ? ` (orphan ${job.kind} result ${JSON.stringify(outcome).slice(0, 200)})` : ""));
        failures++;
      } else if (outcome) {
        log(`adkit-executor: ${id} ${job.kind} ${outcome.adopted === true ? "adopted" : "done"} ${outcome.conversion_action_id ?? outcome.campaign_id}`);
        done++;
      } else {
        error(`adkit-executor: ${id} failed: ${failure.message}`);
        failures++;
      }
    } catch (e) {
      error(`adkit-executor: ${id} failed: ${e?.message || e}`);
      failures++;
    }
  }
  log(`adkit-executor: ${done} done, ${failures} failed`);
  return failures;
}

async function main() {
  const { FORM_BASE_URL, DRAIN_TOKEN, GOOGLE_PROJECT, ADKIT_PROJECT } = process.env;
  if (!FORM_BASE_URL || !DRAIN_TOKEN) {
    console.error("adkit-executor: missing env FORM_BASE_URL or DRAIN_TOKEN");
    process.exit(1);
  }
  try {
    const failures = await executeJobs({ baseUrl: FORM_BASE_URL, token: DRAIN_TOKEN, fallbackProject: GOOGLE_PROJECT || ADKIT_PROJECT });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`adkit-executor: ${e?.message || e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
