import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSource } from "../src/workspace.js";
import type { Source } from "../src/workspace.js";
import { DIST_LIMITS } from "../src/workspace.js";
import { runChecks } from "../src/index.js";
import { check, issuesFor, makeSource, validFiles, validIndex } from "./helpers.js";

const starterDist = fileURLToPath(new URL("../../template-astro-starter/dist/", import.meta.url));

function indexWith(body: string): Record<string, string> {
  const files = validFiles();
  files["index.html"] = body;
  return files;
}

describe("the Astro starter passes", () => {
  beforeAll(() => {
    if (!existsSync(starterDist)) {
      throw new Error("Astro starter dist missing — run `bun run build` for @anjuna/template-astro-starter first");
    }
  });

  it("is fully green with no errors", () => {
    const loaded = loadSource(starterDist);
    expect("files" in loaded).toBe(true);
    const result = runChecks(loaded as Source);
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });
});

describe("one fixture per failure type", () => {
  it("structure: a missing legal page fails with the page name", () => {
    const files = validFiles();
    delete files["privacy/index.html"];
    const result = check(files);
    const issues = issuesFor(result, "structure");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(1);
    expect(issues[0]!.en).toContain("/privacy/");
    expect(issues[0]!.th).toBeTruthy();
  });

  it("structure: too many files fails", () => {
    const files: Record<string, string> = validFiles();
    for (let i = 0; i < 2001; i++) files[`asset-${i}.png`] = "x";
    const result = check(files);
    expect(issuesFor(result, "structure").some((i) => /2000 file/.test(i.en))).toBe(true);
  });

  it("structure: an oversized build fails on the 30 MB limit", () => {
    const files: Source = makeSource(validFiles());
    files.files.set("big.bin", new Uint8Array(DIST_LIMITS.maxBytes + 1));
    const result = runChecks(files);
    expect(issuesFor(result, "structure").some((i) => /MB limit/.test(i.en))).toBe(true);
  });

  it("keyword: no data-kw span fails with a clear message", () => {
    const result = check(indexWith("<html><body><h1>Funding Options</h1></body></html>"));
    const issues = issuesFor(result, "keyword");
    expect(issues.some((i) => /no <span data-kw>/i.test(i.en))).toBe(true);
  });

  it("keyword: data-kw outside the h1 fails", () => {
    const result = check(indexWith("<html><body><h1>Title</h1><span data-kw>X</span></body></html>"));
    expect(issuesFor(result, "keyword").some((i) => /inside the <h1>/i.test(i.en))).toBe(true);
  });

  it("cta: wrong action fails", () => {
    const files = validFiles();
    files["index.html"] = validIndex().replace('action="/go"', 'action="/apply"');
    const result = check(files);
    expect(issuesFor(result, "cta").some((i) => /action="\/go"/.test(i.en))).toBe(true);
  });

  it("cta: a non-canonical amount fails", () => {
    const files = validFiles();
    files["index.html"] = validIndex().replace('<option value="1000">$1,000</option>', '<option value="9999">$9,999</option>');
    const result = check(files);
    expect(issuesFor(result, "cta").some((i) => /not allowed/.test(i.en) && i.en.includes("9999"))).toBe(true);
  });

  it("pii: an email input fails", () => {
    const result = check(indexWith(validIndex().replace("</form>", '<input name="email" type="email"></form>')));
    expect(issuesFor(result, "pii").some((i) => /email/.test(i.en))).toBe(true);
  });

  it("pii: an extra non-CTA form fails", () => {
    const result = check(indexWith(validIndex() + "<form method=\"get\" action=\"/newsletter\"><input name=\"email\"></form>"));
    expect(issuesFor(result, "pii").some((i) => /not the CTA/.test(i.en))).toBe(true);
  });

  it("wording: personal loan fails", () => {
    const result = check(indexWith("<html><body><h1><span data-kw>Funding</span></h1><p>Get a Personal Loan today.</p></body></html>"));
    expect(issuesFor(result, "wording").some((i) => /personal loan/i.test(i.en))).toBe(true);
  });

  it("wording: guaranteed approval fails", () => {
    const result = check(indexWith("<html><body><h1><span data-kw>Funding</span></h1><p>Guaranteed approval for everyone.</p></body></html>"));
    expect(issuesFor(result, "wording").some((i) => /guaranteed approval/i.test(i.en))).toBe(true);
  });

  it("external: an external script fails", () => {
    const result = check(indexWith(validIndex() + "<script src=\"https://cdn.example.com/x.js\"></script>"));
    expect(issuesFor(result, "external").some((i) => /outside the site/.test(i.en))).toBe(true);
  });

  it("external: an iframe fails", () => {
    const result = check(indexWith(validIndex() + "<iframe src=\"https://example.com/embed\"></iframe>"));
    expect(issuesFor(result, "external").some((i) => /iframe/.test(i.en))).toBe(true);
  });

  it("brand: a platform string fails", () => {
    const result = check(indexWith(validIndex() + "<p>Powered by anjuna</p>"));
    expect(issuesFor(result, "brand").some((i) => /anjuna/.test(i.en))).toBe(true);
  });

  it("brand: a deny-listed domain fails", () => {
    const result = check(indexWith(validIndex() + "<p>Visit competitor.com today</p>"), ["WwW.competitor.com/path"]);
    expect(issuesFor(result, "brand").some((i) => /competitor\.com/.test(i.en))).toBe(true);
  });

  it("links: a broken internal link fails", () => {
    const result = check(indexWith(validIndex() + "<a href=\"/missing-page/\">Broken</a>"));
    expect(issuesFor(result, "links").some((i) => /broken/.test(i.en))).toBe(true);
  });
});

