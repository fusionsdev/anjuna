import type { CheckResult } from "./types.js";

export function renderJson(result: CheckResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderHuman(result: CheckResult): string {
  const lines: string[] = [];
  lines.push(`Template check: ${result.label}`);
  lines.push(`Source: ${result.source}`);
  lines.push("");
  for (const c of result.checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
    lines.push(`[${mark}] ${c.rule} — ${c.name}`);
    if (c.nameTh !== c.name) lines.push(`        (${c.nameTh})`);
    for (const i of c.issues) {
      lines.push(`      EN: ${i.en}`);
      lines.push(`      TH: ${i.th}`);
      if (i.location) lines.push(`      @ ${i.location}`);
    }
  }
  lines.push("");
  lines.push(result.ok ? "Result: PASS" : "Result: FAIL");
  lines.push(`${result.errors} error(s), ${result.warnings} warning(s)`);
  return lines.join("\n");
}