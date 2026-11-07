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
 *   3. Run the job through adkit. Only the allowlisted commands can run: `accounts list`, `conversions list`,
 *      `results list`, `conversions create`. Anything else is rejected before a process is spawned.
 *   4. POST /api/adkit/jobs/result with the result, or with the error text (500 characters at most).
 *
 * conversion_action.create: list the account's actions; when the job's name is already there (a crashed earlier
 * run), adopt that id. Otherwise create it with --publish. A duplicate-name error lists again and adopts the id
 * (ADR-0005 decision 9, the same rule as conversion-sync.mjs).
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
const DUPLICATE = /duplicate|already[\s_-]?exist/i;

/** `<resource> <verb>` after `manage google`. Nothing else may run. */
export const ALLOWED_COMMANDS = Object.freeze(["accounts list", "conversions list", "results list", "conversions create"]);
const ALLOWED = new Set(ALLOWED_COMMANDS);

export class CommandNotAllowedError extends Error {}

/** Throws unless argv is `manage google <resource> <verb> ...` with an allowlisted resource and verb. */
export function assertAllowed(args) {
  const ok = Array.isArray(args) && args[0] === "manage" && args[1] === "google"
    && typeof args[2] === "string" && typeof args[3] === "string" && ALLOWED.has(`${args[2]} ${args[3]}`);
  if (!ok) {
    const shown = Array.isArray(args) ? args.slice(0, 4).map(String).join(" ") : String(args);
    throw new CommandNotAllowedError(`adkit command not allowed: ${shown.slice(0, 80) || "(empty)"}`);
  }
}

/** Wrap a runner so every call passes the allowlist first; a rejected command never reaches `run`. */
export function guardAdkit(run) {
  return async (args) => {
    assertAllowed(args);
    return run(args);
  };
}

/** The real runner: allowlist, then spawn `adkit` from PATH. */
export const runAdkitCli = guardAdkit(async (args) => {
  const { stdout } = await exec("adkit", args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  return stdout;
});

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
    || !(payload.project === null || payload.project === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(String(payload.project)))) {
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

const KINDS = {
  "conversion_action.create": runConversionActionCreate,
};

/**
 * The whole run. `runAdkit(args) -> stdout` and `fetchImpl` are injectable so tests never call AdKit or core.
 * An injected runner is wrapped by the allowlist too. Returns the number of failed jobs.
 */
export async function executeJobs({
  baseUrl, token, fallbackProject, runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error,
}) {
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

      // After a successful claim every path posts exactly one result, so nothing below may escape this try.
      let outcome;
      let failure;
      try {
        const handler = Object.hasOwn(KINDS, job.kind) ? KINDS[job.kind] : undefined;
        if (!handler) throw new JobFailure(`unknown job kind: ${String(job.kind).slice(0, 60)}`, false);
        outcome = await handler(job.payload, run, fallbackProject);
      } catch (e) {
        failure = e instanceof JobFailure ? e : new JobFailure(errorText(e), !(e instanceof CommandNotAllowedError));
      }

      const body = outcome
        ? { job_id: id, claim_id: claim.claim_id, result: outcome }
        : { job_id: id, claim_id: claim.claim_id, error: failure.message.slice(0, ERROR_MAX), ...(failure.retryable ? {} : { retryable: false }) };
      const result = await post("/api/adkit/jobs/result", body);
      if (!result.ok) {
        error(`adkit-executor: ${id} result HTTP ${result.status}: ${(await result.text()).slice(0, 300)}`
          + (outcome ? ` (orphan conversion ${outcome.conversion_action_id} name=${outcome.name})` : ""));
        failures++;
      } else if (outcome) {
        log(`adkit-executor: ${id} ${job.kind} ${outcome.adopted ? "adopted" : "created"} ${outcome.conversion_action_id}`);
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
