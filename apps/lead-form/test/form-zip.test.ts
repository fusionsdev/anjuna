// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFormZip } from "../scripts/form-zip.mjs";
import { buildManifest } from "../scripts/manifest.mjs";
import { crc32, formZipEntries, storeZip } from "../scripts/zip-store.mjs";

const SCRIPT = join(__dirname, "..", "scripts", "form-zip.mjs");

/** A dist shaped like the vite build: index.html plus hashed chunks under assets/, then manifest.json. */
function makeDist(version = "a".repeat(40)): string {
  const dir = mkdtempSync(join(tmpdir(), "form-zip-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<script type="module" src="/_f/assets/index-abc123.js"></script>');
  writeFileSync(join(dir, "assets", "index-abc123.js"), 'console.log("form")');
  writeFileSync(join(dir, "assets", "style-xyz789.css"), ".form{color:red}");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(buildManifest(dir, version), null, 2) + "\n");
  return dir;
}

/** Independent reader: walks the central directory and checks every local header and CRC. */
function readZip(zip: Uint8Array): Array<{ path: string; bytes: Uint8Array; method: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const path = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip.subarray(local + 30, local + 30 + view.getUint16(local + 26, true)))).toBe(path);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const bytes = zip.subarray(start, start + size);
    expect(crc32(bytes)).toBe(crc);
    entries.push({ path, bytes, method });
    at += 46 + nameLength;
  }
  return entries;
}

describe("form ZIP for the factory (render.ts readZipFromR2)", () => {
  it("packs every manifest file under /_f/, leaves manifest.json out, and sorts entries", () => {
    const { zip, entries } = buildFormZip(makeDist());
    expect(entries).toBe(3);
    const read = readZip(zip);
    expect(read.map((entry) => entry.path)).toEqual(["/_f/assets/index-abc123.js", "/_f/assets/style-xyz789.css", "/_f/index.html"]);
    expect(read.every((entry) => entry.method === 0)).toBe(true);
    expect(new TextDecoder().decode(read[0]!.bytes)).toBe('console.log("form")');
  });

  it("is byte-identical for the same dist, whatever the file timestamps", () => {
    const dir = makeDist();
    const first = buildFormZip(dir);
    utimesSync(join(dir, "index.html"), new Date(2030, 1, 1), new Date(2030, 1, 1));
    const second = buildFormZip(dir);
    expect(Buffer.from(second.zip).equals(Buffer.from(first.zip))).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(createHash("sha256").update(first.zip).digest("hex"));
    expect(buildFormZip(makeDist()).sha256).toBe(first.sha256);
  });

  it("refuses a dist that no longer matches its manifest", () => {
    const changed = makeDist();
    writeFileSync(join(changed, "assets", "index-abc123.js"), 'console.log("tampered")');
    expect(() => buildFormZip(changed)).toThrow("dist does not match its manifest");
    const extra = makeDist();
    writeFileSync(join(extra, "assets", "extra.js"), "1");
    expect(() => buildFormZip(extra)).toThrow("dist does not match its manifest");
  });

  it("rejects unsafe or duplicate paths", () => {
    const bytes = new Uint8Array([1]);
    for (const path of ["/index.html", "../index.html", "a//b", "a\\b", ""]) {
      expect(() => formZipEntries([[path, bytes]]), path).toThrow("unsafe dist path");
    }
    expect(() => formZipEntries([["a.js", bytes], ["a.js", bytes]])).toThrow("duplicate");
    expect(() => storeZip([])).toThrow("no entries");
  });

  it("the CLI writes the file and reports its SHA-256 on one line", () => {
    const dir = makeDist();
    const out = join(mkdtempSync(join(tmpdir(), "form-zip-out-")), "form.zip");
    const line = execFileSync("node", [SCRIPT, dir, "--out", out], { encoding: "utf8" });
    const report = JSON.parse(line) as { out: string; entries: number; bytes: number; sha256: string };
    expect(report).toMatchObject({ out, entries: 3 });
    const written = readFileSync(out);
    expect(report.bytes).toBe(written.length);
    expect(report.sha256).toBe(createHash("sha256").update(written).digest("hex"));
    expect(report.sha256).toBe(buildFormZip(dir).sha256);
  });
});
