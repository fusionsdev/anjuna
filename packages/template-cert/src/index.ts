import type { Check, CheckContext } from "./checks.js";
import { structure } from "./checks/structure.js";
import { meta } from "./checks/meta.js";
import { keyword } from "./checks/keyword.js";
import { cta } from "./checks/cta.js";
import { pii } from "./checks/pii.js";
import { wording } from "./checks/wording.js";
import { external } from "./checks/external.js";
import { brand } from "./checks/brand.js";
import { links } from "./checks/links.js";
import type { CheckOutcome, CheckResult, CheckerOptions, Issue, LoadFailure, RuleId, Severity } from "./types.js";
import type { Source } from "./workspace.js";

interface CheckDef {
  rule: RuleId;
  name: string;
  nameTh: string;
  run: Check;
}

const CHECKS: readonly CheckDef[] = [
  { rule: "structure", name: "Structure & required pages", nameTh: "โครงสร้างและหน้าที่จำเป็น", run: (ctx) => [...structure(ctx), ...meta(ctx)] },
  { rule: "keyword", name: "Keyword slot in the H1", nameTh: "ช่องคำค้นใน H1", run: keyword },
  { rule: "cta", name: "CTA form", nameTh: "ฟอร์ม CTA", run: cta },
  { rule: "pii", name: "Personal-data inputs & extra forms", nameTh: "ช่องข้อมูลส่วนตัวและฟอร์มอื่น", run: pii },
  { rule: "wording", name: "Banned wording & guarantees", nameTh: "คำต้องห้ามและการรับประกัน", run: wording },
  { rule: "external", name: "External scripts, trackers & fonts", nameTh: "สคริปต์ภายนอก ตัวติดตาม และฟอนต์", run: external },
  { rule: "brand", name: "Platform & other-brand identifiers", nameTh: "ชื่อแพลตฟอร์มและแบรนด์อื่น", run: brand },
  { rule: "links", name: "Broken links & assets", nameTh: "ลิงก์และไฟล์ที่อ้างอิง", run: links },
];

function outcome(def: CheckDef, issues: Issue[]): CheckOutcome {
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const status: CheckOutcome["status"] = errorCount > 0 ? "fail" : issues.length > 0 ? "warn" : "pass";
  return { rule: def.rule, name: def.name, nameTh: def.nameTh, status, issues };
}

export function runChecks(source: Source, options: CheckerOptions = {}): CheckResult {
  const ctx: CheckContext = { source, denyDomains: [...(options.denyDomains ?? [])] };
  const checks = CHECKS.map((def) => outcome(def, def.run(ctx)));
  const errors = checks.reduce((n, c) => n + c.issues.filter((i) => i.severity === "error").length, 0);
  const warnings = checks.reduce((n, c) => n + c.issues.filter((i) => i.severity === "warning").length, 0);
  return {
    label: options.label ?? source.label,
    source: source.label,
    ok: errors === 0,
    errors,
    warnings,
    checks,
  };
}

export { CHECKS };
export { loadSource, DIST_LIMITS } from "./workspace.js";
export type { Source } from "./workspace.js";
export type { Issue, RuleId, CheckResult, CheckOutcome, CheckerOptions, LoadFailure, Severity };