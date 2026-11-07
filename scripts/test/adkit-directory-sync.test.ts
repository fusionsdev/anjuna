import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only, with an empty PATH: nothing spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/adkit-directory-sync.mjs", import.meta.url));
const executor = fileURLToPath(new URL("../drain/adkit-executor.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Item { kind: string; id: string; parent_id: string | null; name: string; currency: string | null }
interface Account { id: string; name: string; currency: string | null; project: string | null; project_name: string | null }
interface DirectorySync {
  accountsFromAdkit(out: unknown, project: string | null): Account[];
  syncDirectory(options: {
    baseUrl: string; token: string; projects?: string[];
    runAdkit: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    log?: (line: string) => void; error?: (line: string) => void; chunkSize?: number;
  }): Promise<number>;
}

let d: DirectorySync;
let assertAllowed: (args: string[]) => void;
let savedPath: string | undefined;
beforeAll(async () => {
  savedPath = process.env.PATH;
  process.env.PATH = "";
  d = await import(pathToFileURL(script).href) as DirectorySync;
  ({ assertAllowed } = await import(pathToFileURL(executor).href) as { assertAllowed: (args: string[]) => void });
});
afterAll(() => { process.env.PATH = savedPath; });

function fakeCore(status = 200) {
  const posts: Item[][] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
    expect(new URL(String(url)).pathname).toBe("/api/adkit/directory/ingest");
    posts.push((JSON.parse(String(init?.body)) as { items: Item[] }).items);
    return Response.json({ status: "ok" }, { status });
  });
  return { posts, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const accountsJson = () => {
  const text = fixture("adkit-directory-accounts.txt");
  return JSON.parse(text.slice(text.indexOf("{"))) as unknown;
};

describe("scripts/drain/adkit-directory-sync.mjs", () => {
  it("maps accounts: 10-digit id, upper-case currency, project from the item or the call; rows without an id skipped", () => {
    expect(d.accountsFromAdkit(accountsJson(), null)).toEqual([
      { id: "4811219623", name: "Main account", currency: "THB", project: "proj_a", project_name: "Project A" },
      { id: "1234567890", name: "Second account", currency: "USD", project: "proj_b", project_name: null },
      { id: "5550001111", name: "No currency", currency: null, project: null, project_name: null },
    ]);
    expect(d.accountsFromAdkit(accountsJson(), "proj_z")[2]).toMatchObject({ project: "proj_z" });
  });

  it("posts projects, accounts and conversion actions using only allowlisted commands", async () => {
    const core = fakeCore();
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      assertAllowed(args);
      calls.push(args);
      if (args[2] === "accounts") return fixture("adkit-directory-accounts.txt");
      return args.includes("4811219623") ? fixture("adkit-conversions-list.txt") : '{"conversions":[]}';
    };
    expect(await d.syncDirectory({ baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl: core.fetchImpl, log: () => {}, error: () => {} })).toBe(0);
    expect(calls.map((a) => a.slice(2, 4).join(" "))).toEqual(["accounts list", "conversions list", "conversions list", "conversions list"]);
    const items = core.posts.flat();
    expect(items.filter((i) => i.kind === "project")).toEqual([
      { kind: "project", id: "proj_a", parent_id: null, name: "Project A", currency: null },
      { kind: "project", id: "proj_b", parent_id: null, name: "proj_b", currency: null },
    ]);
    expect(items.filter((i) => i.kind === "account").map((i) => [i.id, i.parent_id, i.currency]))
      .toEqual([["4811219623", "proj_a", "THB"], ["1234567890", "proj_b", "USD"], ["5550001111", null, null]]);
    expect(items.filter((i) => i.kind === "conversion_action").map((i) => [i.id, i.parent_id, i.name])).toEqual([
      ["7300000001", "4811219623", "Purchase (legacy)"],
      ["7300000002", "4811219623", "cv-0123456789abcdef"],
      ["7300000003", "4811219623", "cv-fedcba9876543210"],
    ]);
  });

  it("runs accounts list per configured project and sends large snapshots in chunks", async () => {
    const core = fakeCore();
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return args[2] === "accounts" ? JSON.stringify({ accounts: [{ platformId: "4811219623", name: "Main" }] }) : fixture("adkit-conversions-list.txt");
    };
    expect(await d.syncDirectory({
      baseUrl: "https://core.test", token: "tok", projects: ["proj_a"], chunkSize: 2, runAdkit, fetchImpl: core.fetchImpl, log: () => {}, error: () => {},
    })).toBe(0);
    expect(calls[0]).toEqual(["manage", "google", "accounts", "list", "--json", "--project", "proj_a"]);
    expect(calls[1]).toEqual(["manage", "google", "conversions", "list", "--account", "4811219623", "--limit", "500", "--json", "--project", "proj_a"]);
    expect(core.posts.map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it("a failing conversions list counts as a failure and the rest is still posted", async () => {
    const core = fakeCore();
    const errors: string[] = [];
    const runAdkit = async (args: string[]) => {
      if (args[2] === "accounts") return fixture("adkit-directory-accounts.txt");
      if (args.includes("1234567890")) throw new Error("spawn adkit ENOENT");
      return '{"conversions":[]}';
    };
    expect(await d.syncDirectory({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, log: () => {}, error: (l) => errors.push(l) })).toBe(1);
    expect(errors.join("\n")).toContain("1234567890");
    expect(core.posts.flat().filter((i) => i.kind === "account")).toHaveLength(3);
  });

  it("a rejected ingest counts as a failure", async () => {
    const core = fakeCore(400);
    const runAdkit = async (args: string[]) => (args[2] === "accounts" ? fixture("adkit-directory-accounts.txt") : '{"conversions":[]}');
    expect(await d.syncDirectory({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, log: () => {}, error: () => {} })).toBe(1);
  });

  it("refuses an option-like project before any adkit call", async () => {
    const core = fakeCore();
    const runAdkit = vi.fn(async () => "{}");
    await expect(d.syncDirectory({ baseUrl: "https://core.test", token: "tok", projects: ["--help"], runAdkit, fetchImpl: core.fetchImpl, log: () => {}, error: () => {} }))
      .rejects.toThrow(/invalid adkit project/);
    expect(runAdkit).not.toHaveBeenCalled();
  });
});
