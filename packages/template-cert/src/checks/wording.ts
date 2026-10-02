import { isTextLike } from "../html.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";

const PERSONAL_LOAN = /personal\s+loans?/i;

/** Misleading rate/approval/speed guarantees. Each has a short label for the message. */
const GUARANTEES: readonly { re: RegExp; label: string }[] = [
  { re: /guaranteed\s+approval/i, label: "guaranteed approval" },
  { re: /approval\s+guaranteed/i, label: "guaranteed approval" },
  { re: /no\s+credit\s+check/i, label: "no credit check" },
  { re: /instant\s+approval/i, label: "instant approval" },
  { re: /guaranteed\s+(?:loan|funding|rate|offer|amount)/i, label: "a guarantee of loan terms" },
];

function snippet(haystack: string, at: number | undefined, len: number): string {
  if (at === undefined) return "";
  const start = Math.max(0, at - 20);
  const end = Math.min(haystack.length, at + len + 20);
  return haystack.slice(start, end).replace(/\s+/g, " ").trim();
}

export const wording: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];

  const scanText = (path: string, text: string) => {
    if (PERSONAL_LOAN.test(text)) {
      const m = text.match(PERSONAL_LOAN);
      issues.push(
        err(
          "wording",
          path,
          `Forbidden wording "${m?.[0] ?? "personal loan"}" appears${m ? `: “…${snippet(text, m.index, m[0].length)}…”` : ""}. Use neutral wording like "funding options" or "loan options" instead.`,
          `พบคำต้องห้าม "${m?.[0] ?? "personal loan"}" / ใช้คำที่กลางๆ เช่น "ตัวเลือกแหล่งเงินทุน" หรือ "ตัวเลือกสินเชื่อ" แทน`,
        ),
      );
    }
    for (const g of GUARANTEES) {
      const m = text.match(g.re);
      if (m) {
        issues.push(
          err(
            "wording",
            path,
            `The page claims "${g.label}" ("…${snippet(text, m.index, m[0].length)}…"), a misleading guarantee. Remove approval, rate or speed guarantees.`,
            `หน้าสื่อสัญญา "${g.label}" ซึ่งเป็นการรับประกันที่ทำให้เข้าใจผิด กรุณาลบข้อความรับประกันการอนุมัติ อัตรา หรือความเร็วออก`,
          ),
        );
      }
    }
  };

  for (const [path, bytes] of source.files) {
    scanText(path, path); // file names are checked too
    if (!isTextLike(path, bytes)) continue;
    const text = new TextDecoder("utf-8").decode(bytes);
    scanText(path, text);
  }

  return issues;
};