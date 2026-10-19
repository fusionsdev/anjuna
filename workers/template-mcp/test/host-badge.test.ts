import { describe, expect, it } from "vitest";
import type { FileMap } from "../src/archive";
import { stripHostBadges } from "../src/host-badge";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const BADGE = '<script src="https://bolt.new/badge.js?s=abc"></script>';
const page = (extra = "") => `<!doctype html><html><body><main><h1>Harbor</h1></main>${extra}</body></html>`;

describe("stripHostBadges", () => {
  it("removes the bolt.host badge script from every HTML file and leaves other files untouched", () => {
    const css = enc("/* see bolt.new/badge.js */ body{margin:0}");
    const files: FileMap = new Map([
      ["index.html", enc(page(BADGE))],
      ["privacy/index.html", enc(page(`\n  ${BADGE}\n`))],
      ["assets/site.css", css],
    ]);
    const { files: out, stripped } = stripHostBadges(files);
    expect(dec(out.get("index.html")!)).toBe(page());
    expect(dec(out.get("privacy/index.html")!)).not.toContain("badge.js");
    expect(out.get("assets/site.css")).toBe(css);
    expect([...out.keys()]).toEqual([...files.keys()]);
    expect(stripped).toEqual([{ file: "index.html", host: "bolt.host" }, { file: "privacy/index.html", host: "bolt.host" }]);
  });

  it("returns the same bytes and no entries when nothing is injected", () => {
    const files: FileMap = new Map([["index.html", enc(page())], ["assets/site.css", enc("body{margin:0}")]]);
    const { files: out, stripped } = stripHostBadges(files);
    expect(stripped).toEqual([]);
    for (const [path, bytes] of files) expect(out.get(path)).toBe(bytes);
  });

  it("handles single quotes and extra attributes", () => {
    const tag = `<script defer src='https://bolt.new/badge.js?s=x' data-x="1"></script>`;
    const { files: out, stripped } = stripHostBadges(new Map([["index.html", enc(page(tag))]]));
    expect(dec(out.get("index.html")!)).toBe(page());
    expect(stripped).toEqual([{ file: "index.html", host: "bolt.host" }]);
  });

  describe("leaves lookalikes alone", () => {
    const decoys: [string, string][] = [
      ["a data-src attribute", '<script data-src="https://bolt.new/badge.js" src="/app.js"></script>'],
      ["a local badge.js", '<script src="/assets/badge.js"></script>'],
      ["a bolt.new URL inside another src query string", '<script src="/x.js?u=https://bolt.new/badge.js"></script>'],
      ["a different file on bolt.new", '<script src="https://bolt.new/badge.json"></script>'],
    ];
    it.each(decoys)("keeps %s", (_name, tag) => {
      const bytes = enc(page(tag));
      const { files: out, stripped } = stripHostBadges(new Map([["index.html", bytes]]));
      expect(stripped).toEqual([]);
      expect(out.get("index.html")).toBe(bytes);
    });
  });

  it("strips one badge tag from a page with a 200 KB whitespace run in under a second", () => {
    const html = page(`${" ".repeat(200 * 1024)}${BADGE}${" ".repeat(200 * 1024)}`);
    const started = performance.now();
    const { files: out, stripped } = stripHostBadges(new Map([["index.html", enc(html)]]));
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1000);
    expect(stripped).toEqual([{ file: "index.html", host: "bolt.host" }]);
    expect(dec(out.get("index.html")!)).toBe(page(" ".repeat(400 * 1024)));
  });

  it("leaves an unclosed badge script alone", () => {
    const bytes = enc('<!doctype html><html><body><h1>Harbor</h1><script src="https://bolt.new/badge.js?s=x">\n<p>Keep me</p></body></html>');
    const { files: out, stripped } = stripHostBadges(new Map([["index.html", bytes]]));
    expect(stripped).toEqual([]);
    expect(out.get("index.html")).toBe(bytes);
  });

  it("keeps the whitespace around the removed tag", () => {
    const { files: out } = stripHostBadges(new Map([["index.html", enc('Hello <script src="https://bolt.new/badge.js"></script>world')]]));
    expect(dec(out.get("index.html")!)).toBe("Hello world");
  });
});
