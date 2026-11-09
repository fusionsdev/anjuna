import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// T13-6: terminal.run jobs on the VPS executor. Fixture output only; PATH is empty for the whole file and every
// run injects runAdkit and fetchImpl, so nothing spawns adkit or reaches core.
const dir = (name: string) => pathToFileURL(fileURLToPath(new URL(`../drain/${name}`, import.meta.url))).href;

interface Verdict { ok: boolean; reason?: string; argv?: string[] }
interface Allow {
  parseTerminalLine(line: string, mode: string): Verdict;
  redactTerminalOutput(text: string): string;
  assertAllowed(args: string[], kind?: string): void;
}
interface Executor {
  assertAllowed: Allow["assertAllowed"];
  executeJobs(o: {
    baseUrl: string; token: string; runAdkit: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    log: () => void; error: () => void;
  }): Promise<number>;
}
let a: Allow;
let x: Executor;
let savedPath: string | undefined;
beforeAll(async () => {
  savedPath = process.env.PATH;
  process.env.PATH = "";
  a = await import(dir("adkit-allowlist.mjs")) as Allow;
  x = await import(dir("adkit-executor.mjs")) as Executor;
});
afterAll(() => { process.env.PATH = savedPath; });

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const DATA = `'{"campaigns":[{"name":"petvet-search-1","type":"SEARCH"}]}'`;

describe("shared allowlist module", () => {
  it("the executor and the shared module accept and refuse the same argv", () => {
    const ok = ["manage", "google", "accounts", "list", "--json"];
    const bad = ["manage", "google", "platform-api-request", "--json"];
    expect(() => a.assertAllowed(ok)).not.toThrow();
    expect(() => x.assertAllowed(ok)).not.toThrow();
    expect(() => a.assertAllowed(bad)).toThrow(/not allowed/);
    expect(() => x.assertAllowed(bad)).toThrow(/not allowed/);
  });

  it("a terminal line parses to an argv the executor guard accepts", () => {
    for (const [line, mode] of [
      ["manage google accounts list", "read"],
      ["adkit manage google campaigns list --account 1234567890", "read"],
      [`manage google campaigns create --account 1234567890 --data ${DATA}`, "draft"],
    ] as const) {
      const v = a.parseTerminalLine(line, mode);
      expect(v.ok, line).toBe(true);
      expect(() => x.assertAllowed(v.argv!, mode === "draft" ? "campaign.draft.create" : "terminal.run")).not.toThrow();
    }
  });

  it("refuses ENABLED through the Terminal: enabling goes through the caps on the campaigns page", () => {
    const line = `manage google campaigns update --account 1234567890 --campaign 5 --data '{"status":"ENABLED"}' --publish`;
    expect(a.parseTerminalLine(line, "publish").ok).toBe(false);
    expect(a.parseTerminalLine(line.replace("ENABLED", "PAUSED"), "publish").ok).toBe(true);
  });

  it("masks click ids and tokens and cuts output at 20 KB", () => {
    const masked = a.redactTerminalOutput(`{"gclid":"Cj0KCQ","access_token":"ya29.abc"} Bearer abc.def gclid=XYZ ${"k".repeat(60)}`);
    expect(masked).not.toMatch(/Cj0KCQ|ya29|abc\.def|XYZ|kkkk/);
    expect(a.redactTerminalOutput("x ".repeat(30000)).length).toBeLessThanOrEqual(20 * 1024);
    expect(Buffer.byteLength(a.redactTerminalOutput("ก".repeat(30000)))).toBeLessThanOrEqual(20 * 1024);
  });
});

function core(payload: Record<string, unknown>) {
  const results: Array<Record<string, unknown>> = [];
  const job = { id: JOB_ID, kind: "terminal.run", payload, attempts: 1 };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/adkit/jobs/pending") return Response.json({ jobs: [job] });
    if (path === "/api/adkit/jobs/claim") return Response.json({ status: "claimed", claim_id: CLAIM_ID, job });
    if (path === "/api/adkit/jobs/result") { results.push(JSON.parse(String(init?.body))); return Response.json({ status: "done" }); }
    return new Response("Not Found", { status: 404 });
  });
  return { results, fetchImpl: fetchImpl as unknown as typeof fetch };
}
const quiet = { log: () => {}, error: () => {} };

describe("executor: terminal.run", () => {
  it("runs a read argv once and posts the masked output", async () => {
    const c = core({ line: "manage google accounts list", argv: ["manage", "google", "accounts", "list", "--json"], mode: "read" });
    const runAdkit = vi.fn(async () => '{"accounts":[{"id":"1"}],"gclid":"SECRETCLICK"}');
    const failures = await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: c.fetchImpl, ...quiet });
    expect(failures).toBe(0);
    expect(runAdkit).toHaveBeenCalledTimes(1);
    expect(c.results).toHaveLength(1);
    const out = (c.results[0] as { result: { output: string } }).result.output;
    expect(out).toContain('"accounts"');
    expect(out).not.toContain("SECRETCLICK");
  });

  it("runs a draft create in draft mode", async () => {
    const argv = ["manage", "google", "campaigns", "create", "--account", "1234567890", "--data", DATA.slice(1, -1), "--json"];
    const c = core({ line: "x", argv, mode: "draft" });
    const runAdkit = vi.fn(async () => "{}");
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: c.fetchImpl, ...quiet })).toBe(0);
    expect(runAdkit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a draft create stored under read mode", ["manage", "google", "campaigns", "create", "--account", "1234567890", "--data", DATA.slice(1, -1), "--json"], "read"],
    ["a command off the allowlist", ["manage", "google", "platform-api-request", "--json"], "read"],
    ["an ENABLED update", ["manage", "google", "campaigns", "update", "--account", "1234567890", "--campaign", "5", "--data", '{"status":"ENABLED"}', "--publish", "--json"], "publish"],
    ["a shell word", ["rm", "-rf", "/"], "read"],
  ])("never spawns adkit for %s and fails the job for good", async (_label, argv, mode) => {
    const c = core({ line: "x", argv, mode });
    const runAdkit = vi.fn(async () => "{}");
    const failures = await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: c.fetchImpl, ...quiet });
    expect(failures).toBe(1);
    expect(runAdkit).not.toHaveBeenCalled();
    expect(c.results[0]).toMatchObject({ retryable: false });
  });
});
