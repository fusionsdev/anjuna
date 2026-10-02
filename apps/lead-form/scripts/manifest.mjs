#!/usr/bin/env node
// FO-4: SHA-256 manifest for a built form bundle, stored next to it in R2 as form@<sha>/manifest.json.
//
// Usage: node scripts/manifest.mjs <dist-dir> [--version <git-sha>] [--out <file>]
// Prints the manifest JSON to stdout, or writes it to --out.
//
// Shape:
// {
//   "artifact": "form", "version": "<git sha>", "base": "/_f/",
//   "files": [{ "path": "index.html", "size": 123, "sha256": "<hex>" }, ...],   // sorted by path
//   "bundle_sha256": "<hex>"   // sha256 over "<sha256>  <path>\n" lines, sha256sum format
// }
// A consumer verifies each object it reads against `files`, and the set against bundle_sha256.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function buildManifest(dir, version) {
  const files = [];
  for (const file of walk(dir)) {
    const path = relative(dir, file).replace(/\\/g, "/");
    if (path === "manifest.json") continue;
    const buf = readFileSync(file);
    files.push({ path, size: buf.length, sha256: sha256(buf) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sumLines = files.map((f) => `${f.sha256}  ${f.path}\n`).join("");
  return { artifact: "form", version, base: "/_f/", files, bundle_sha256: sha256(sumLines) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--")) ?? "dist";
  const version = opt("--version") ?? process.env.GITHUB_SHA ?? "local";
  const manifest = buildManifest(dir, version);
  if (manifest.files.length === 0) {
    console.error(`manifest: no files under ${dir} - build first`);
    process.exit(2);
  }
  const json = JSON.stringify(manifest, null, 2) + "\n";
  const out = opt("--out");
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}
