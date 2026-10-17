import { SITE_TEXT_LIMITS } from "@anjuna/contracts";
import type { HTMLElement } from "node-html-parser";
import { parseHtml } from "../html.js";
import { err, warn } from "../issue.js";
import type { Check } from "../checks.js";
import type { Issue } from "../types.js";

/** The dashboard keeps at most this many characters. */
export const TITLE_MAX = SITE_TEXT_LIMITS.title;
export const DESCRIPTION_MAX = SITE_TEXT_LIMITS.description;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/** Page text the dashboard edits: <title> and meta description on index.html, data-brand on brand name elements. */
export const meta: Check = ({ source }) => {
  const issues: Issue[] = [];
  const index = source.files.get("index.html");
  if (index) {
    const root = parseHtml(decode(index));
    const title = squash(root.querySelector("title")?.textContent ?? "");
    if (!title) {
      issues.push(err("structure", "index.html",
        `The landing page has no <title>. Add <title>Your Brand | Short Promise</title> inside <head>; the dashboard uses it as the default page title (up to ${TITLE_MAX} characters).`,
        `หน้า landing ไม่มี <title> กรุณาเพิ่ม <title>ชื่อแบรนด์ | ข้อความสั้น</title> ใน <head> แดชบอร์ดใช้เป็นชื่อหน้าเริ่มต้น (ไม่เกิน ${TITLE_MAX} ตัวอักษร)`));
    } else if (title.length > TITLE_MAX) {
      issues.push(warn("structure", "index.html",
        `The <title> has ${title.length} characters; the dashboard keeps only the first ${TITLE_MAX}. Shorten it.`,
        `<title> ยาว ${title.length} ตัวอักษร แดชบอร์ดเก็บเพียง ${TITLE_MAX} ตัวแรก กรุณาย่อให้สั้นลง`));
    }
    const description = squash(root.querySelector('meta[name="description"]')?.getAttribute("content") ?? "");
    if (!description) {
      issues.push(err("structure", "index.html",
        `The landing page has no <meta name="description" content="...">. Add one sentence (up to ${DESCRIPTION_MAX} characters) that describes the offer.`,
        `หน้า landing ไม่มี <meta name="description" content="..."> กรุณาเพิ่มคำอธิบายหนึ่งประโยค (ไม่เกิน ${DESCRIPTION_MAX} ตัวอักษร)`));
    } else if (description.length > DESCRIPTION_MAX) {
      issues.push(warn("structure", "index.html",
        `The meta description has ${description.length} characters; the dashboard keeps only the first ${DESCRIPTION_MAX}. Shorten it.`,
        `meta description ยาว ${description.length} ตัวอักษร แดชบอร์ดเก็บเพียง ${DESCRIPTION_MAX} ตัวแรก กรุณาย่อให้สั้นลง`));
    }
  }

  const slots: { path: string; element: HTMLElement }[] = [];
  for (const [path, bytes] of source.files) {
    if (!/\.html?$/i.test(path)) continue;
    for (const element of parseHtml(decode(bytes)).querySelectorAll("[data-brand]")) slots.push({ path, element });
  }
  if (slots.length === 0 && [...source.files.keys()].some((path) => /\.html?$/i.test(path))) {
    issues.push(warn("structure", "",
      'No element has data-brand. Put data-brand on every element whose text is the brand name (header, footer, legal pages), e.g. <a href="/" data-brand>Harbor Funding</a>, so the dashboard can change the brand name on every page.',
      'ไม่พบ data-brand กรุณาใส่ data-brand ในทุกองค์ประกอบที่แสดงชื่อแบรนด์ (header, footer, หน้า legal) เช่น <a href="/" data-brand>Harbor Funding</a> เพื่อให้แดชบอร์ดเปลี่ยนชื่อแบรนด์ได้ทุกหน้า'));
  }
  for (const { path, element } of slots) {
    if (element.querySelectorAll("*").length > 0) {
      issues.push(warn("structure", path,
        "A data-brand element contains other elements. It must hold only the brand name text, because the dashboard replaces its whole content. Move icons and images outside it.",
        "องค์ประกอบ data-brand มีแท็กอื่นซ้อนอยู่ ต้องมีเฉพาะข้อความชื่อแบรนด์ เพราะแดชบอร์ดจะแทนที่เนื้อหาทั้งหมด กรุณาย้ายไอคอนและรูปภาพออกไปไว้ข้างนอก"));
    }
  }
  return issues;
};
