import puppeteer, { type HTTPRequest } from "@cloudflare/puppeteer";
import type { FileMap } from "./archive.js";

// All HTTP resources come from the uploaded archive, never a deployed site.
const ORIGIN = "https://template.invalid";
// Response headers apply before template code executes. Page interception alone
// cannot contain worker requests or WebSockets. Keep archive scripts (including
// inline hydration) working, but prohibit workers and all script connections.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const headers = { "Content-Security-Policy": CSP };
const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript",
  mjs: "application/javascript", json: "application/json", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

export async function takeScreenshot(binding: Fetcher, files: FileMap, width: number, height: number): Promise<Uint8Array> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    const failures: string[] = [];
    const requests = new Set<Promise<void>>();
    const respond = async (request: HTTPRequest): Promise<void> => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") {
        await request.continue();
        return;
      }
      if (url.origin !== ORIGIN) {
        failures.push(`External resource ${url.href}; include assets in the ZIP.`);
        await request.abort();
        return;
      }
      const path = decodeURIComponent(url.pathname).replace(/^\//, "");
      const key = path === "" ? (files.has("index.html") ? "index.html" : "index.htm")
        : files.has(path) ? path : `${path.replace(/\/$/, "")}/index.html`;
      const body = files.get(key);
      if (!body) {
        // Chromium may request this even if the template does not declare an icon.
        if (path !== "favicon.ico") failures.push(`Missing archive asset ${path}; include it in the ZIP.`);
        await request.respond({ status: 404, headers, body: "Not found" });
        return;
      }
      await request.respond({ status: 200, headers, contentType: MIME[key.split(".").pop() ?? ""] ?? "application/octet-stream", body });
    };
    page.on("request", (request) => {
      const task = respond(request).catch(async (error: unknown) => {
        failures.push(String(error));
        if (!request.isInterceptResolutionHandled()) await request.abort().catch(() => {});
      });
      requests.add(task);
      void task.finally(() => requests.delete(task));
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      // This callback executes in Chromium, while this package uses Worker globals.
      const { document } = globalThis as unknown as { document: {
        fonts: { ready: Promise<unknown> };
        images: ArrayLike<{ loading: string; decode(): Promise<void> }>;
      } };
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, async (image) => {
        image.loading = "eager";
        await image.decode();
      }));
    });
    await Promise.all(requests);
    if (failures.length) throw new Error(failures.join(" "));
    return new Uint8Array(await page.screenshot({ type: "png" }));
  } finally {
    await browser.close();
  }
}
