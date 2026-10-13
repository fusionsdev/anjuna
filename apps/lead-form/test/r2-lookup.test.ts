// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_FOUND_TEXT, classifyLookup } from "../scripts/r2-lookup.mjs";

const SCRIPT = join(__dirname, "..", "scripts", "r2-lookup.mjs");
const zip = new Uint8Array([1, 2, 3]);

describe("form ZIP lookup verdict (only a confirmed not-found may upload)", () => {
  it("missing: wrangler failed with its not-found text", () => {
    const output = `Downloading "forms/form-a3e15df" from "bucket".\n\n✘ [ERROR] ${NOT_FOUND_TEXT}\n`;
    expect(classifyLookup({ exitCode: 1, output })).toBe("missing");
  });

  it("same: the object exists with the same bytes", () => {
    expect(classifyLookup({ exitCode: 0, output: "Download complete.", existing: new Uint8Array([1, 2, 3]), local: zip })).toBe("same");
  });

  it("different: the object exists with other bytes", () => {
    expect(classifyLookup({ exitCode: 0, output: "Download complete.", existing: new Uint8Array([9, 9, 9]), local: zip })).toBe("different");
    expect(classifyLookup({ exitCode: 0, output: "", existing: new Uint8Array(), local: zip })).toBe("different");
  });

  it.each([
    ["a timeout", 1, "✘ [ERROR] fetch failed\n  Caused by: Error: connect ETIMEDOUT 104.18.0.1:443"],
    ["a 5xx", 1, "✘ [ERROR] A request to the Cloudflare API failed. Failed to fetch /accounts/x/r2/buckets/b/objects/k - 503: Service Unavailable;"],
    ["an auth failure", 1, "✘ [ERROR] Failed to fetch /accounts/x/r2/buckets/b/objects/k - 403: Forbidden;"],
    ["a failed download that printed nothing", 1, ""],
    ["a signal kill", 137, ""],
    ["no exit code", Number.NaN, NOT_FOUND_TEXT],
  ])("error: %s", (_name, exitCode, output) => {
    expect(classifyLookup({ exitCode, output })).toBe("error");
  });

  it("error: success without a downloaded file, or without the local zip", () => {
    expect(classifyLookup({ exitCode: 0, output: "Download complete.", local: zip })).toBe("error");
    expect(classifyLookup({ exitCode: 0, output: "Download complete.", existing: zip })).toBe("error");
  });

  it("the CLI reads the exit code, log and files and prints the verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-lookup-"));
    writeFileSync(join(dir, "local.zip"), zip);
    writeFileSync(join(dir, "existing.zip"), new Uint8Array([7]));
    writeFileSync(join(dir, "missing.log"), `✘ [ERROR] ${NOT_FOUND_TEXT}`);
    writeFileSync(join(dir, "timeout.log"), "ETIMEDOUT");
    writeFileSync(join(dir, "ok.log"), "Download complete.");
    const run = (code: number, log: string, existing?: string) => execFileSync("node", [
      SCRIPT, "--exit", String(code), "--log", join(dir, log), "--local", join(dir, "local.zip"), ...(existing ? ["--existing", join(dir, existing)] : []),
    ], { encoding: "utf8" }).trim();
    expect(run(1, "missing.log", "existing.zip")).toBe("missing");
    expect(run(1, "timeout.log", "existing.zip")).toBe("error");
    expect(run(0, "ok.log", "existing.zip")).toBe("different");
    expect(run(0, "ok.log", "local.zip")).toBe("same");
    expect(run(0, "ok.log")).toBe("error");
  });
});
