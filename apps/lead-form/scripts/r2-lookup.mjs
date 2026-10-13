// Decides what the lead-form workflow may do with forms/form-<sha7> after `wrangler r2 object get`.
//
// Usage: node scripts/r2-lookup.mjs --exit <wrangler exit code> --log <captured stdout+stderr>
//          --existing <downloaded object file> --local <zip built in this run>
// Prints one word: missing | same | different | error. Only "missing" allows a PUT.
//
// "missing" needs two facts: wrangler exited non-zero AND printed the exact not-found text. Source:
// wrangler 4.124.0, wrangler-dist/cli.js (`r2 object get`, remote path): fetchR2Objects returns null on
// an HTTP 404 and the command then throws UserError("The specified key does not exist."). Any other
// failure (timeout, 5xx, 401/403, failed download) prints other text, so it maps to "error". If a later
// wrangler 4.x words the not-found differently, the result is "error" and the job stops without writing.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NOT_FOUND_TEXT = "The specified key does not exist.";

export function classifyLookup({ exitCode, output, existing, local }) {
  if (exitCode === 0) {
    if (!existing || !local) return "error";
    return Buffer.from(existing).equals(Buffer.from(local)) ? "same" : "different";
  }
  return Number.isInteger(exitCode) && String(output).includes(NOT_FOUND_TEXT) ? "missing" : "error";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const read = (file) => (file && existsSync(file) ? readFileSync(file) : undefined);
  const exitCode = Number(opt("--exit"));
  if (!Number.isInteger(exitCode) || !opt("--log") || !opt("--local")) {
    console.error("usage: node scripts/r2-lookup.mjs --exit <code> --log <file> --existing <file> --local <file>");
    process.exit(2);
  }
  const output = read(opt("--log"))?.toString("utf8") ?? "";
  process.stdout.write(`${classifyLookup({ exitCode, output, existing: read(opt("--existing")), local: read(opt("--local")) })}\n`);
}
