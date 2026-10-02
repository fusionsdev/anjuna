// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, sha256 } from "../scripts/manifest.mjs";

describe("R2 manifest (FO-4)", () => {
  it("lists every file with its SHA-256, sorted, plus a bundle digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "form-manifest-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
    writeFileSync(join(dir, "manifest.json"), "{}"); // never lists itself

    const m = buildManifest(dir, "abc123");
    expect(m.artifact).toBe("form");
    expect(m.version).toBe("abc123");
    expect(m.base).toBe("/_f/");
    expect(m.files.map((f) => f.path)).toEqual(["assets/a.js", "index.html"]);
    expect(m.files[1]).toEqual({ path: "index.html", size: 13, sha256: sha256(Buffer.from("<html></html>")) });
    const lines = m.files.map((f) => `${f.sha256}  ${f.path}\n`).join("");
    expect(m.bundle_sha256).toBe(sha256(Buffer.from(lines)));
    expect(m.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
