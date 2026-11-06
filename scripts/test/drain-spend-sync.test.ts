import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only. No test here spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/spend-sync.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Row { brand_id: string; date: string; hour: number | null; cost: number; currency?: string; clicks: number; impressions: number }
interface Route { account: string; conversionAction: string; project?: string }
interface SpendSync {
  adkitArgsFor(route: Route, breakdown: string, fallbackProject: string | undefined, date: string): string[];
  syncDates(now?: Date): string[];
  parseAdkitJson(stdout: string): unknown;
  spendRowsFromAdkit(out: unknown, brandId: string, breakdown: string, defaultDate?: string): { rows: Row[]; skipped: number };
  accountsListArgs(project: string | undefined): string[];
  accountCurrencies(out: unknown): Map<string, string>;
  syncSpend(options: {
    baseUrl: string; token: string; breakdown?: string; fallbackProject?: string; dryRun?: boolean;
    runAdkit: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    log?: (line: string) => void; error?: (line: string) => void; now?: Date;
  }): Promise<number>;
}

let s: SpendSync;
beforeAll(async () => { s = await import(pathToFileURL(script).href) as SpendSync; });

describe("scripts/drain/spend-sync.mjs mapping", () => {
  it("maps hourly AdKit output: micros to USD, strings to numbers, same hour summed, incomplete rows skipped", () => {
    const out = s.parseAdkitJson(fixture("adkit-results-hour.txt"));
    expect(s.spendRowsFromAdkit(out, "brand-a", "hour")).toEqual({
      rows: [
        { brand_id: "brand-a", date: "2026-10-21", hour: 0, cost: 1.25, clicks: 3, impressions: 120 },
        { brand_id: "brand-a", date: "2026-10-21", hour: 1, cost: 0, clicks: 0, impressions: 15 },
        { brand_id: "brand-a", date: "2026-10-21", hour: 13, cost: 5, clicks: 6, impressions: 320 },
      ],
      skipped: 2,
    });
  });

  it("maps a whole-day breakdown to hour null and accepts a top-level array with USD cost", () => {
    const out = s.parseAdkitJson(fixture("adkit-results-day.txt"));
    expect(s.spendRowsFromAdkit(out, "brand-b", "day").rows).toEqual([
      { brand_id: "brand-b", date: "2026-10-20", hour: null, cost: 12.34, clicks: 7, impressions: 410 },
      { brand_id: "brand-b", date: "2026-10-21", hour: null, cost: 8.5, clicks: 4, impressions: 230 },
    ]);
  });

  it("returns no rows for output without a result array", () => {
    expect(s.spendRowsFromAdkit({ ok: true }, "brand-a", "hour")).toEqual({ rows: [], skipped: 0 });
  });

  it("stamps the call date on live 1.13.54 hour rows that carry no date", () => {
    const out = s.parseAdkitJson(fixture("adkit-results-hour-live.txt"));
    expect(s.spendRowsFromAdkit(out, "brand-a", "hour", "2026-10-26")).toEqual({
      rows: [
        { brand_id: "brand-a", date: "2026-10-26", hour: 2, cost: 133.72, clicks: 2, impressions: 2 },
        { brand_id: "brand-a", date: "2026-10-26", hour: 3, cost: 40.5, clicks: 1, impressions: 5 },
        { brand_id: "brand-a", date: "2026-10-26", hour: 14, cost: 0, clicks: 4, impressions: 9 },
      ],
      skipped: 0,
    });
    expect(s.spendRowsFromAdkit(out, "brand-a", "hour").skipped).toBe(3);
  });

  it("builds the 1.13.54 results command for one date with the brand project, else the fallback", () => {
    const base = ["manage", "google", "results", "--account", "4811219623", "--breakdown", "hour", "--from", "2026-10-26", "--to", "2026-10-26", "--json"];
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1", project: "proj_a" }, "hour", "global", "2026-10-26"))
      .toEqual([...base, "--project", "proj_a"]);
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1" }, "hour", "global", "2026-10-26")).toEqual([...base, "--project", "global"]);
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1" }, "day", undefined, "2026-10-26"))
      .toEqual(["manage", "google", "results", "--account", "4811219623", "--breakdown", "day", "--from", "2026-10-26", "--to", "2026-10-26", "--json"]);
  });

  it("reads each account's billing currency from accounts list, keyed by the digits of the account id", () => {
    const currencies = s.accountCurrencies(s.parseAdkitJson(fixture("adkit-accounts-list.txt")));
    expect([...currencies.entries()]).toEqual([
      ["4811219623", "THB"], ["1234567890", "THB"], ["5550001111", "USD"], ["9990001111", "EUR"],
    ]);
    expect(s.accountCurrencies({ ok: true }).size).toBe(0);
  });

  it("builds the accounts list command with the project when there is one", () => {
    expect(s.accountsListArgs("proj_a")).toEqual(["manage", "google", "accounts", "list", "--json", "--project", "proj_a"]);
    expect(s.accountsListArgs(undefined)).toEqual(["manage", "google", "accounts", "list", "--json"]);
  });

  it("syncs yesterday and today in UTC", () => {
    expect(s.syncDates(new Date("2026-10-26T00:30:00Z"))).toEqual(["2026-10-25", "2026-10-26"]);
    expect(s.syncDates(new Date("2026-03-01T23:59:00Z"))).toEqual(["2026-02-28", "2026-03-01"]);
  });
});

