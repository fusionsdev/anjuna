import { attrLower, parseHtml } from "../html.js";
import { err } from "../issue.js";
import { CANONICAL_AMOUNT_BUCKETS, isCanonicalAmount } from "../buckets.js";
import type { Check } from "../checks.js";

const EXPECTED_VALUES = CANONICAL_AMOUNT_BUCKETS.map((n) => String(n)).join(", ");

function isFiveDigitConstraint(pattern: string | undefined, maxlength: string | undefined, inputmode: string | undefined): boolean {
  if (maxlength === "5") return true;
  if (!pattern) return false;
  try {
    const re = new RegExp(`^(?:${pattern})$`);
    return re.test("12345") && !re.test("1234") && !re.test("123456");
  } catch {
    return false;
  }
}

export const cta: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];
  const indexBytes = source.files.get("index.html");
  if (!indexBytes) return issues;

  const root = parseHtml(new TextDecoder("utf-8").decode(indexBytes));
  const forms = root.querySelectorAll("form[data-cta]");

  if (forms.length === 0) {
    issues.push(
      err(
        "cta",
        "index.html",
        'No CTA form found. Add exactly one <form method="get" action="/go" data-cta> containing the amount and ZIP fields.',
        'ไม่พบฟอร์ม CTA กรุณาเพิ่ม <form method="get" action="/go" data-cta> หนึ่งฟอร์ม พร้อมช่องจำนวนเงินและรหัสไปรษณีย์',
      ),
    );
    return issues;
  }
  if (forms.length > 1) {
    issues.push(
      err(
        "cta",
        "index.html",
        `Found ${forms.length} CTA forms (data-cta). There must be exactly one.`,
        `พบฟอร์ม CTA (data-cta) จำนวน ${forms.length} ฟอร์ม ต้องมีเพียงอันเดียว`,
      ),
    );
  }

  const form = forms[0]!;
  const method = attrLower(form, "method");
  const action = (form.getAttribute("action") ?? "").trim();

  if (method !== "get") {
    issues.push(
      err(
        "cta",
        "index.html",
        `The CTA form must submit with method="get", but it uses method="${method || '(none)'}".`,
        `ฟอร์ม CTA ต้องใช้ method="get" แต่ตอนนี้ใช้ method="${method || '(ไม่มี)'}"`,
      ),
    );
  }
  if (action !== "/go") {
    issues.push(
      err(
        "cta",
        "index.html",
        `The CTA form must send to action="/go", but it uses action="${action || '(none)'}".`,
        `ฟอร์ม CTA ต้องส่งไปที่ action="/go" แต่ตอนนี้ใช้ action="${action || '(ไม่มี)'}"`,
      ),
    );
  }

  // Enumerate the named fields inside the CTA.
  const namedFields = form.querySelectorAll("input, select, textarea");
  const names = new Set<string>();
  const missingName: string[] = [];
  for (const el of namedFields) {
    const name = (el.getAttribute("name") ?? "").trim();
    if (!name) {
      missingName.push(el.tagName.toLowerCase());
      continue;
    }
    names.add(name);
  }

  if (missingName.length > 0) {
    issues.push(
      err(
        "cta",
        "index.html",
        "The CTA form has a field without a name attribute. Every field must be named requested_amount or zip.",
        "ฟอร์ม CTA มีช่องที่ไม่มี name attribute ทุกช่องต้องตั้งชื่อเป็น requested_amount หรือ zip เท่านั้น",
      ),
    );
  }

  for (const name of names) {
    if (name !== "requested_amount" && name !== "zip") {
      issues.push(
        err(
          "cta",
          "index.html",
          `The CTA form has an unexpected field "${name}". Only "requested_amount" and "zip" are allowed; do not add hidden or extra inputs.`,
          `ฟอร์ม CTA มีช่อง "${name}" ซึ่งเกินจำเป็น อนุญาตแค่ "requested_amount" และ "zip" เท่านั้น อย่าเพิ่มช่องอื่นหรือ hidden input`,
        ),
      );
    }
  }

  if (!names.has("requested_amount")) {
    issues.push(
      err(
        "cta",
        "index.html",
        'The CTA form is missing the "requested_amount" field. Add a <select name="requested_amount"> (or radio group) with the allowed amounts.',
        'ฟอร์ม CTA ยังไม่มีช่อง "requested_amount" กรุณาเพิ่ม <select name="requested_amount"> หรือกลุ่ม radio พร้อมตัวเลือกจำนวนเงิน',
      ),
    );
  }
  if (!names.has("zip")) {
    issues.push(
      err(
        "cta",
        "index.html",
        'The CTA form is missing the "zip" field. Add a 5-digit ZIP input, e.g. <input name="zip" inputmode="numeric" pattern="[0-9]{5}" required>.',
        'ฟอร์ม CTA ยังไม่มีช่อง "zip" กรุณาเพิ่มช่องรหัสไปรษณีย์ 5 หลัก เช่น <input name="zip" inputmode="numeric" pattern="[0-9]{5}" required>',
      ),
    );
  }

  // requested_amount must be a select or radio group, limited to canonical buckets.
  const amountEls = namedFields.filter((el) => (el.getAttribute("name") ?? "").trim() === "requested_amount");
  if (amountEls.length > 0) {
    const selects = amountEls.filter((el) => el.tagName.toLowerCase() === "select");
    const radios = amountEls.filter((el) => el.tagName.toLowerCase() === "input" && attrLower(el, "type") === "radio");
    const bad = amountEls.filter((el) => el.tagName.toLowerCase() !== "select" && !(el.tagName.toLowerCase() === "input" && attrLower(el, "type") === "radio"));

    if (bad.length > 0) {
      issues.push(
        err(
          "cta",
          "index.html",
          '"requested_amount" must be a <select> or a radio group, not a free-text field. Change it so the visitor can only pick an allowed amount.',
          '"requested_amount" ต้องเป็น <select> หรือกลุ่ม radio ไม่ใช่ช่องกรอกอิสระ กรุณาเปลี่ยนให้ผู้ใช้เลือกจำนวนเงินได้เท่านั้น',
        ),
      );
    }

    const values: string[] = [];
    for (const s of selects) {
      for (const opt of s.querySelectorAll("option")) {
        const v = opt.getAttribute("value");
        if (v === undefined) continue;
        values.push(v);
      }
    }
    for (const r of radios) {
      const v = r.getAttribute("value");
      if (v !== undefined) values.push(v);
    }

    if (values.length === 0) {
      issues.push(
        err(
          "cta",
          "index.html",
          `The requested_amount field has no option values. Add options with values from: ${EXPECTED_VALUES}.`,
          `ช่อง requested_amount ยังไม่มีค่าตัวเลือก กรุณาเพิ่ม option ที่มีค่า: ${EXPECTED_VALUES}`,
        ),
      );
    } else {
      const nonCanonical = values.filter((v) => !isCanonicalAmount(v.trim()));
      if (nonCanonical.length > 0) {
        issues.push(
          err(
            "cta",
            "index.html",
            `requested_amount offers a value that is not allowed: ${nonCanonical.map((v) => `"${v}"`).join(", ")}. Use only these amounts: ${EXPECTED_VALUES}.`,
            `requested_amount มีค่าที่ไม่อนุญาต: ${nonCanonical.map((v) => `"${v}"`).join(", ")} ใช้ได้เฉพาะ: ${EXPECTED_VALUES}`,
          ),
        );
      }
    }
  }

  // zip must constrain to 5 digits.
  const zipEls = namedFields.filter((el) => (el.getAttribute("name") ?? "").trim() === "zip");
  if (zipEls.length > 0) {
    for (const z of zipEls) {
      const type = attrLower(z, "type");
      if (type === "" || type === "text" || type === "number") {
        const pattern = z.getAttribute("pattern") ?? undefined;
        const maxlength = z.getAttribute("maxlength") ?? undefined;
        const inputmode = z.getAttribute("inputmode") ?? undefined;
        if (!isFiveDigitConstraint(pattern, maxlength, inputmode)) {
          issues.push(
            err(
              "cta",
              "index.html",
              'The "zip" input is not restricted to 5 digits. Add pattern="[0-9]{5}" (or maxlength="5") and inputmode="numeric".',
              'ช่อง "zip" ยังไม่จำกัดให้เป็น 5 หลัก กรุณาเพิ่ม pattern="[0-9]{5}" (หรือ maxlength="5") และ inputmode="numeric"',
            ),
          );
        }
      } else {
        issues.push(
          err(
            "cta",
            "index.html",
            `The "zip" input uses type="${type}". It must be a plain 5-digit numeric field (type="text" with pattern="[0-9]{5}").`,
            `ช่อง "zip" ใช้ type="${type}" ต้องเป็นช่องตัวเลข 5 หลักธรรมดา (type="text" พร้อม pattern="[0-9]{5}")`,
          ),
        );
      }
    }
  }

  return issues;
};