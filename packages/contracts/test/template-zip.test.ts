import { describe, expect, it } from "vitest";
import { detectTemplateZip, templateZipRoot, TemplateZipImportRequest } from "../src/template-zip.js";

const files = (entries: Readonly<Record<string, string>>) => new Map(Object.entries(entries).map(([name, text]) => [name, new TextEncoder().encode(text)]));

describe("template ZIP detection", () => {
  it.each([
    ["astro", { "index.html": "<h1>Funding</h1>", "_astro/site.css": "h1{}" }],
    ["astro", { "index.html": '<meta name="generator" content="Astro v5"><h1>Funding</h1>' }],
    ["bolt_static", { "index.html": "<h1>Funding</h1>", "assets/site.css": "h1{}" }],
    ["vite_react", { "index.html": '<div id="root"></div><script type="module" src="/assets/index-abc.js"></script>', "assets/index-abc.js": "built" }],
  ] as const)("detects %s from built files", (expected, fixture) => {
    expect(detectTemplateZip(files(fixture))).toBe(expected);
  });

  it("unwraps dist and a containing folder, ignoring OS metadata", () => {
    const wrapped = files({ "site/dist/index.html": "<h1>Funding</h1>", "site/dist/_astro/site.css": "h1{}", "__MACOSX/site": "junk", ".DS_Store": "junk" });
    expect([...templateZipRoot(wrapped).keys()]).toEqual(["index.html", "_astro/site.css"]);
    expect(detectTemplateZip(wrapped)).toBe("astro");
  });

  it("chooses dist over the source project's root index", () => {
    const project = files({ "index.html": '<script src="/src/main.tsx"></script>', "package.json": "{}", "dist/index.html": "<h1>Built</h1>" });
    expect([...templateZipRoot(project).keys()]).toEqual(["index.html"]);
    expect(detectTemplateZip(project)).toBe("bolt_static");
  });

  it.each<Record<string, string>>([
    { "package.json": "{}", "src/pages/index.astro": "<h1>Source</h1>" },
    { "index.html": '<script type="module" src="/src/main.tsx"></script>', "src/main.tsx": "source" },
    { "index.html": '<script src="/main.jsx"></script>' },
    { "vite.config.js": "export default {}", "index.html": "<h1>Source</h1>" },
    { "readme.txt": "No built site" },
  ])("rejects source projects and missing index with a build instruction", (fixture) => {
    expect(() => detectTemplateZip(files(fixture))).toThrow("Upload the built dist folder");
  });

  it("validates editable IDs and trims names", () => {
    expect(TemplateZipImportRequest.parse({ template_id: "custom-slug", template_name: " Harbor " })).toEqual({ template_id: "custom-slug", template_name: "Harbor" });
    for (const id of ["x", "../evil", "Upper Case", "a".repeat(64)]) {
      expect(TemplateZipImportRequest.safeParse({ template_id: id, template_name: "Harbor" }).success).toBe(false);
    }
  });
});
