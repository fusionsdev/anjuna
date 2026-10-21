/**
 * Adapter: delegates contract checking to @anjuna/template-cert (packages/template-cert).
 * Keeps the checkTemplate API that tools.ts expects while removing duplicated check logic.
 */
import { runChecks } from "@anjuna/template-cert";
import type { Source } from "@anjuna/template-cert";
import type { FileMap } from "./archive.js";

export interface Issue {
  rule: string;
  severity: "error" | "warning";
  file?: string;
  message: string;
  fix?: string;
}

export interface OtherBrand {
  brand_id?: string;
  name: string;
  domain: string;
}

export interface CheckReport {
  pass: boolean;
  summary: string;
  errors: number;
  warnings: number;
  issues: Issue[];
  stats: { files: number; html_pages: number; bytes: number };
}

export interface NormalizedRoot {
  files: FileMap;
  notes: Issue[];
}

/**
 * Strip OS junk and unwrap a wrapping folder (e.g. "dist/") so builders who zip the folder
 * itself rather than its contents still get a real check.
 */
export function normalizeRoot(input: FileMap): NormalizedRoot {
  const notes: Issue[] = [];
  let files: FileMap = new Map();
  for (const [path, bytes] of input) {
    if (path.startsWith("__MACOSX/") || path.split("/").some((s) => s === ".DS_Store")) continue;
    files.set(path, bytes);
  }
  if (!files.has("index.html")) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0]!));
    const candidates = tops.size === 1 && files.has(`${[...tops][0]}/index.html`) ? [[...tops][0]!] : [];
    if (files.has("dist/index.html")) candidates.unshift("dist");
    const wrap = candidates[0];
    if (wrap) {
      const prefix = `${wrap}/`;
      const stripped: FileMap = new Map();
      for (const [path, bytes] of files) if (path.startsWith(prefix)) stripped.set(path.slice(prefix.length), bytes);
      files = stripped;
      notes.push({
        rule: "static-output",
        severity: "warning",
        message: `The archive wraps the site in a "${wrap}/" folder; it was unwrapped for this check.`,
        fix: `Zip the contents of ${wrap}/ (index.html at the archive root), not the folder itself.`,
      });
    }
  }
  return { files, notes };
}

export function checkTemplate(input: FileMap, opts: { otherBrands?: OtherBrand[] } = {}): CheckReport {
  const { files, notes } = normalizeRoot(input);
  const source: Source = { label: "template", files };
  const denyDomains = (opts.otherBrands ?? []).map((b) => b.domain);
  const denyIdentifiers = (opts.otherBrands ?? []).flatMap((b) => [b.name, ...(b.brand_id ? [b.brand_id] : [])]);
  const result = runChecks(source, { denyDomains, denyIdentifiers });

  const certIssues: Issue[] = result.checks.flatMap((c) =>
    c.issues.map((i) => ({
      rule: i.checkId,
      severity: i.severity,
      file: i.location || undefined,
      message: i.en,
    })),
  );

  const issues = [...notes, ...certIssues];
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const htmlPages = [...files.keys()].filter((k) => /\.html?$/i.test(k)).length;
  const bytes = [...files.values()].reduce((n, b) => n + b.byteLength, 0);

  return {
    pass: errors === 0,
    summary: errors === 0
      ? `PASS: template meets the contract${warnings ? ` (${warnings} warning(s))` : ""}.`
      : `FAIL: ${errors} error(s), ${warnings} warning(s). Fix every error and re-run check_template.`,
    errors,
    warnings,
    issues,
    stats: { files: files.size, html_pages: htmlPages, bytes },
  };
}
