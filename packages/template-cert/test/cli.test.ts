import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { validFiles } from "./helpers.js";

const temps: string[] = [];

function writeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcert-cli-"));
  temps.push(dir);
  return dir;
}

function writeTemplate(files: Record<string, string>): string {
  const dir = writeDir();
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("CLI", () => {
  it("returns 0 and writes JSON for a passing template", () => {
    const dir = writeTemplate(validFiles());
    let out = "";
    const code = run([dir, "--json"], (s) => (out += s));
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(8);
    expect(parsed.checks.every((c: { status: string }) => c.status === "pass")).toBe(true);
  });

  it("returns 1 and ok:false for a failing template", () => {
    const files = validFiles();
    files["index.html"] = files["index.html"]! + "<p>Get a Personal Loan today</p>";
    const dir = writeTemplate(files);
    let out = "";
    const code = run([dir, "--json"], (s) => (out += s));
    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toBeGreaterThan(0);
  });

  it("returns 2 for a missing path", () => {
    let out = "";
    const code = run(["H:/no/such/dir/xyz", "--json"], (s) => (out += s));
    expect(code).toBe(2);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
  });

  it("returns 0 but with a warning for a Google Fonts link", () => {
    const files = validFiles();
    files["index.html"] = files["index.html"]!.replace(
      "<style>:root{color:#000}</style>",
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">',
    );
    const dir = writeTemplate(files);
    let out = "";
    const code = run([dir, "--json"], (s) => (out += s));
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.warnings).toBeGreaterThan(0);
  });

  it("prints a human report with EN and TH lines", () => {
    const files = validFiles();
    delete files["privacy/index.html"];
    const dir = writeTemplate(files);
    let out = "";
    const code = run([dir], (s) => (out += s));
    expect(code).toBe(1);
    expect(out).toContain("EN:");
    expect(out).toContain("TH:");
  });
});