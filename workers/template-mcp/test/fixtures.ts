import { vi } from "vitest";
import { zipSync, strToU8, gzipSync } from "fflate";
import type { FileMap } from "../src/archive";
import { AMOUNT_BUCKETS } from "../src/contract";

const enc = (s: string) => strToU8(s);

export interface SiteOptions {
  title?: string;
  h1?: string;
  hero?: string;
  sections?: string[];
  classPrefix?: string;
  extraHead?: string;
  extraBody?: string;
  ctaForm?: string;
  images?: Record<string, Uint8Array>;
}

export function ctaForm(options: { buckets?: readonly (number | string)[]; zipExtra?: string; extra?: string; method?: string; action?: string } = {}): string {
  const buckets = options.buckets ?? AMOUNT_BUCKETS;
  return `<form class="cta" method="${options.method ?? "get"}" action="${options.action ?? "/go"}" data-cta>
  <select name="requested_amount" required>${buckets.map((b) => `<option value="${b}">$${Number(b).toLocaleString("en-US")}</option>`).join("")}</select>
  <input name="zip" type="text" inputmode="numeric" autocomplete="postal-code" pattern="[0-9]{5}" minlength="5" maxlength="5" required ${options.zipExtra ?? ""}>
  ${options.extra ?? ""}
  <button type="submit">Continue</button>
</form>`;
}

const footer = `<footer class="site"><nav><a href="/privacy/">Privacy</a> <a href="/terms/">Terms</a> <a href="/do-not-sell/">Do Not Sell or Share My Personal Information</a> <a href="/disclosures/">Disclosures</a></nav><p>Not a lender. Rates and terms vary by lender and state. Not all applicants qualify.</p></footer>`;

export function page(body: string, head = "", title = "Harbor | Funding"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="description" content="Check your funding options in minutes."><title>${title}</title>${head}<style>body{margin:0}</style></head><body>${body}${footer}</body></html>`;
}

/** A minimal site that satisfies the contract. */
export function goodSite(o: SiteOptions = {}): FileMap {
  const p = o.classPrefix ?? "hb";
  const sections = o.sections ?? [`<section class="${p}-steps"><h2>How it works</h2><ol><li>Pick an amount</li><li>Enter your ZIP</li></ol></section>`];
  const index = page(
    `<header class="${p}-top"><a href="/" data-brand>Harbor</a></header><main><h1>${o.h1 ?? '<span data-kw>Funding Options</span> | Check Your Options in Minutes'}</h1><p>${o.hero ?? "Answer two quick questions to see if a lending partner may be able to help."}</p>${o.ctaForm ?? ctaForm()}${sections.join("")}${o.extraBody ?? ""}</main>`,
    `<link rel="stylesheet" href="/assets/site.css">${o.extraHead ?? ""}`,
    o.title,
  );
  const files: FileMap = new Map<string, Uint8Array>([
    ["index.html", enc(index)],
    ["assets/site.css", enc(`body{font-family:system-ui}.${p}-top{padding:8px}`)],
  ]);
  for (const route of ["privacy", "terms", "do-not-sell", "disclosures"]) {
    files.set(`${route}/index.html`, enc(page(`<main><h1>${route}</h1><p>[Placeholder] ${route} copy.</p></main>`, `<link rel="stylesheet" href="/assets/site.css">`)));
  }
  for (const [path, bytes] of Object.entries(o.images ?? {})) files.set(path, bytes);
  return files;
}

export const withFile = (files: FileMap, path: string, content: string | Uint8Array): FileMap => new Map(files).set(path, typeof content === "string" ? enc(content) : content);
export const withIndex = (files: FileMap, edit: (html: string) => string): FileMap => {
  const next = new Map(files);
  next.set("index.html", enc(edit(new TextDecoder().decode(files.get("index.html")!))));
  return next;
};

export function toZip(files: FileMap): Uint8Array {
  return zipSync(Object.fromEntries(files));
}
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export const zipBase64 = (files: FileMap) => toBase64(toZip(files));

/** A visibly different site: other copy, structure, classes and images. */
export function otherSite(): FileMap {
  return goodSite({
    classPrefix: "zq",
    title: "Lantern | Cash Options",
    h1: '<span data-kw>Quick Cash Options</span> for Real Life',
    hero: "Tell us roughly what you need and where you live; a partner may reach out with terms you can compare at your own pace.",
    sections: [
      '<div class="zq-grid"><article class="zq-card"><h3>Transparent</h3><p>No surprises, just clear steps.</p></article><article class="zq-card"><h3>Private</h3><p>Your details stay with you until you choose.</p></article></div>',
      '<aside class="zq-quote"><blockquote>Simple and calm.</blockquote></aside>',
      '<section class="zq-faq"><details><summary>Who are you?</summary><p>A marketplace.</p></details></section>',
    ],
    images: { "img/lantern.png": new Uint8Array(400).fill(7) },
  });
}

/** Raw tar builder for tarball tests (ustar). */
export function tarGz(entries: { path: string; content?: string | Uint8Array; type?: string; linkname?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = typeof entry.content === "string" ? enc(entry.content) : (entry.content ?? new Uint8Array(0));
    const header = new Uint8Array(512);
    const put = (offset: number, value: string) => header.set(enc(value), offset);
    put(0, entry.path);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, content.length.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, entry.type ?? "0");
    if (entry.linkname) put(157, entry.linkname);
    put(257, "ustar\0");
    put(263, "00");
    let sum = 0;
    for (const b of header) sum += b;
    put(148, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (content.length) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    tar.set(b, offset);
    offset += b.length;
  }
  return gzipSync(tar);
}

/** A client-rendered SPA shell: no visible body text, content only after JavaScript runs. */
export const spaShell: FileMap = new Map([["index.html", enc(
  "<!doctype html><html><head><title>Harbor | App</title></head><body><div id=\"root\"></div><noscript>Enable JavaScript</noscript><script type=\"module\" src=\"/assets/index.js\"></script></body></html>",
)]]);

/** Stub fetch as a static host serving dist/ files (/ -> index.html, /privacy/ -> privacy/index.html); anything else gets bolt.host's 404. */
export function serve(files: FileMap): void {
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(String(input)).pathname;
    const key = path === "/" ? "index.html" : path.endsWith("/") ? `${path.slice(1)}index.html` : path.slice(1);
    const body = files.get(key);
    return body
      ? new Response(body, { headers: { "content-type": key.endsWith(".css") ? "text/css" : "text/html" } })
      : new Response("Website not found", { status: 404, headers: { "content-type": "text/html" } });
  });
}
