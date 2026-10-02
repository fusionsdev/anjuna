import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadSource } from "../src/workspace.js";
import { runChecks } from "../src/index.js";
import type { Source } from "../src/workspace.js";
import { buildZip, validFiles, type ZipFileSpec } from "./helpers.js";

const temps: string[] = [];

function writeZip(specs: ZipFileSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tcert-"));
  temps.push(dir);
  const p = join(dir, "template.zip");
  writeFileSync(p, buildZip(specs));
  return p;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("ZIP input", () => {
  it("a valid ZIP of the starter-shaped template checks green", () => {
    const entries: ZipFileSpec[] = Object.entries(validFiles()).map(([name, text]) => ({
      name,
      data: new TextEncoder().encode(text),
      method: 8 as const,
    }));
    const path = writeZip(entries);
    const loaded = loadSource(path);
    expect("files" in loaded).toBe(true);
    const result = runChecks(loaded as Source);
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
  });

  it("rejects a zip-slip entry", () => {
    const path = writeZip([{ name: "../evil.txt", data: new TextEncoder().encode("boo"), method: 0 }]);
    const loaded = loadSource(path);
    expect("message" in loaded).toBe(true);
    expect((loaded as { message: string }).message).toMatch(/\.\.|escape/i);
  });

  it("rejects a symbolic-link entry", () => {
    const spec: ZipFileSpec = {
      name: "link.txt",
      data: new TextEncoder().encode("target"),
      method: 0,
      versionMadeBy: (3 << 8) | 20, // Unix, version 20
      externalAttrs: (0o120000 << 16) >>> 0, // S_IFLNK
    };
    const path = writeZip([spec]);
    const loaded = loadSource(path);
    expect("message" in loaded).toBe(true);
    expect((loaded as { message: string }).message).toMatch(/symbolic link/i);
  });

  it("rejects an oversized (zip-bomb) archive", () => {
    const spec: ZipFileSpec = {
      name: "index.html",
      data: new TextEncoder().encode("<html></html>"),
      method: 8,
      uncompressedSize: 250 * 1024 * 1024, // declares far more than the safety cap
    };
    const path = writeZip([spec]);
    const loaded = loadSource(path);
    expect("message" in loaded).toBe(true);
    expect((loaded as { message: string }).message).toMatch(/expands beyond|larger/i);
  });
});