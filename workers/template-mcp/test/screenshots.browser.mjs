// Local Chromium regression checks; no Cloudflare binding or external service.
// CHROMIUM_EXECUTABLE=/path/to/chrome bun test ./test/screenshots.browser.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import puppeteer from "@cloudflare/puppeteer";
import localPuppeteer from "@cloudflare/puppeteer/internal/puppeteer-core.js";
import { takeScreenshot } from "../src/screenshots.ts";

assert.ok(process.env.CHROMIUM_EXECUTABLE, "Set CHROMIUM_EXECUTABLE to a local Chromium executable");

for (const [name, attack, directive] of [
  ["Worker-from-Blob fetch", `new Worker(URL.createObjectURL(new Blob(['fetch("http://127.0.0.1:54321/leak")'], {type: 'text/javascript'})))`, "worker-src"],
  ["WebSocket", `new WebSocket("ws://127.0.0.1:54321/leak")`, "connect-src"],
]) {
  test(`${name} is blocked before network access while archive JS runs`, async () => {
    const browser = await localPuppeteer.launch({
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    const originalLaunch = puppeteer.launch;
    const originalNewPage = browser.newPage.bind(browser);
    let evidence;
    let workers = 0;
    let sockets = 0;
    try {
      browser.newPage = async () => {
        const page = await originalNewPage();
        page.on("workercreated", () => workers++);
        const session = await page.createCDPSession();
        await session.send("Network.enable");
        session.on("Network.webSocketWillSendHandshakeRequest", () => sockets++);
        await page.evaluateOnNewDocument(() => {
          globalThis.violations = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            globalThis.violations.push(event.effectiveDirective);
          });
        });
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async (options) => {
          evidence = await page.evaluate(() => ({
            ran: globalThis.archiveScriptRan,
            violations: globalThis.violations,
          }));
          return screenshot(options);
        };
        return page;
      };
      puppeteer.launch = async () => browser;
      const files = new Map([
        ["index.html", new TextEncoder().encode('<!doctype html><h1>Archive</h1><script src="/attack.js"></script>')],
        ["attack.js", new TextEncoder().encode(`globalThis.archiveScriptRan = true; try { ${attack} } catch {}`)],
      ]);
      const png = await takeScreenshot({}, files, 390, 844);
      assert.ok(png.length > 0);
      assert.equal(evidence?.ran, true);
      assert.ok(evidence?.violations.includes(directive), JSON.stringify(evidence));
      assert.equal(workers, 0);
      assert.equal(sockets, 0);
    } finally {
      puppeteer.launch = originalLaunch;
      await browser.close();
    }
  });
}
