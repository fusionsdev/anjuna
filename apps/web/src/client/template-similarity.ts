import { TemplateSubmitIssue } from "@anjuna/contracts";

/**
 * The similarity checks a template version failed, as owner-facing Thai lines. Pure, so the approve route on the
 * server and the Templates drawer count the same failures and say the same number.
 *
 * Template MCP stores one `similarity` issue per failing comparison in a check's `warning_issues` (identity scan)
 * and again in `import_warnings` (import), so the same fix text can appear twice. Each distinct fix is one line.
 */

/** Thai names of the fingerprint signals template-mcp compares (fingerprint.ts SIGNAL_FIXES). */
const SIGNAL_TEXT: Record<string, string> = {
  text: "ข้อความบนหน้าคล้ายกัน",
  dom: "โครงหน้าคล้ายกัน",
  classes: "ชุดสไตล์คล้ายกัน",
  sections: "ลำดับส่วนต่างๆ ของหน้าคล้ายกัน",
  images: "ใช้รูปภาพซ้ำกัน",
};

// "<label>: <english fix> (<signal> similarity 0.52)" and "<label>: redesign ...; overall similarity 0.81 is above 0.7."
const SIGNAL_LINE = /^(.+?): .*\((text|dom|classes|sections|images) similarity ([\d.]+)\)\s*$/;
const OVERALL_LINE = /^(.+?): .*overall similarity ([\d.]+) is above/;

const percent = (value: string) => `${Math.round(Number(value) * 100)}%`;

/** One failing comparison in plain Thai. Text in another shape shows as stored behind a Thai lead-in, never as a bare English line. */
export function similarityLine(fix: string): string {
  const signal = SIGNAL_LINE.exec(fix);
  if (signal) return `${signal[1]}: ${SIGNAL_TEXT[signal[2]!]} ${percent(signal[3]!)}`;
  const overall = OVERALL_LINE.exec(fix);
  if (overall) return `${overall[1]}: ภาพรวมคล้ายกัน ${percent(overall[2]!)}`;
  return `ข้อความเช็กความซ้ำ: ${fix}`;
}

function similarityIssues(details: unknown): TemplateSubmitIssue[] {
  if (!details || typeof details !== "object") return [];
  const record = details as Record<string, unknown>;
  return (["warning_issues", "import_warnings"] as const).flatMap((key) => {
    const parsed = TemplateSubmitIssue.array().safeParse(record[key]);
    return parsed.success ? parsed.data.filter((issue) => issue.rule === "similarity") : [];
  });
}

/** True when an identity scan recorded `similarity.pass: false`. */
function similarityFailed(details: unknown): boolean {
  const similarity = (details as { similarity?: { pass?: unknown } } | null | undefined)?.similarity;
  return similarity?.pass === false;
}

/**
 * The distinct failing similarity lines of a version's latest checks. A failed scan that stored no issue still
 * counts as one line, so the gate never opens on a FAIL it cannot list.
 */
export function similarityFailures(checks: ReadonlyArray<{ details: unknown }>): string[] {
  const lines = new Set<string>();
  for (const check of checks) for (const issue of similarityIssues(check.details)) lines.add(similarityLine(issue.fix));
  if (lines.size === 0 && checks.some((check) => similarityFailed(check.details))) lines.add("เช็กความซ้ำไม่ผ่าน");
  return [...lines];
}

/** The refusal the approve button and the approve route both show. */
export const approveBlockedText = (count: number): string => `ยังอนุมัติไม่ได้: เช็กความซ้ำไม่ผ่าน ${count} ข้อ`;

/** The warning on a version approved before the gate existed. */
export const approvedWithFailuresText = (count: number): string => `อนุมัติไปแล้ว แต่เช็กความซ้ำไม่ผ่าน ${count} ข้อ`;
