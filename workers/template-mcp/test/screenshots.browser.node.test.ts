/**
 * Real-Chromium check that archive JavaScript cannot leave the screenshot browser.
 * Skipped unless CHROMIUM_EXECUTABLE is a local Chromium or Chrome binary.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import puppeteer from "@cloudflare/puppeteer";
import localPuppeteer from "@cloudflare/puppeteer/internal/puppeteer-core.js";
import { takeScreenshot } from "../src/screenshots";

const executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath) {
  console.info("Skipping real-Chromium Worker/WebSocket network-escape check. Set CHROMIUM_EXECUTABLE to a local Chromium or Chrome binary to run it.");
}

describe.skipIf(!executablePath)("real Chromium network escape (skipped unless CHROMIUM_EXECUTABLE is set)", () => {
  it("fails if a blob Worker reaches the network or a WebSocket handshake happens", async () => {
    if (!executablePath) throw new Error("Set CHROMIUM_EXECUTABLE to a local Chromium or Chrome binary");
    const leaks = { workers: 0, workerFetches: 0, handshakes: 0 };
    let reportLeak: (reason: string) => void = () => {};
    const escaped = new Promise<string>((resolve) => {
      reportLeak = resolve;
    });
    const noteWorker = () => {
      leaks.workers += 1;
    };
    const noteFetch = () => {
      leaks.workerFetches += 1;
      reportLeak(`blob Worker was created and reached the network (workers=${leaks.workers}, fetches=${leaks.workerFetches})`);
    };
    const noteHandshake = () => {
      leaks.handshakes += 1;
      reportLeak(`WebSocket handshake happened (handshakes=${leaks.handshakes})`);
    };

    const server = createServer((request, response) => {
      if ((request.url ?? "").includes("/worker-leak")) noteFetch();
      response.writeHead(204);
      response.end();
    });
    server.on("upgrade", (request) => {
      if ((request.url ?? "").includes("/ws-leak")) noteHandshake();
      request.socket.destroy();
    });
    const port = await listen(server);

    const browser = await localPuppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        // CSP is the control. These stop mixed-content and private-network blocks from
        // hiding a fetch or WebSocket that a weakened policy would allow.
        "--allow-running-insecure-content",
        "--disable-features=BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,LocalNetworkAccessForWorkers",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const originalLaunch = puppeteer.launch;
    let evidence: { ran: boolean; violations: string[] } | undefined;
    try {
      const originalNewPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await originalNewPage();
        page.on("workercreated", noteWorker);
        const session = await page.createCDPSession();
        await session.send("Network.enable");
        session.on("Network.webSocketWillSendHandshakeRequest", noteHandshake);
        session.on("Network.requestWillBeSent", (event: { request?: { url?: string } }) => {
          if (event.request?.url?.includes("/worker-leak")) noteFetch();
        });
        await page.evaluateOnNewDocument(() => {
          const g = globalThis as unknown as {
            violations: string[];
            document: { addEventListener(type: string, listener: (event: { effectiveDirective: string }) => void): void };
          };
          g.violations = [];
          g.document.addEventListener("securitypolicyviolation", (event) => {
            g.violations.push(event.effectiveDirective);
          });
        });
        const screenshot = page.screenshot.bind(page);
        page.screenshot = (async (options?: Parameters<typeof screenshot>[0]) => {
          evidence = await page.evaluate(() => {
            const g = globalThis as unknown as { archiveScriptRan?: boolean; violations?: string[] };
            return { ran: g.archiveScriptRan === true, violations: g.violations ?? [] };
          });
          return screenshot(options);
        }) as typeof page.screenshot;
        return page;
      };
      puppeteer.launch = (async () => browser) as unknown as typeof puppeteer.launch;

      const workerSource = `fetch("http://127.0.0.1:${port}/worker-leak")`;
      const attack = [
        "globalThis.archiveScriptRan = true;",
        "try {",
        `  new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: "text/javascript" })));`,
        "} catch (e) {}",
        "try {",
        `  new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/ws-leak`)});`,
        "} catch (e) {}",
      ].join("\n");
      const files = new Map<string, Uint8Array>([
        ["index.html", new TextEncoder().encode('<!doctype html><h1>Archive</h1><script src="/attack.js"></script>')],
        ["attack.js", new TextEncoder().encode(attack)],
      ]);

      const shot = takeScreenshot({} as Fetcher, files, 390, 844).then(
        (png) => ({ ok: true as const, png }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const outcome = await Promise.race([
        shot.then((result) => ({ kind: "shot" as const, result })),
        escaped.then((leak) => ({ kind: "leak" as const, leak })),
      ]);
      if (outcome.kind === "leak") {
        await browser.close().catch(() => {});
        await shot;
        expect.fail(outcome.leak);
      }
      if (!outcome.result.ok) {
        const message = outcome.result.error instanceof Error ? outcome.result.error.message : String(outcome.result.error);
        if (leaks.workers > 0 || leaks.workerFetches > 0 || leaks.handshakes > 0 || message.includes("127.0.0.1") || message.includes("External resource")) {
          expect.fail(`network escape: ${message}; workers=${leaks.workers} fetches=${leaks.workerFetches} handshakes=${leaks.handshakes}`);
        }
        throw outcome.result.error;
      }
      expect(outcome.result.png.byteLength).toBeGreaterThan(0);
      expect(evidence?.ran, "archive script did not run").toBe(true);
      expect(evidence?.violations ?? [], JSON.stringify(evidence)).toEqual(expect.arrayContaining(["worker-src", "connect-src"]));
      expect(leaks.workers, "blob Worker was created").toBe(0);
      expect(leaks.workerFetches, "blob Worker reached the network").toBe(0);
      expect(leaks.handshakes, "WebSocket handshake happened").toBe(0);
    } finally {
      puppeteer.launch = originalLaunch;
      await browser.close().catch(() => {});
      await closeServer(server);
    }
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("leak server has no TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
