import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../drain/refresh-routing.mjs", import.meta.url));
const TOKEN = "test-drain-token";
const OLD = '{"old-brand":{"account":"1111111111","conversionAction":"1"}}\n';

let directory: string;
let server: Server;
let reply: { status: number; body: string };
let authorizations: Array<string | undefined>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "drain-refresh-"));
  authorizations = [];
  server = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    if (req.url !== "/api/conversions/routing") { res.writeHead(404); res.end("Not Found"); return; }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"status":"invalid","message":"Unauthorized"}');
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

function refresh(out: string, env: Record<string, string> = {}) {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, out], {
      env: { FORM_BASE_URL: `${base}/`, DRAIN_TOKEN: TOKEN, ...env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      timeout: 20_000, windowsHide: true,
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
}

async function withOldFile() {
  const out = join(directory, "routing.json");
  await writeFile(out, OLD);
  return out;
}

const expectUntouched = async (out: string) => {
  expect(await readFile(out, "utf8")).toBe(OLD);
  expect(await readdir(directory)).toEqual(["routing.json"]);
};

describe("scripts/drain/refresh-routing.mjs", () => {
  it("writes the routing map atomically and prints the brand count", async () => {
    const map = {
      "brand-a": { account: "4811219623", conversionAction: "7754587837", project: "proj_a" },
      "brand-b": { account: "1234567890", conversionAction: "42" },
    };
    reply = { status: 200, body: JSON.stringify(map) };
    const out = await withOldFile();
    const run = await refresh(out);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.stdout.trim()).toBe("routing refreshed: 2 brand(s)");
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(map);
    expect(await readdir(directory)).toEqual(["routing.json"]);
    expect(authorizations).toEqual([`Bearer ${TOKEN}`]);
  });

  it("leaves the old file and exits 1 on 401", async () => {
    reply = { status: 200, body: "{}" };
    const out = await withOldFile();
    const run = await refresh(out, { DRAIN_TOKEN: "wrong-token" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("HTTP 401");
    expect(run.stdout).toBe("");
    await expectUntouched(out);
  });

  it("leaves the old file and exits 1 on malformed JSON", async () => {
    reply = { status: 200, body: "{not json" };
    const out = await withOldFile();
    const run = await refresh(out);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not valid JSON");
    await expectUntouched(out);
  });

  it.each([
    ["an array", "[]"],
    ["a 9-digit account", '{"b":{"account":"123456789","conversionAction":"1"}}'],
    ["a dashed account", '{"b":{"account":"123-456-7890","conversionAction":"1"}}'],
    ["a non-digit action", '{"b":{"account":"1234567890","conversionAction":"12a"}}'],
    ["a missing action", '{"b":{"account":"1234567890"}}'],
    ["an invalid project", '{"b":{"account":"1234567890","conversionAction":"1","project":"a b"}}'],
  ])("leaves the old file and exits 1 on %s", async (_name, body) => {
    reply = { status: 200, body };
    const out = await withOldFile();
    const run = await refresh(out);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^refresh-routing: /);
    await expectUntouched(out);
  });

  it("exits 1 without a token and never calls core", async () => {
    const out = await withOldFile();
    const run = await refresh(out, { DRAIN_TOKEN: "" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("missing env DRAIN_TOKEN");
    expect(authorizations).toEqual([]);
    await expectUntouched(out);
  });
});
