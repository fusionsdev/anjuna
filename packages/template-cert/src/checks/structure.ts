import { DIST_LIMITS } from "../workspace.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";

const REQUIRED_PAGES = [
  { slug: "privacy", display: "/privacy/" },
  { slug: "terms", display: "/terms/" },
  { slug: "disclosures", display: "/disclosures/" },
  { slug: "do-not-sell", display: "/do-not-sell/" },
] as const;

/** Extensions / file names that only make sense on a server. A static dist must not ship them. */
const SERVER_FILE = /\.(php|phtml|py|rb|pl|cgi|jsp|asp|aspx|cfm|exe|dll|so|dylib|sh|bat|cmd|ps1)$/i;
const SERVER_NAMES = new Set(["_worker.js", "_routes.json", "middleware.js", "middleware.ts"]);

export const structure: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];
  const files = source.files;

  if (!files.has("index.html")) {
    issues.push(
      err(
        "structure",
        "",
        'The entry page "index.html" is missing. Your static build must place the landing page at dist/index.html.',
        'ไม่พบหน้าแรก "index.html" ไฟล์ landing ต้องอยู่ที่ dist/index.html',
      ),
    );
  }

  for (const page of REQUIRED_PAGES) {
    if (!files.has(`${page.slug}/index.html`) && !files.has(`${page.slug}/index.htm`)) {
      issues.push(
        err(
          "structure",
          page.slug,
          `The required page "${page.display}" is missing. Add a file at dist/${page.slug}/index.html.`,
          `ไม่พบหน้าที่จำเป็น "${page.display}" กรุณาเพิ่มไฟล์ที่ dist/${page.slug}/index.html`,
        ),
      );
    }
  }

  let totalBytes = 0;
  let count = 0;
  for (const [path, bytes] of files) {
    totalBytes += bytes.length;
    count += 1;
    if (SERVER_NAMES.has(path.split("/").pop()!)) {
      issues.push(
        err(
          "structure",
          path,
          `"${path.split("/").pop()}" is server-side code, which is not allowed in a static template. Remove it.`,
          `"${path.split("/").pop()}" เป็นโค้ดฝั่งเซิร์ฟเวอร์ ซึ่งไม่ได้รับอนุญาตใน template แบบ static กรุณาลบออก`,
        ),
      );
    }
    if (SERVER_FILE.test(path)) {
      issues.push(
        err(
          "structure",
          path,
          `"${path}" looks like a server-side or executable file. A template must be static files only (HTML, CSS, JS, images). Remove it.`,
          `"${path}" ดูเหมือนเป็นไฟล์ฝั่งเซิร์ฟเวอร์หรือไฟล์สั่งงาน template ต้องมีเฉพาะไฟล์ static (HTML, CSS, JS, รูปภาพ) เท่านั้น กรุณาลบออก`,
        ),
      );
    }
  }

  if (totalBytes > DIST_LIMITS.maxBytes) {
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    issues.push(
      err(
        "structure",
        "",
        `The build is ${mb} MB, larger than the ${DIST_LIMITS.maxBytes / 1024 / 1024} MB limit. Compress images and remove unused assets.`,
        `ไฟล์ build มีขนาด ${mb} MB ซึ่งเกินขีดจำกัด ${DIST_LIMITS.maxBytes / 1024 / 1024} MB กรุณาบีบอัดรูปภาพและลบไฟล์ที่ไม่ใช้`,
      ),
    );
  }

  if (count > DIST_LIMITS.maxFiles) {
    issues.push(
      err(
        "structure",
        "",
        `The build has ${count} files, more than the ${DIST_LIMITS.maxFiles} file limit. Remove unused assets.`,
        `build นี้มี ${count} ไฟล์ ซึ่งเกินขีดจำกัด ${DIST_LIMITS.maxFiles} ไฟล์ กรุณาลบไฟล์ที่ไม่จำเป็น`,
      ),
    );
  }

  return issues;
};