describe("scripts/drain/spend-sync.mjs job", () => {
  const routing = {
    "brand-a": { account: "4811219623", conversionAction: "1", project: "proj_a" },
    "brand-b": { account: "1234567890", conversionAction: "2" },
  };

  function fakeCore(ingestStatus = 200) {
    const posts: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
      const path = new URL(String(url)).pathname;
      if (path === "/api/conversions/routing") return Response.json(routing);
      if (path === "/api/spend/ingest") {
        posts.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: ingestStatus });
      }
      return new Response("Not Found", { status: 404 });
    });
    return { posts, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("reads routing, runs adkit per brand and POSTs the mapped rows to core", async () => {
    const { posts, fetchImpl } = fakeCore();
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      if (args[2] === "accounts") return fixture("adkit-accounts-list.txt");
      return args.includes("4811219623") ? fixture("adkit-results-hour-live.txt") : '{"results":[]}';
    };
    const now = new Date("2026-10-26T10:00:00Z");
    const failures = await s.syncSpend({ baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl, log: () => {}, error: () => {}, now });
    expect(failures).toBe(0);
    const results = calls.filter((a) => a[2] === "results");
    expect(results.map((a) => [a[a.indexOf("--account") + 1], a[a.indexOf("--from") + 1], a[a.indexOf("--to") + 1]])).toEqual([
      ["4811219623", "2026-10-25", "2026-10-25"], ["4811219623", "2026-10-26", "2026-10-26"],
      ["1234567890", "2026-10-25", "2026-10-25"], ["1234567890", "2026-10-26", "2026-10-26"],
    ]);
    // One accounts list per project, cached for the run. brand-b has no project of its own.
    expect(calls.filter((a) => a[2] === "accounts")).toEqual([s.accountsListArgs("proj_a"), s.accountsListArgs(undefined)]);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { rows: Row[] }).rows.map((r) => [r.brand_id, r.date, r.hour, r.cost, r.currency])).toEqual([
      ["brand-a", "2026-10-25", 2, 133.72, "THB"], ["brand-a", "2026-10-25", 3, 40.5, "THB"], ["brand-a", "2026-10-25", 14, 0, "THB"],
      ["brand-a", "2026-10-26", 2, 133.72, "THB"], ["brand-a", "2026-10-26", 3, 40.5, "THB"], ["brand-a", "2026-10-26", 14, 0, "THB"],
    ]);
  });

  it("asks accounts list once per project however many brands share it", async () => {
    const shared = {
      "brand-a": { account: "4811219623", conversionAction: "1", project: "proj_a" },
      "brand-b": { account: "1234567890", conversionAction: "2", project: "proj_a" },
    };
    const calls: string[][] = [];
    const fetchImpl = (async (url: string | URL | Request) =>
      new URL(String(url)).pathname === "/api/conversions/routing" ? Response.json(shared) : new Response("{}")) as unknown as typeof fetch;
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return args[2] === "accounts" ? fixture("adkit-accounts-list.txt") : '{"results":[]}';
    };
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl, log: () => {}, error: () => {} })).toBe(0);
    expect(calls.filter((a) => a[2] === "accounts")).toHaveLength(1);
  });

  it("fails a brand whose account bills in a currency core cannot store, and sends none of its rows", async () => {
    const euro = { "brand-a": { account: "9990001111", conversionAction: "1" } };
    const posts: unknown[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/conversions/routing") return Response.json(euro);
      posts.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const errors: string[] = [];
    const runAdkit = async (args: string[]) => (args[2] === "accounts" ? fixture("adkit-accounts-list.txt") : fixture("adkit-results-hour-live.txt"));
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl, log: () => {}, error: (l) => errors.push(l) })).toBe(1);
    expect(errors.join("\n")).toContain("brand-a account 9990001111 bills in EUR");
    expect(posts.flatMap((p) => (p as { rows: Row[] }).rows)).toEqual([]);
  });

  it.each([
    ["fails", async (): Promise<string> => { throw new Error("spawn adkit ENOENT"); }, "accounts list failed: spawn adkit ENOENT"],
    ["cannot be read", async () => fixture("adkit-results-hour-live.txt"), "accounts list failed: no account with a currency in the output"],
  ])("fails every brand of the project and posts nothing when accounts list %s", async (_name, accountsList, message) => {
    // A row without currency would be stored as THB and overwrite a stored USD row, so nothing is sent.
    const { posts, fetchImpl } = fakeCore();
    const errors: string[] = [];
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return args[2] === "accounts" ? accountsList() : fixture("adkit-results-hour-live.txt");
    };
    const now = new Date("2026-10-26T10:00:00Z");
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl, log: () => {}, error: (l) => errors.push(l), now })).toBe(2);
    expect(posts).toEqual([]);
    expect(calls.filter((a) => a[2] === "results")).toEqual([]);
    expect(errors.join("\n")).toContain(message);
    expect(errors.join("\n")).toContain("brand-a skipped: no accounts list to read the currency of account 4811219623");
  });

  it("sends rows without a currency (core stores THB) and warns when a parsed accounts list does not name the account", async () => {
    const { posts, fetchImpl } = fakeCore();
    const errors: string[] = [];
    const runAdkit = async (args: string[]) =>
      args[2] === "accounts" ? '{"accounts":[{"id":"5550001111","currencyCode":"USD"}]}' : fixture("adkit-results-hour-live.txt");
    const now = new Date("2026-10-26T10:00:00Z");
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl, log: () => {}, error: (l) => errors.push(l), now })).toBe(0);
    const rows = (posts[0] as { rows: Row[] }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !("currency" in r))).toBe(true);
    expect(errors.join("\n")).toContain("brand-a account 4811219623 has no currency in accounts list; core stores THB");
  });

  it("dry run POSTs nothing; a failing brand or ingest counts as a failure without stopping the rest", async () => {
    const dry = fakeCore();
    const errors: string[] = [];
    const runAdkit = async (args: string[]) => {
      if (args[2] === "accounts") return fixture("adkit-accounts-list.txt");
      if (args.includes("1234567890")) throw new Error("spawn adkit ENOENT");
      return fixture("adkit-results-hour-live.txt");
    };
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", dryRun: true, runAdkit, fetchImpl: dry.fetchImpl, log: () => {}, error: (l) => errors.push(l) })).toBe(1);
    expect(dry.posts).toEqual([]);
    expect(errors.join("\n")).toContain("brand-b adkit failed: spawn adkit ENOENT");

    const rejected = fakeCore(422);
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: rejected.fetchImpl, log: () => {}, error: () => {} })).toBe(2);
    expect(rejected.posts).toHaveLength(1);
  });
});
