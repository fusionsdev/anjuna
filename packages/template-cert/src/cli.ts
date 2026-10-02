#!/usr/bin/env bun
/**
 * Template certification CLI (T11).
 *
 *   bun run check-template <path-to-dist-or-zip> [--json] [--deny-domains "a.com,b.io"]
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = errors found, 2 = could not read the input.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./index.js";
import { renderHuman, renderJson } from "./report.js";
import { loadSource } from "./workspace.js";
import type { LoadFailure } from "./types.js";

interface Args {
  path?: string;
  json: boolean;
  denyDomains: string[];
  help: boolean;
}

function readDenyList(file: string): string[] {
  const text = readFileSync(file, "utf8").trim();
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, denyDomains: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--deny-domains" || a === "--deny-domain") {
      const v = argv[++i];
      if (v) args.denyDomains.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (a === "--deny-list") {
      const v = argv[++i];
      if (v) args.denyDomains.push(...readDenyList(v));
    } else if (a.startsWith("--deny-domains=")) {
      args.denyDomains.push(...a.slice("--deny-domains=".length).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (!a.startsWith("-")) {
      if (!args.path) args.path = a;
    }
  }
  return args;
}

function printLoadFailure(f: LoadFailure, json: boolean, out: (s: string) => void): void {
  if (json) {
    out(JSON.stringify({ ok: false, error: f.message, errorTh: f.messageTh }, null, 2));
  } else {
    out(`Cannot check the template:\nEN: ${f.message}\nTH: ${f.messageTh}`);
  }
}

export function run(argv: string[], out: (s: string) => void): number {
  const args = parseArgs(argv);
  if (args.help) {
    out("Usage: bun run check-template <path-to-dist-or-zip> [--json] [--deny-domains \"a.com,b.io\"] [--deny-list deny.json]");
    return 0;
  }
  if (!args.path) {
    out('Error: no input path. Usage: bun run check-template <path-to-dist-or-zip> [--json]');
    return 2;
  }

  const source = loadSource(args.path);
  if ("message" in source) {
    printLoadFailure(source, args.json, out);
    return 2;
  }

  const result = runChecks(source, { denyDomains: args.denyDomains });
  out(args.json ? renderJson(result) : renderHuman(result));
  return result.ok ? 0 : 1;
}

function main(): void {
  const write = (s: string) => process.stdout.write(s + "\n");
  process.exitCode = run(process.argv.slice(2), write);
}

// Run only when invoked directly (not when imported by the test suite).
const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) main();