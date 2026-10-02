import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { InputError, LIMITS, readTarGz, readZip, safePath } from "../src/archive";
import { loadZipBase64 } from "../src/input";
import { goodSite, tarGz, toBase64, toZip } from "./fixtures";

const stream = (bytes: Uint8Array) => new Response(bytes).body!;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof InputError ? e.code : "other";
  }
  return "none";
};

describe("zip limits and safety", () => {
  it("reads a valid zip", () => {
    const files = readZip(toZip(goodSite()));
    expect(files.has("index.html")).toBe(true);
    expect(files.get("privacy/index.html")).toBeInstanceOf(Uint8Array);
  });

  it("rejects zip-slip entries", () => {
    expect(code(() => readZip(zipSync({ "../evil.html": strToU8("x"), "index.html": strToU8("x") })))).toBe("zip_slip");
    expect(code(() => readZip(zipSync({ "a/../../evil.html": strToU8("x") })))).toBe("zip_slip");
    expect(code(() => readZip(zipSync({ "/abs.html": strToU8("x") })))).toBe("unsafe_path");
    expect(code(() => readZip(zipSync({ "a\\b.html": strToU8("x") })))).toBe("unsafe_path");
  });

  it("rejects symlinks", () => {
    // attrs: unix host (3) + S_IFLNK 0120777 in the high word of the external attributes
    const zip = zipSync({ "index.html": strToU8("x"), link: [strToU8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
    expect(code(() => readZip(zip))).toBe("symlink");
  });

  it("rejects more than 2000 files", () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < LIMITS.maxFiles + 1; i++) many[`f${i}.txt`] = strToU8("x");
    expect(code(() => readZip(zipSync(many, { level: 0 })))).toBe("too_many_files");
    const exact: Record<string, Uint8Array> = {};
    for (let i = 0; i < LIMITS.maxFiles; i++) exact[`f${i}.txt`] = strToU8("x");
    expect(readZip(zipSync(exact, { level: 0 })).size).toBe(LIMITS.maxFiles);
  });

  it("rejects a zip over 30 MB", () => {
    expect(code(() => readZip(new Uint8Array(LIMITS.maxArchiveBytes + 1)))).toBe("too_large");
  });

  it("rejects a single file over the per-file cap and decompression bombs", () => {
    const big = zipSync({ "big.js": new Uint8Array(LIMITS.maxFileBytes + 1) }); // compresses to a few KB
    expect(big.length).toBeLessThan(100_000);
    expect(code(() => readZip(big))).toBe("file_too_large");
  });

  it("rejects non-zip data and bad base64", () => {
    expect(code(() => readZip(strToU8("not a zip at all, just text")))).toBe("bad_zip");
    expect(code(() => loadZipBase64("***not base64***"))).toBe("bad_base64");
  });

  it("rejects an oversized base64 payload before decoding", () => {
    expect(code(() => loadZipBase64("A".repeat(Math.ceil((LIMITS.maxArchiveBytes * 4) / 3) + 100)))).toBe("too_large");
  });

  it("decodes base64 (with data: prefix)", () => {
    const b64 = toBase64(toZip(goodSite()));
    expect(loadZipBase64(`data:application/zip;base64,${b64}`).files.has("index.html")).toBe(true);
  });

  it("safePath normalizes ./ and duplicate slashes", () => {
    expect(safePath("./a//b/./c.html")).toBe("a/b/c.html");
  });
});

describe("tarball reader", () => {
  it("strips the top-level directory, skips symlinks and filtered paths", async () => {
    const tgz = tarGz([
      { path: "owner-repo-abc/", type: "5" },
      { path: "owner-repo-abc/dist/index.html", content: "<html></html>" },
      { path: "owner-repo-abc/dist/link", type: "2", linkname: "/etc/passwd" },
      { path: "owner-repo-abc/node_modules/x/index.js", content: "x" },
      { path: "owner-repo-abc/package.json", content: "{}" },
    ]);
    const files = await readTarGz(stream(tgz), { stripTopLevel: true, keep: (p) => !p.startsWith("node_modules/") });
    expect([...files.keys()].sort()).toEqual(["dist/index.html", "package.json"]);
  });

  it("rejects files over the per-file cap that would be kept", async () => {
    const tgz = tarGz([{ path: "r/big.bin", content: new Uint8Array(LIMITS.maxFileBytes + 1) }]);
    await expect(readTarGz(stream(tgz), { stripTopLevel: true })).rejects.toThrow(/10 MB/);
  });
});
