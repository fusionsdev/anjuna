import { TEMPLATE_RULES, isExternalUrl } from "@anjuna/contracts";
import { attrLower, parseHtml } from "../html.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";
import type { HTMLElement } from "node-html-parser";

const BANNED_INPUT_TYPES = new Set(["email", "tel", "password"]);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Curated token list: exact normalized matches plus strong substring keys. */
const EXACT_TOKENS = new Set<string>(
  (TEMPLATE_RULES.forbiddenInputNames as readonly string[]).map(normalizeName).concat([
    "fullname", "emailaddress", "phonenumber", "telephone", "mobilenumber", "contactnumber",
    "socialsecurity", "socialsecuritynumber", "taxid", "dateofbirth", "birthday", "streetaddress",
    "bankname", "bankaccount", "accountnumber", "accountname", "annualincome", "salary",
    "employername", "passport", "driverlicense", "cardnumber", "cvv",
  ]),
);

/** Strong, unambiguous PII substrings: a name containing any of these is flagged. */
const SUBSTRING_KEYS = [
  "email", "phone", "telephone", "ssn", "socialsecurity", "dob", "birthdate", "birthday",
  "bank", "routing", "income", "salary", "employer", "cardnumber", "cvv",
] as const;

function isPiiName(name: string): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  if (EXACT_TOKENS.has(n)) return true;
  return SUBSTRING_KEYS.some((k) => n.includes(k));
}

function describePii(name: string): string {
  return name || "(unnamed)";
}

export const pii: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];

  for (const [path, bytes] of source.files) {
    if (!/\.html?$/.test(path)) continue;
    const root = parseHtml(new TextDecoder("utf-8").decode(bytes));

    // 1. PII inputs / banned input types anywhere.
    for (const el of root.querySelectorAll("input, select, textarea")) {
      const name = (el.getAttribute("name") ?? "").trim();
      const type = attrLower(el, "type");
      if (el.tagName.toLowerCase() === "select") {
        if (name && isPiiName(name)) {
          issues.push(
            err(
              "pii",
              `${path}:${el.rawTagName.slice(0, 60)}`,
              `The page collects "${describePii(name)}", which is personal information. The landing page may only collect the amount and ZIP; the secure form collects the rest.`,
              `หน้ารวบรวมข้อมูล "${describePii(name)}" ซึ่งเป็นข้อมูลส่วนตัว หน้า landing เก็บได้แค่จำนวนเงินกับรหัสไปรษณีย์ ส่วนข้อมูลอื่นเก็บที่ฟอร์มปลอดภัย`,
            ),
          );
        }
        continue;
      }
      if (el.tagName.toLowerCase() === "textarea") {
        if (name && isPiiName(name)) {
          issues.push(
            err(
              "pii",
              `${path}:textarea`,
              `The page collects "${describePii(name)}" in a textarea, which is personal information. Remove it from the landing page.`,
              `หน้ารวบรวมข้อมูล "${describePii(name)}" ใน textarea ซึ่งเป็นข้อมูลส่วนตัว กรุณาลบออกจากหน้า landing`,
            ),
          );
        }
        continue;
      }
      // input
      if (BANNED_INPUT_TYPES.has(type)) {
        issues.push(
          err(
            "pii",
            `${path}:${el.rawTagName.slice(0, 60)}`,
            `An input uses type="${type}", which collects personal information. Use only the amount select and a plain 5-digit ZIP input.`,
            `มีช่อง input ใช้ type="${type}" ซึ่งเก็บข้อมูลส่วนตัว กรุณาใช้เฉพาะ select จำนวนเงินกับช่องรหัสไปรษณีย์ 5 หลักเท่านั้น`,
          ),
        );
      }
      if (name && isPiiName(name)) {
        issues.push(
          err(
            "pii",
            `${path}:${el.rawTagName.slice(0, 60)}`,
            `The page collects "${describePii(name)}", which is personal information. Only "requested_amount" and "zip" belong on the landing page.`,
            `หน้ารวบรวมข้อมูล "${describePii(name)}" ซึ่งเป็นข้อมูลส่วนตัว หน้า landing เก็บได้แค่ "requested_amount" กับ "zip"`,
          ),
        );
      }
    }

    // 2. No other (non-CTA) forms, and no posting forms.
    for (const form of root.querySelectorAll("form")) {
      const isCta = form.getAttribute("data-cta") !== undefined;
      if (!isCta) {
        issues.push(
          err(
            "pii",
            `${path}:${form.rawTagName.slice(0, 60)}`,
            "There is a form that is not the CTA (missing data-cta). The landing must contain exactly one form: the amount-and-ZIP form. Remove the extra form.",
            "พบฟอร์มที่ไม่ใช่ CTA (ไม่มี data-cta) หน้า landing ต้องมีฟอร์มเดียวคือฟอร์มจำนวนเงินกับรหัสไปรษณีย์ กรุณาลบฟอร์มอื่นออก",
          ),
        );
      }
      const method = attrLower(form, "method");
      if (method === "post") {
        issues.push(
          err(
            "pii",
            `${path}:${form.rawTagName.slice(0, 60)}`,
            'A form posts with method="post". No form on the landing may post anywhere; the CTA must submit with method="get" to action="/go".',
            'พบฟอร์มที่ใช้ method="post" ฟอร์มในหน้า landing ห้าม post ไปที่ใด ฟอร์ม CTA ต้องใช้ method="get" ไปที่ action="/go"',
          ),
        );
      }
      const action = (form.getAttribute("action") ?? "").trim();
      if (action && isExternalUrl(action)) {
        issues.push(
          err(
            "pii",
            `${path}:${form.rawTagName.slice(0, 60)}`,
            `A form sends to an outside address (${action}). No form on the landing may post anywhere; the CTA must submit to action="/go".`,
            `ฟอร์มส่งข้อมูลไปที่ภายนอก (${action}) ฟอร์มในหน้า landing ห้ามส่งไปที่ใด ฟอร์ม CTA ต้องส่งไปที่ action="/go"`,
          ),
        );
      }
    }
  }

  return issues;
};