describe("warnings do not fail the template", () => {
  it("Google Fonts CSS is allowed with a warning", () => {
    const html = validIndex().replace(
      "<style>:root{color:#000}</style>",
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">',
    );
    const result = check(indexWith(html));
    expect(result.ok).toBe(true);
    const externalIssues = issuesFor(result, "external");
    expect(externalIssues.some((i) => i.severity === "warning" && /Google Fonts/.test(i.en))).toBe(true);
  });
});

describe("directory vs in-memory source", () => {
  it("a same-origin script and image resolve without link errors", () => {
    const files = validFiles();
    files["assets/app.js"] = "// app";
    files["assets/logo.png"] = "PNG";
    files["index.html"] = validIndex().replace("</body>", '<script src="/assets/app.js"></script><img src="/assets/logo.png"></body>');
    const result = check(files);
    expect(result.ok).toBe(true);
  });
});

describe("page text (title, description, data-brand)", () => {
  it("a landing page without <title> or meta description fails structure", () => {
    const files = indexWith(validIndex().replace(/<title>.*?<\/title>/, "").replace(/<meta name="description"[^>]*>/, ""));
    const errors = issuesFor(check(files), "structure").filter((i) => i.severity === "error");
    expect(errors.map((i) => i.en)).toEqual([expect.stringContaining("<title>"), expect.stringContaining('meta name="description"')]);
    expect(errors.every((i) => i.location === "index.html" && i.th.length > 0)).toBe(true);
  });

  it("an over-long title or description is a warning, not an error", () => {
    const files = indexWith(
      validIndex()
        .replace(/<title>.*?<\/title>/, `<title>${"T".repeat(71)}</title>`)
        .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${"d".repeat(161)}">`),
    );
    const result = check(files);
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").filter((i) => i.severity === "warning")).toHaveLength(2);
  });

  it("a template without data-brand passes with one warning", () => {
    const result = check(indexWith(validIndex().replace(" data-brand", "")));
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").map((i) => i.en)).toEqual([expect.stringContaining("data-brand")]);
  });

  it("a data-brand element with nested elements is a warning", () => {
    const result = check(indexWith(validIndex().replace('<a href="/" data-brand>Harbor</a>', '<a href="/" data-brand><b>Harbor</b></a>')));
    expect(result.ok).toBe(true);
    expect(issuesFor(result, "structure").map((i) => i.en)).toEqual([expect.stringContaining("only the brand name")]);
  });
});
