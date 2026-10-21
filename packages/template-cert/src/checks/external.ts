import { isExternalUrl } from "@anjuna/contracts";
import { parseHtml } from "../html.js";
import { err, warn } from "../issue.js";
import type { Check } from "../checks.js";

const GOOGLE_FONTS_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/** Inline / same-origin script content that is clearly third-party analytics or a tracking pixel. */
const ANALYTICS = /(?:gtag\s*\(|googletagmanager|google-analytics|google_analytics|adsbygoogle|fbq\s*\(|fbevents|connect\.facebook|posthog|sentry|hotjar|clarity\.ms|segment\.com|amplitude|mixpanel|matomo|_paq\.push|plausible\.io|umami(?:\.js|\(|\/))/i;

function isGoogleFontsUrl(url: string): boolean {
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    return GOOGLE_FONTS_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

interface ExternalFinding {
  url: string;
  kind: string;
}

/** Report non-script resources as advisories; scripts have their own blocking policy id. */
function classify(url: string, path: string, what: string, issues: (ReturnType<typeof err> | ReturnType<typeof warn>)[]): void {
  if (isGoogleFontsUrl(url)) {
    issues.push(
      warn(
        "external",
        path,
        `${what} loads Google Fonts from ${url}. Allowed, but it is an outside request; shipping the font files inside dist/ is preferred.`,
        `${what} โหลด Google Fonts จาก ${url} อนุญาตให้ใช้ได้ แต่เป็นการเรียกภายนอก แนะนำให้ใส่ไฟล์ฟอนต์ไว้ใน dist/ เอง`,
      ),
    );
  } else {
    issues.push(
      err(
        "external",
        path,
        `${what} loads from outside the site (${url}). Prefer same-origin assets. Ship the file inside dist/ to avoid outside requests.`,
        `${what} โหลดจากภายนอก (${url}) template ต้องใช้ไฟล์ในโดเมนเดียวกันเท่านั้น กรุณาใส่ไฟล์ไว้ใน dist/ แทน`,
      ),
    );
  }
}

function scanCss(urls: ExternalFinding[], path: string, css: string): void {
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')]+)["']?\s*\)?/gi)) {
    const u = m[1]!.trim();
    if (isExternalUrl(u)) urls.push({ url: u, kind: "A stylesheet @import" });
  }
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const u = m[1]!.trim();
    if (isExternalUrl(u)) urls.push({ url: u, kind: "A stylesheet asset (font/image)" });
  }
}

export const external: Check = ({ source }) => {
  const issues: (ReturnType<typeof err> | ReturnType<typeof warn>)[] = [];

  for (const [path, bytes] of source.files) {
    if (/\.css$/i.test(path)) {
      const css = new TextDecoder("utf-8").decode(bytes);
      const found: ExternalFinding[] = [];
      scanCss(found, path, css);
      for (const f of found) classify(f.url, path, f.kind, issues);
      continue;
    }
    if (!/\.html?$/.test(path)) continue;

    const html = new TextDecoder("utf-8").decode(bytes);
    const root = parseHtml(html);

    for (const s of root.querySelectorAll("script[src]")) {
      const src = (s.getAttribute("src") ?? "").trim();
      if (src && isExternalUrl(src)) issues.push(err("external", path,
        `A <script> loads from outside the site (${src}). Ship the script inside dist/ instead.`,
        `สคริปต์โหลดจากภายนอก (${src}) กรุณาใส่สคริปต์ไว้ใน dist/`, "external-script"));
    }

    for (const s of root.querySelectorAll("script")) {
      const src = (s.getAttribute("src") ?? "").trim();
      if (src && isExternalUrl(src)) continue; // already reported above
      if (ANALYTICS.test(s.textContent)) {
        issues.push(
          err(
            "external",
            path,
            "An inline script looks like third-party analytics or tracking. Remove it; analytics run through the first-party proxy only.",
            "สคริปต์ inline ดูเหมือนเป็น analytics หรือ tracking ของบุคคลที่สาม กรุณาลบออก analytics ต้องวิ่งผ่านพร็อกซีของโดเมนตนเองเท่านั้น",
          ),
        );
      }
    }

    for (const f of root.querySelectorAll("iframe")) {
      issues.push(
        err(
          "external",
          path,
          "The page embeds an <iframe>. Embedded content is not allowed in a landing template; remove it.",
          "หน้ามี <iframe> ฝังเนื้อหาภายนอก ซึ่งไม่อนุญาตใน landing template กรุณาลบออก",
        ),
      );
    }

    for (const img of root.querySelectorAll("img[src]")) {
      const src = (img.getAttribute("src") ?? "").trim();
      if (src && isExternalUrl(src)) classify(src, path, "An <img> (tracking-pixel risk)", issues);
    }

    const attrHost = "link[href]";
    for (const l of root.querySelectorAll(attrHost)) {
      const href = (l.getAttribute("href") ?? "").trim();
      if (href && isExternalUrl(href)) classify(href, path, "A <link>", issues);
    }

    const otherRefs: { sel: string; attr: string; label: string }[] = [
      { sel: "source[src]", attr: "src", label: "A <source>" },
      { sel: "track[src]", attr: "src", label: "A <track>" },
      { sel: "embed[src]", attr: "src", label: "An <embed>" },
      { sel: "object[data]", attr: "data", label: "An <object>" },
      { sel: "video[src]", attr: "src", label: "A <video>" },
      { sel: "audio[src]", attr: "src", label: "An <audio>" },
      { sel: "video[poster]", attr: "poster", label: "A <video poster>" },
    ];
    for (const ref of otherRefs) {
      for (const el of root.querySelectorAll(ref.sel)) {
        const u = (el.getAttribute(ref.attr) ?? "").trim();
        if (u && isExternalUrl(u)) classify(u, path, ref.label, issues);
      }
    }

    // Inline <style> url()/@import references.
    for (const s of root.querySelectorAll("style")) {
      const found: ExternalFinding[] = [];
      scanCss(found, path, s.textContent);
      for (const f of found) classify(f.url, path, f.kind, issues);
    }

    // Tracking pixels hidden in <noscript> (raw-text elements) are not exposed by the DOM walk.
    for (const m of html.matchAll(/<noscript\b[\s\S]*?<\/noscript>/gi)) {
      const block = m[0];
      for (const u of block.matchAll(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
        const url = u[1]!.trim();
        if (isGoogleFontsUrl(url)) {
          issues.push(warn("external", path, `A <noscript> fallback loads Google Fonts (${url}). Allowed, but prefer shipping fonts locally.`, `ส่วน <noscript> โหลด Google Fonts (${url}) อนุญาต แต่แนะนำให้ใส่ฟอนต์ไว้ในเครื่องเอง`));
        } else {
          issues.push(
            err(
              "external",
              path,
              `A <noscript> fallback loads an external resource (${url}) — commonly a tracking pixel. Remove it from the template.`,
              `ส่วน <noscript> โหลดทรัพยากรภายนอก (${url}) ซึ่งมักเป็น tracking pixel กรุณาลบออกจาก template`,
            ),
          );
        }
      }
      if (ANALYTICS.test(block)) {
        issues.push(
          err("external", path, "A <noscript> block contains a tracking pixel or analytics fallback. Remove it.", "ส่วน <noscript> มี tracking pixel หรือ analytics fallback กรุณาลบออก"),
        );
      }
    }
  }

  return issues;
};