import { FORBIDDEN_BRAND_STRINGS } from "@anjuna/contracts";
import { isTextLike } from "../html.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";

export function normalizeDenyDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme
  d = d.split(/[/?#]/)[0]!; // drop path/query/hash
  d = d.replace(/:\d+$/, ""); // drop port
  d = d.replace(/^www\./, ""); // drop leading www
  return d.replace(/\.+$/, "");
}

export const brand: Check = ({ source, denyDomains }) => {
  const issues: ReturnType<typeof err>[] = [];
  const deny = denyDomains.map(normalizeDenyDomain).filter((d) => d.length > 0);

  const scan = (path: string, text: string) => {
    const lower = text.toLowerCase();
    for (const word of FORBIDDEN_BRAND_STRINGS) {
      if (lower.includes(word)) {
        issues.push(
          err(
            "brand",
            path,
            `The platform name "${word}" must not appear anywhere in a brand's files. Rename or remove it.`,
            `ห้ามมีชื่อแพลตฟอร์ม "${word}" ปรากฏในไฟล์ของแบรนด์ กรุณาเปลี่ยนชื่อหรือลบออก`,
          ),
        );
      }
    }
    for (const domain of deny) {
      if (lower.includes(domain)) {
        issues.push(
          err(
            "brand",
            path,
            `The other brand's domain "${domain}" appears in the template. Remove every reference to it.`,
            `พบโดเมนของแบรนด์อื่น "${domain}" ใน template กรุณาลบการอ้างถึงทั้งหมด`,
          ),
        );
      }
    }
  };

  for (const [path, bytes] of source.files) {
    scan(path, path); // file names are brand bytes too
    if (!isTextLike(path, bytes)) continue;
    scan(path, new TextDecoder("utf-8").decode(bytes));
  }

  return issues;
};