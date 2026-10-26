import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only. No test here spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/spend-sync.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Row { brand_id: string; date: string; hour: number | null; cost: number; clicks: number; impressions: number }
interface Route { account: string; conversionAction: string; project?: string }
interface SpendSync {
  adkitArgsFor(route: Route, breakdown: string, fallbackProject: string | undefined, date: string): string[];
  syncDates(now?: Date): string[];
  parseAdkitJson(stdout: string): unknown;
  spendRowsFromAdkit(out: unknown, brandId: string, breakdown: string, defaultDate?: string): { rows: Row[]; skipped: number };
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
      return args.includes("4811219623") ? fixture("adkit-results-hour-live.txt") : '{"results":[]}';
    };
    const now = new Date("2026-10-26T10:00:00Z");
    const failures = await s.syncSpend({ baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl, log: () => {}, error: () => {}, now });
    expect(failures).toBe(0);
    expect(calls.map((a) => [a[a.indexOf("--account") + 1], a[a.indexOf("--from") + 1], a[a.indexOf("--to") + 1]])).toEqual([
      ["4811219623", "2026-10-25", "2026-10-25"], ["4811219623", "2026-10-26", "2026-10-26"],
      ["1234567890", "2026-10-25", "2026-10-25"], ["1234567890", "2026-10-26", "2026-10-26"],
    ]);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { rows: Row[] }).rows.map((r) => [r.brand_id, r.date, r.hour, r.cost])).toEqual([
      ["brand-a", "2026-10-25", 2, 133.72], ["brand-a", "2026-10-25", 3, 40.5], ["brand-a", "2026-10-25", 14, 0],
      ["brand-a", "2026-10-26", 2, 133.72], ["brand-a", "2026-10-26", 3, 40.5], ["brand-a", "2026-10-26", 14, 0],
    ]);
  });

  it("dry run POSTs nothing; a failing brand or ingest counts as a failure without stopping the rest", async () => {
    const dry = fakeCore();
    const errors: string[] = [];
    const runAdkit = async (args: string[]) => {
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
