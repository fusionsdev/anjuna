#!/usr/bin/env node
/**
 * adkit-directory-sync: copy AdKit projects, Google Ads accounts and conversion actions into core
 * (panel redesign T9, ADR-0005 decision 4). The panel wizard reads its selects from that copy.
 *
 *   node adkit-directory-sync.mjs
 *
 * Env: FORM_BASE_URL (core origin) and DRAIN_TOKEN, the same values drain.mjs reads.
 * Optional: ADKIT_PROJECTS (comma-separated). Without it, GOOGLE_PROJECT / ADKIT_PROJECT, else one call with no --project.
 *
 *   1. adkit manage google accounts list --json [--project <p>] per project.
 *   2. Per account: adkit manage google conversions list --account <a> --limit 500 --json [--project <p>].
 *   3. POST /api/adkit/directory/ingest with every row, in chunks of 1000. Core stamps each row; a row not
 *      sent again for 2 hours is no longer served.
 * Every adkit call goes through the executor allowlist. One failing account does not stop the others;
 * any failure makes the exit code 1. Scheduling it hourly on the VPS is an owner action (Wave 4 gate).
 *
 * Plain Node 20, no dependencies.
 */
import { pathToFileURL } from "node:url";
import { conversionListArgs, parseAdkitJson } from "./conversion-sync.mjs";
import { guardAdkit, runAdkitCli } from "./adkit-executor.mjs";

const CHUNK = 1000;
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const CONVERSION_ID = /^\d{1,20}$/;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);
const firstOf = (item, keys) => {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

/** The argv that lists the Google Ads accounts AdKit can reach, for one project or for the default. */
export function accountsListArgs(project) {
  return ["manage", "google", "accounts", "list", "--json", ...(project ? ["--project", project] : [])];
}

/**
 * Accounts from the `accounts list` output. The id is the 10-digit customer id (dashes removed), the currency an
 * upper-case ISO code or null, the project the item's own project or the project of the call. Rows without a
 * valid id are skipped. The field names AdKit uses are not pinned yet, so the common spellings are all read.
 */
export function accountsFromAdkit(out, project) {
  const list = Array.isArray(out) ? out : Array.isArray(out?.accounts) ? out.accounts : Array.isArray(out?.data) ? out.data : [];
  const accounts = [];
  for (const item of list) {
    const id = String(firstOf(item, ["platformId", "customerId", "accountId", "id"]) ?? "").replaceAll("-", "");
    if (!/^\d{10}$/.test(id)) continue;
    const currency = String(firstOf(item, ["currencyCode", "currency"]) ?? "").toUpperCase();
    const nested = item?.project && typeof item.project === "object" ? item.project : null;
    const itemProject = String(nested ? (nested.id ?? "") : (firstOf(item, ["projectId", "project_id", "project"]) ?? ""));
    accounts.push({
      id,
      name: text(firstOf(item, ["name", "descriptiveName"])) ?? id,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      project: PROJECT.test(itemProject) ? itemProject : project,
      project_name: nested ? text(nested.name) : null,
    });
  }
  return accounts;
}

/** Conversion actions from `conversions list`: removed actions and rows without a numeric id are skipped. */
function conversionActionsFromAdkit(out, account) {
  const list = Array.isArray(out) ? out : Array.isArray(out?.conversions) ? out.conversions : [];
  const items = [];
  for (const item of list) {
    if (String(item?.status ?? "").toLowerCase() === "removed") continue;
    const id = item?.platformId === undefined || item?.platformId === null ? "" : String(item.platformId);
    if (!CONVERSION_ID.test(id)) continue;
    items.push({ kind: "conversion_action", id, parent_id: account, name: text(item?.name) ?? id, currency: null });
  }
  return items;
}

/**
 * The whole job. `runAdkit(args) -> stdout` and `fetchImpl` are injectable so tests never call AdKit or core;
 * an injected runner is wrapped by the allowlist too. Returns the number of failures.
 */
export async function syncDirectory({
  baseUrl, token, projects = [], runAdkit = runAdkitCli, fetchImpl = fetch, log = console.log, error = console.error, chunkSize = CHUNK,
}) {
  const run = guardAdkit(runAdkit);
  const origin = baseUrl.replace(/\/+$/, "");
  let failures = 0;
  const projectItems = new Map();
  const accountItems = new Map();
  const actionItems = [];

  const accounts = new Map();
  for (const project of projects.length ? projects : [null]) {
    try {
      const out = parseAdkitJson(await run(accountsListArgs(project)));
      if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
      for (const account of accountsFromAdkit(out, project)) if (!accounts.has(account.id)) accounts.set(account.id, account);
    } catch (e) {
      error(`adkit-directory-sync: accounts list${project ? ` ${project}` : ""} failed: ${e?.message || e}`);
      failures++;
    }
  }

  for (const account of accounts.values()) {
    if (account.project && !projectItems.has(account.project)) {
      projectItems.set(account.project, { kind: "project", id: account.project, parent_id: null, name: account.project_name ?? account.project, currency: null });
    }
    accountItems.set(account.id, { kind: "account", id: account.id, parent_id: account.project, name: account.name, currency: account.currency });
    try {
      const out = parseAdkitJson(await run(conversionListArgs({ account: account.id, project: account.project })));
      if (out && !Array.isArray(out) && out.error) throw new Error(String(out.error));
      actionItems.push(...conversionActionsFromAdkit(out, account.id));
    } catch (e) {
      error(`adkit-directory-sync: ${account.id} conversions list failed: ${e?.message || e}`);
      failures++;
    }
  }

  const items = [...projectItems.values(), ...accountItems.values(), ...actionItems];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    try {
      const res = await fetchImpl(`${origin}/api/adkit/directory/ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: chunk }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      error(`adkit-directory-sync: ingest failed: ${e?.message || e}`);
      failures++;
    }
  }
  log(`adkit-directory-sync: ${projectItems.size} projects, ${accountItems.size} accounts, ${actionItems.length} conversion actions, ${failures} failed`);
  return failures;
}

async function main() {
  const { FORM_BASE_URL, DRAIN_TOKEN, ADKIT_PROJECTS, GOOGLE_PROJECT, ADKIT_PROJECT } = process.env;
  if (!FORM_BASE_URL || !DRAIN_TOKEN) {
    console.error("adkit-directory-sync: missing env FORM_BASE_URL or DRAIN_TOKEN");
    process.exit(1);
  }
  const fallback = GOOGLE_PROJECT || ADKIT_PROJECT;
  const projects = (ADKIT_PROJECTS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  try {
    const failures = await syncDirectory({ baseUrl: FORM_BASE_URL, token: DRAIN_TOKEN, projects: projects.length ? projects : fallback ? [fallback] : [] });
    process.exit(failures ? 1 : 0);
  } catch (e) {
    console.error(`adkit-directory-sync: ${e?.message || e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
