import { isExternalUrl } from "@anjuna/contracts";
import { parseHtml } from "../html.js";
import { err } from "../issue.js";
import type { Check } from "../checks.js";

const RUNTIME_PREFIXES = ["go", "_f/", "api/", "_f"];

function isRuntimeOwned(p: string): boolean {
  return RUNTIME_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

/** Strip query/hash and return a clean internal path reference, or null to skip. */
function stripRef(url: string): string | null {
  let u = url.trim();
  if (u === "") return null;
  if (isExternalUrl(u)) return null;
  if (/^(?:#|data:|mailto:|tel:|javascript:|blob:|about:)/i.test(u)) return null;
  u = u.split(/[?#]/)[0] ?? "";
  if (u === "") return null;
  return u;
}

function joinPosix(baseDir: string, rel: string): string | null {
  const acc = baseDir ? baseDir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (acc.length === 0) return null; // escapes the root
      acc.pop();
    } else {
      acc.push(seg);
    }
  }
  return acc.join("/");
}

/** Resolve an internal ref against a referencing file's directory to a root-relative path. */
function resolveRef(currentPath: string, url: string): string | null {
  const baseDir = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";
  if (url.startsWith("/")) return joinPosix("", url.slice(1));
  let rel = url;
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url) rel = decoded;
  } catch {
    /* keep as-is */
  }
  return joinPosix(baseDir, rel);
}

function candidates(p: string): string[] {
  if (p === "") return ["index.html"];
  const out = [p];
  if (p.endsWith("/")) {
    out.push(p + "index.html", p + "index.htm");
  } else {
    const lastSlash = p.lastIndexOf("/");
    const lastDot = p.lastIndexOf(".");
    const segment = p.slice(lastSlash + 1);
    if (lastDot === -1 || lastDot < lastSlash) {
      out.push(p + ".html", p + ".htm", p + "/index.html");
    }
    // A directory-style link with no trailing slash should still find its index.
    if (!segment.includes(".")) out.push(p + "/index.html");
  }
  return out;
}

function checkUrl(files: Map<string, Uint8Array>, currentPath: string, url: string, what: string, issues: ReturnType<typeof err>[]): void {
  const clean = stripRef(url);
  if (clean === null) return;
  const resolved = resolveRef(currentPath, clean);
  if (resolved === null) {
    issues.push(
      err("links", currentPath, `The link "${url}" (${what}) points above the build root. Use a path inside the site.`, `ลิงก์ "${url}" (${what}) ชี้ขึ้นไปเหนือโฟลเดอร์ build กรุณาใช้พาธภายในเว็บไซต์`),
    );
    return;
  }
  if (isRuntimeOwned(resolved)) return;
  const found = candidates(resolved).some((c) => files.has(c));
  if (!found) {
    issues.push(
      err(
        "links",
        currentPath,
        `The link/asset "${url}" (${what}) is broken: "${resolved}" does not exist in the build. Fix the path or add the missing file.`,
        `ลิงก์/ไฟล์ "${url}" (${what}) เสีย: ไม่พบ "${resolved}" ใน build กรุณาแก้พาธหรือเพิ่มไฟล์ที่หายไป`,
      ),
    );
  }
}

function checkSrcset(files: Map<string, Uint8Array>, currentPath: string, srcset: string, what: string, issues: ReturnType<typeof err>[]): void {
  for (const entry of srcset.split(",")) {
    const url = entry.trim().split(/\s+/)[0];
    if (url) checkUrl(files, currentPath, url, what, issues);
  }
}

export const links: Check = ({ source }) => {
  const issues: ReturnType<typeof err>[] = [];
  const files = source.files;

  for (const [path, bytes] of files) {
    if (/\.css$/i.test(path)) {
      const css = new TextDecoder("utf-8").decode(bytes);
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        checkUrl(files, path, m[1]!.trim(), "a stylesheet url()", issues);
      }
      continue;
    }
    if (!/\.html?$/.test(path)) continue;

    const root = parseHtml(new TextDecoder("utf-8").decode(bytes));

    for (const a of root.querySelectorAll("a[href]")) {
      checkUrl(files, path, a.getAttribute("href") ?? "", "a link", issues);
    }
    for (const a of root.querySelectorAll("area[href]")) {
      checkUrl(files, path, a.getAttribute("href") ?? "", "an image-map link", issues);
    }
    for (const l of root.querySelectorAll("link[href]")) {
      checkUrl(files, path, l.getAttribute("href") ?? "", "a <link>", issues);
    }
    for (const s of root.querySelectorAll("script[src]")) {
      checkUrl(files, path, s.getAttribute("src") ?? "", "a script", issues);
    }
    for (const img of root.querySelectorAll("img[src]")) {
      checkUrl(files, path, img.getAttribute("src") ?? "", "an image", issues);
    }
    for (const img of root.querySelectorAll("img[srcset], source[srcset]")) {
      const srcset = img.getAttribute("srcset");
      if (srcset) checkSrcset(files, path, srcset, "a responsive image (srcset)", issues);
    }
    const otherRefs: { sel: string; attr: string; label: string }[] = [
      { sel: "iframe[src]", attr: "src", label: "an iframe" },
      { sel: "video[src]", attr: "src", label: "a video" },
      { sel: "video[poster]", attr: "poster", label: "a video poster" },
      { sel: "audio[src]", attr: "src", label: "an audio file" },
      { sel: "track[src]", attr: "src", label: "a text track" },
      { sel: "source[src]", attr: "src", label: "a media source" },
      { sel: "embed[src]", attr: "src", label: "an embed" },
      { sel: "object[data]", attr: "data", label: "an object" },
    ];
    for (const ref of otherRefs) {
      for (const el of root.querySelectorAll(ref.sel)) {
        checkUrl(files, path, el.getAttribute(ref.attr) ?? "", ref.label, issues);
      }
    }

    for (const style of root.querySelectorAll("style")) {
      for (const m of style.textContent.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        checkUrl(files, path, m[1]!.trim(), "an inline-style url()", issues);
      }
    }
  }

  return issues;
};