import { hasNoElementChildren, parseHtml } from "../html.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";

export const keyword: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];
  const indexBytes = source.files.get("index.html");
  if (!indexBytes) return issues;

  const root = parseHtml(new TextDecoder("utf-8").decode(indexBytes));

  const h1s = root.querySelectorAll("h1");
  if (h1s.length !== 1) {
    issues.push(
      err(
        "keyword",
        "index.html",
        `The landing page needs exactly one <h1>, but found ${h1s.length}. Put the keyword slot inside a single <h1>.`,
        `หน้า landing ต้องมี <h1> เพียงอันเดียว แต่พบ ${h1s.length} อัน กรุณาใส่ช่องคำค้นไว้ใน <h1> เดียว`,
      ),
    );
  }

  const spans = root.querySelectorAll("[data-kw]");
  if (spans.length === 0) {
    issues.push(
      err(
        "keyword",
        "index.html",
        'There is no <span data-kw> on the page. Add exactly one keyword slot inside the <h1>, for example <h1><span data-kw>Funding Options</span> …</h1>.',
        'ไม่พบ <span data-kw> ในหน้า กรุณาเพิ่มช่องคำค้นหนึ่งช่องไว้ใน <h1> เช่น <h1><span data-kw>Funding Options</span> …</h1>',
      ),
    );
  } else if (spans.length > 1) {
    issues.push(
      err(
        "keyword",
        "index.html",
        `Found ${spans.length} <span data-kw> elements. There must be exactly one. Keep a single keyword slot.`,
        `พบ <span data-kw> จำนวน ${spans.length} อัน ต้องมีเพียงอันเดียวเท่านั้น กรุณาเก็บช่องคำค้นไว้ช่องเดียว`,
      ),
    );
  } else {
    const span = spans[0]!;
    const inH1 = root.querySelectorAll("h1 [data-kw]").length === 1;
    if (!inH1) {
      issues.push(
        err(
          "keyword",
          "index.html",
          'The <span data-kw> is not inside the <h1>. Move it so it reads <h1><span data-kw>…</span> …</h1>.',
          '<span data-kw> ไม่อยู่ใน <h1> กรุณาย้ายให้อยู่ในรูปแบบ <h1><span data-kw>…</span> …</h1>',
        ),
      );
    }
    const text = span.textContent.trim();
    if (!text) {
      issues.push(
        err(
          "keyword",
          "index.html",
          'The <span data-kw> has no fallback text. Put default wording inside it, e.g. <span data-kw>Funding Options</span>.',
          '<span data-kw> ไม่มีข้อความเริ่มต้น กรุณาใส่ข้อความ เช่น <span data-kw>Funding Options</span>',
        ),
      );
    }
    if (!hasNoElementChildren(span)) {
      issues.push(
        err(
          "keyword",
          "index.html",
          'The <span data-kw> contains nested elements. It must be plain text only (no icons, no line breaks inside it).',
          '<span data-kw> มีแท็กซ้อนอยู่ข้างใน ต้องเป็นข้อความธรรมดาเท่านั้น (ห้ามใส่ไอคอนหรือขึ้นบรรทัดใหม่ข้างใน)',
        ),
      );
    }
  }

  // data-kw must not appear on any other page.
  for (const [path, bytes] of source.files) {
    if (path === "index.html") continue;
    if (!/\.html?$/.test(path)) continue;
    const html = new TextDecoder("utf-8").decode(bytes);
    if (/data-kw/i.test(html)) {
      issues.push(
        err(
          "keyword",
          path,
          '"data-kw" appears on a page other than index.html. The keyword slot belongs only on the landing page.',
          'พบ "data-kw" ในหน้าอื่นที่ไม่ใช่ index.html ช่องคำค้นต้องอยู่ที่หน้า landing เท่านั้น',
        ),
      );
    }
  }

  return issues;
};