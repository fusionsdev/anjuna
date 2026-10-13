// Packs a verified form build into the ZIP the factory install Workflow reads from R2
// (readZipFromR2 in workers/factory/src/render.ts), stored at forms/form-<sha7>.
//
// Usage: node scripts/form-zip.mjs <dist-dir> --out <file.zip>
// Refuses to run unless <dist-dir>/manifest.json matches the files on disk (same set, sizes and
// SHA-256), so the ZIP holds exactly what the manifest vouches for. manifest.json itself is not
// packed. Prints one JSON line: { out, entries, bytes, sha256 }.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./manifest.mjs";
import { formZipEntries, storeZip } from "./zip-store.mjs";

export function buildFormZip(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.artifact !== "form" || manifest.base !== "/_f/") throw new Error("form zip: manifest is not a form manifest");
  const actual = buildManifest(dir, manifest.version);
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error("form zip: dist does not match its manifest");
  const files = manifest.files.map((file) => [file.path, new Uint8Array(readFileSync(join(dir, file.path)))]);
  const zip = storeZip(formZipEntries(files));
  return { zip, entries: files.length, sha256: createHash("sha256").update(zip).digest("hex") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const out = args[args.indexOf("--out") + 1];
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!dir || args.indexOf("--out") < 0 || !out) {
    console.error("usage: node scripts/form-zip.mjs <dist-dir> --out <file.zip>");
    process.exit(2);
  }
  const { zip, entries, sha256 } = buildFormZip(dir);
  writeFileSync(out, zip);
  process.stdout.write(`${JSON.stringify({ out, entries, bytes: zip.length, sha256 })}\n`);
}
