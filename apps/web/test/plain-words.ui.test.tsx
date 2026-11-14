import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../src/client");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every piece of text the client can show: string and template literals and JSX text. Comments and identifiers are not read. */
function copyOf(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    else if (ts.isJsxText(node)) out.push(node.getText());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("plain words in client copy (FUS-393)", () => {
  it("has no drain route and no Test sold left in any client string", () => {
    const hits = files(ROOT).flatMap((path) => copyOf(path).filter((text) => /drain route|test sold|เส้นทาง drain/i.test(text)).map((text) => `${path.slice(ROOT.length + 1)}: ${text}`));
    expect(hits).toEqual([]);
  });

  it("finds the replacement words, so the scan reads the files it should", () => {
    const all = files(ROOT).flatMap(copyOf).join("\n");
    expect(all).toContain("ตั้งเส้นทางส่งยอดขาย");
    expect(all).toContain("ทดสอบการขาย");
    expect(all).toContain("ผลจากผู้ซื้อ");
  });
});
