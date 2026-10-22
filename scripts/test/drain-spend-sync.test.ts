import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only. No test here spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/spend-sync.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Row { brand_id: string; date: string; hour: number | null; cost: number; clicks: number; impressions: number }
interface Route { account: string; conversionAction: string; project?: string }
interface SpendSync {
  adkitArgsFor(route: Route, breakdown: string, fallbackProject?: string): string[];
  parseAdkitJson(stdout: string): unknown;
  spendRowsFromAdkit(out: unknown, brandId: string, breakdown: string): { rows: Row[]; skipped: number };
  syncSpend(options: {
    baseUrl: string; token: string; breakdown?: string; fallbackProject?: string; dryRun?: boolean;
    runAdkit: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    log?: (line: string) => void; error?: (line: string) => void;
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

  it("builds the account-level results command with the brand project, else the fallback", () => {
    const base = ["manage", "google", "results", "list", "--account", "4811219623", "--level", "account", "--breakdown", "hour", "--json"];
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1", project: "proj_a" }, "hour", "global"))
      .toEqual([...base, "--project", "proj_a"]);
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1" }, "hour", "global")).toEqual([...base, "--project", "global"]);
    expect(s.adkitArgsFor({ account: "4811219623", conversionAction: "1" }, "hour")).toEqual(base);
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
      return args.includes("4811219623") ? fixture("adkit-results-hour.txt") : '{"results":[]}';
    };
    const failures = await s.syncSpend({ baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl, log: () => {}, error: () => {} });
    expect(failures).toBe(0);
    expect(calls.map((a) => a[a.indexOf("--account") + 1])).toEqual(["4811219623", "1234567890"]);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { rows: Row[] }).rows.map((r) => [r.brand_id, r.hour, r.cost])).toEqual([
      ["brand-a", 0, 1.25], ["brand-a", 1, 0], ["brand-a", 13, 5],
    ]);
  });

  it("dry run POSTs nothing; a failing brand or ingest counts as a failure without stopping the rest", async () => {
    const dry = fakeCore();
    const errors: string[] = [];
    const runAdkit = async (args: string[]) => {
      if (args.includes("1234567890")) throw new Error("spawn adkit ENOENT");
      return fixture("adkit-results-hour.txt");
    };
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", dryRun: true, runAdkit, fetchImpl: dry.fetchImpl, log: () => {}, error: (l) => errors.push(l) })).toBe(1);
    expect(dry.posts).toEqual([]);
    expect(errors.join("\n")).toContain("brand-b adkit failed: spawn adkit ENOENT");

    const rejected = fakeCore(422);
    expect(await s.syncSpend({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: rejected.fetchImpl, log: () => {}, error: () => {} })).toBe(2);
    expect(rejected.posts).toHaveLength(1);
  });
});
