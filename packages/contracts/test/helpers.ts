import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Raw bytes of a fixture, as UTF-8 text. */
export function fixtureText(rel: string): string {
  return readFileSync(join(PKG_DIR, "fixtures", rel), "utf8");
}

export function fixture<T = unknown>(rel: string): T {
  return JSON.parse(fixtureText(rel)) as T;
}

export interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Run the vendored, unmodified V1 `drain.mjs` against a local stand-in for core that serves
 * `pendingBody` on /api/conversions/pending and `ackBody` on /api/conversions/ack.
 *
 * The child gets a minimal env whose PATH is an empty temp directory, so the `adkit` CLI can
 * never be found or executed: the scenarios used here never reach it, and if one did it would
 * fail locally instead of calling an ad platform.
 */
export async function runV1Drain(opts: {
  pendingBody: string;
  ackBody: string;
  env: Record<string, string>;
}): Promise<{ requests: CapturedRequest[]; stdout: string; stderr: string; code: number }> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    const path = (req.url ?? "").split("?")[0];
    const out =
      req.method === "GET" && path === "/api/conversions/pending"
        ? opts.pendingBody
        : req.method === "POST" && path === "/api/conversions/ack"
          ? opts.ackBody
          : null;
    res.writeHead(out === null ? 404 : 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(out ?? '{"status":"invalid","message":"Not found"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const emptyBin = mkdtempSync(join(tmpdir(), "no-adkit-"));
  const env: Record<string, string> = {
    PATH: emptyBin,
    FORM_BASE_URL: `http://127.0.0.1:${port}`,
    ...opts.env,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  try {
    return await new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(PKG_DIR, "test", "v1", "drain.mjs")],
        { env, timeout: 20_000 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ requests, stdout, stderr, code });
        },
      );
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
