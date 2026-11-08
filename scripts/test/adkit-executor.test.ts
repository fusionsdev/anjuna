import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only. PATH is empty for the whole file, so a real `adkit` can never be found,
// and every job test injects runAdkit and fetchImpl: nothing spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/adkit-executor.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Payload { brand_draft_id: string; account: string; project: string | null; name: string }
interface Job { id: string; kind: string; payload: Payload | Record<string, unknown>; attempts: number }
interface Executor {
  ALLOWED_COMMANDS: readonly string[];
  assertAllowed(args: string[], kind?: string): void;
  guardAdkit(run: (args: string[], kind?: string) => Promise<string>): (args: string[], kind?: string) => Promise<string>;
  runAdkitCli(args: string[]): Promise<string>;
  makeAdkitCli(execImpl: (file: string, args: string[], options: object) => Promise<{ stdout: string }>): (args: string[]) => Promise<string>;
  executeJobs(options: {
    baseUrl: string; token: string; fallbackProject?: string;
    runAdkit?: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    log?: (line: string) => void; error?: (line: string) => void;
  }): Promise<number>;
}

let x: Executor;
let savedPath: string | undefined;
beforeAll(async () => {
  savedPath = process.env.PATH;
  process.env.PATH = "";
  x = await import(pathToFileURL(script).href) as Executor;
});
afterAll(() => { process.env.PATH = savedPath; });

const NAME = "cv-aaaaaaaaaaaaaaaa";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const job = (over: Partial<Job> = {}): Job => ({
  id: JOB_ID, kind: "conversion_action.create", attempts: 0,
  payload: { brand_draft_id: "brand-a", account: "4811219623", project: "proj_a", name: NAME }, ...over,
});

function fakeCore(jobs: Job[], claimStatus = 200) {
  const results: Array<Record<string, unknown>> = [];
  const claims: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
    expect(String(url)).not.toContain("tok");
    const path = new URL(String(url)).pathname;
    if (path === "/api/adkit/jobs/pending") return Response.json({ jobs });
    if (path === "/api/adkit/jobs/claim") {
      const { job_id } = JSON.parse(String(init?.body)) as { job_id: string };
      claims.push(job_id);
      const claimed = jobs.find((j) => j.id === job_id)!;
      return claimStatus === 200
        ? Response.json({ status: "claimed", claim_id: CLAIM_ID, job: claimed })
        : Response.json({ status: "busy" }, { status: claimStatus });
    }
    if (path === "/api/adkit/jobs/result") {
      results.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ status: "done" });
    }
    return new Response("Not Found", { status: 404 });
  });
  return { results, claims, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const quiet = { log: () => {}, error: () => {} };

describe("allowlist", () => {
  it("allows exactly eight commands", () => {
    expect([...x.ALLOWED_COMMANDS].sort()).toEqual([
      "accounts list", "campaigns create", "campaigns list", "campaigns update", "conversions create", "conversions list", "results campaigns", "results list",
    ]);
  });

  it("rejects campaigns update and every other command before spawning", async () => {
    const spawn = vi.fn(async () => "{}");
    const run = x.guardAdkit(spawn);
    for (const args of [
      ["manage", "google", "campaigns", "update", "--account", "4811219623"],
      ["manage", "google", "campaigns", "create"],
      ["manage", "google", "conversions", "delete"],
      ["manage", "meta", "accounts", "list"],
      ["login"],
      [],
    ]) {
      await expect(run(args), args.join(" ")).rejects.toThrow(/not allowed/);
    }
    expect(spawn).not.toHaveBeenCalled();
    await expect(run(["manage", "google", "accounts", "list", "--json"])).resolves.toBe("{}");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("the runner passes an allowed argv to execFile unchanged and never calls it for a rejected one", async () => {
    const execFile = vi.fn(async () => ({ stdout: '{"accounts":[]}' }));
    const run = x.makeAdkitCli(execFile);
    await expect(run(["manage", "google", "campaigns", "update"])).rejects.toThrow(/not allowed/);
    expect(execFile).not.toHaveBeenCalled();
    await expect(run(["manage", "google", "accounts", "list", "--json", "--project", "proj_a"])).resolves.toBe('{"accounts":[]}');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("adkit", ["manage", "google", "accounts", "list", "--json", "--project", "proj_a"],
      expect.objectContaining({ timeout: 120_000 }));
    // The exported real runner rejects before it reaches its execFile.
    await expect(x.runAdkitCli(["manage", "google", "campaigns", "update"])).rejects.toThrow(/not allowed/);
  });

  it("rejects an extra flag, a missing argument and an option-like value on an allowed command", async () => {
    const spawn = vi.fn(async () => "{}");
    const run = x.guardAdkit(spawn);
    const list = ["manage", "google", "conversions", "list", "--account", "4811219623", "--limit", "500", "--json"];
    const create = ["manage", "google", "conversions", "create", "--account", "4811219623", "--data", '{"conversions":[]}', "--publish", "--json"];
    const swap = (args: string[], index: number, arg: string) => args.map((a, i) => (i === index ? arg : a));
    for (const args of [
      [...list, "--help"],
      [...list, "--project", "--help"],
      [...list, "--project", "-x"],
      [...list, "--project"],
      [...list, "--project", "proj_a", "--json"],
      ["manage", "google", "accounts", "list", "--json", "--all"],
      ["manage", "google", "accounts", "list"],
      swap(list, 5, "--help"),
      swap(list, 7, "5000"),
      swap(create, 7, "--publish"),
      swap(create, 7, "[1]"),
      create.filter((a) => a !== "--publish"),
      ["manage", "google", "results", "list", "--account", "4811219623", "--breakdown", "week", "--from", "2026-11-01", "--to", "2026-11-01", "--json"],
    ]) {
      await expect(run(args), args.join(" ")).rejects.toThrow(/not allowed/);
    }
    expect(spawn).not.toHaveBeenCalled();
    for (const args of [list, [...list, "--project", "proj_a"], create,
      ["manage", "google", "results", "list", "--account", "4811219623", "--breakdown", "hour", "--from", "2026-11-01", "--to", "2026-11-01", "--json"]]) {
      await expect(run(args), args.join(" ")).resolves.toBe("{}");
    }
  });

  it("refuses an option-like fallback project or payload project before any adkit call", async () => {
    const spawn = vi.fn(async () => "{}");
    const core = fakeCore([job()]);
    await expect(x.executeJobs({ baseUrl: "https://core.test", token: "tok", fallbackProject: "--help", runAdkit: spawn, fetchImpl: core.fetchImpl, ...quiet }))
      .rejects.toThrow(/invalid adkit project/);
    const bad = fakeCore([job({ payload: { ...job().payload, project: "--help" } })]);
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: spawn, fetchImpl: bad.fetchImpl, ...quiet })).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(bad.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "invalid conversion_action.create payload", retryable: false }]);
  });
});

describe("conversion_action.create jobs", () => {
  it("creates the action with --publish and posts result.conversion_action_id", async () => {
    const core = fakeCore([job()]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return args[3] === "list" ? fixture("adkit-conversions-list.txt") : fixture("adkit-conversion-create.txt");
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(calls.map((a) => a.slice(2, 4).join(" "))).toEqual(["conversions list", "conversions create"]);
    const create = calls[1]!;
    expect(create).toContain("--publish");
    expect(create.slice(create.indexOf("--account"), create.indexOf("--account") + 2)).toEqual(["--account", "4811219623"]);
    expect(create.slice(-2)).toEqual(["--project", "proj_a"]);
    expect((JSON.parse(create[create.indexOf("--data") + 1]!) as { conversions: Array<{ name: string }> }).conversions[0]!.name).toBe(NAME);
    expect(core.results).toEqual([
      { job_id: JOB_ID, claim_id: CLAIM_ID, result: { conversion_action_id: "7300000099", name: NAME, adopted: false } },
    ]);
  });

  it("adopts the existing action on a duplicate-name error", async () => {
    const core = fakeCore([job()]);
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (args[3] === "list") {
        lists++;
        return lists === 1 ? '{"conversions":[]}' : JSON.stringify({ conversions: [{ platformId: "7300000123", name: NAME, status: "ENABLED" }] });
      }
      throw Object.assign(new Error("Command failed"), { stderr: "Error: DUPLICATE_NAME conversion action already exists" });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(lists).toBe(2);
    expect(core.results).toEqual([
      { job_id: JOB_ID, claim_id: CLAIM_ID, result: { conversion_action_id: "7300000123", name: NAME, adopted: true } },
    ]);
  });

  it("adopts a name already in the account without creating (crashed earlier run)", async () => {
    const core = fakeCore([job({ payload: { ...job().payload, name: "cv-0123456789abcdef" } })]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => { calls.push(args); return fixture("adkit-conversions-list.txt"); };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(calls.map((a) => a[3])).toEqual(["list"]);
    expect(core.results[0]).toMatchObject({ result: { conversion_action_id: "7300000002", name: "cv-0123456789abcdef", adopted: true } });
  });

  it("posts a retryable error when adkit fails, and skips a job another run claimed", async () => {
    const failing = fakeCore([job()]);
    const errors: string[] = [];
    const runAdkit = async () => { throw Object.assign(new Error("Command failed: adkit ..."), { stderr: "rate limited" }); };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: failing.fetchImpl, log: () => {}, error: (l) => errors.push(l) })).toBe(1);
    expect(failing.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "rate limited" }]);
    expect(errors.join("\n")).toContain("rate limited");

    const busy = fakeCore([job()], 409);
    const spawn = vi.fn(async () => "{}");
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: spawn, fetchImpl: busy.fetchImpl, ...quiet })).toBe(0);
    expect(busy.claims).toEqual([JOB_ID]);
    expect(spawn).not.toHaveBeenCalled();
    expect(busy.results).toEqual([]);
  });

  it("fails an unknown job kind for good without running adkit", async () => {
    const core = fakeCore([job({ kind: "campaign.delete" })]);
    const spawn = vi.fn(async () => "{}");
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: spawn, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: expect.stringContaining("campaign.delete"), retryable: false }]);
  });
});

describe("campaign jobs (T13 Part B)", () => {
  const ACCOUNT = "4811219623";
  const CAMPAIGN = "22000000001";
  const draftPayload = {
    brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1", daily_budget: 500,
    bid_strategy: "maximize_conversions", geo: { country: "US" }, keywords: ["personal loans"], final_url: "https://petvet.example/",
  };
  const ref = { campaign_id: CAMPAIGN, brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1" };
  const create = (data: unknown, extra: string[] = []) =>
    ["manage", "google", "campaigns", "create", "--account", ACCOUNT, "--data", JSON.stringify(data), ...extra, "--json"];
  const update = (data: unknown, publish: boolean) => ["manage", "google", "campaigns", "update", "--account", ACCOUNT,
    "--campaign", CAMPAIGN, "--data", JSON.stringify(data), ...(publish ? ["--publish"] : []), "--json"];
  const guard = () => {
    const spawn = vi.fn(async () => "{}");
    return { spawn, guarded: x.guardAdkit(spawn) };
  };

  it("rejects campaigns create --publish, campaigns delete and raw passthroughs before spawning", async () => {
    const { spawn, guarded } = guard();
    for (const [args, kind] of [
      [create({ campaigns: [{ name: "petvet-search-1" }] }, ["--publish"]), "campaign.draft.create"],
      [["manage", "google", "campaigns", "delete", "--account", ACCOUNT, "--campaign", CAMPAIGN, "--json"], "campaign.pause"],
      [["manage", "google", "platform-api-request", "--data", "{}", "--json"], "campaign.enable"],
      [["manage", "google", "campaigns", "remove", "--account", ACCOUNT, "--json"], "campaign.pause"],
    ] as Array<[string[], string]>) {
      await expect(guarded(args, kind), args.join(" ")).rejects.toThrow(/not allowed/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("checks the job kind, not only the argv", async () => {
    const { spawn, guarded } = guard();
    const draft = create({ campaigns: [{ name: "petvet-search-1", dailyBudget: 5 }] });
    for (const [args, kind] of [
      [draft, undefined],
      [draft, "campaign.enable"],
      [create({ campaigns: [{ name: "petvet-search-1", status: "ENABLED" }] }), "campaign.draft.create"],
      [update({ status: "ENABLED" }, true), undefined],
      [update({ status: "ENABLED" }, true), "campaign.pause"],
      [update({ status: "ENABLED" }, true), "campaign.draft.create"],
      [update({ status: "ENABLED" }, true), "campaign.update_budget"],
      [update({ status: "ENABLED" }, false), "campaign.enable"],
      [update({ status: "PAUSED" }, true), "campaign.enable"],
      [update({ status: "ENABLED", dailyBudget: 5 }, true), "campaign.enable"],
      [update({ dailyBudget: 5 }, true), "campaign.update_budget"],
      [update({ dailyBudget: -5 }, false), "campaign.update_budget"],
      [update({ dailyBudget: 5, status: "ENABLED" }, false), "campaign.update_budget"],
      [update({ dailyBudget: 5 }, false), "campaign.enable"],
    ] as Array<[string[], string | undefined]>) {
      await expect(guarded(args, kind), `${kind} ${args.join(" ")}`).rejects.toThrow(/not allowed/);
    }
    expect(spawn).not.toHaveBeenCalled();
    for (const [args, kind] of [
      [draft, "campaign.draft.create"],
      [update({ status: "ENABLED" }, true), "campaign.enable"],
      [update({ status: "PAUSED" }, true), "campaign.pause"],
      [update({ dailyBudget: 5 }, false), "campaign.update_budget"],
    ] as Array<[string[], string]>) {
      await expect(guarded(args, kind), `${kind} ${args.join(" ")}`).resolves.toBe("{}");
    }
  });

  it("creates a draft without --publish after listing, and posts the campaign id", async () => {
    const core = fakeCore([job({ kind: "campaign.draft.create", payload: draftPayload })]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      const created = { campaign: { resourceName: `customers/${ACCOUNT}/campaigns/${CAMPAIGN}` } };
      return args[3] === "list" ? JSON.stringify({ campaigns: [] }) : `notice\n${JSON.stringify(created)}`;
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(calls.map((a) => a.slice(2, 4).join(" "))).toEqual(["campaigns list", "campaigns create"]);
    const created = calls[1]!;
    expect(created).not.toContain("--publish");
    expect(created.slice(-2)).toEqual(["--project", "proj_a"]);
    const data = JSON.parse(created[created.indexOf("--data") + 1]!) as { campaigns: Array<Record<string, unknown>> };
    expect(data.campaigns[0]).toMatchObject({ name: "petvet-search-1", dailyBudget: 500, biddingStrategy: "MAXIMIZE_CONVERSIONS" });
    expect(JSON.stringify(data)).not.toMatch(/status|publish/);
    expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, result: { campaign_id: CAMPAIGN, name: "petvet-search-1", adopted: false, status: "DRAFT", daily_budget: 500 } }]);
  });

  it("a retried draft adopts the campaign a crashed run created, so there is one campaign", async () => {
    const core = fakeCore([job({ kind: "campaign.draft.create", payload: draftPayload, attempts: 1 })]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ campaigns: [{ id: CAMPAIGN, name: "petvet-search-1", status: "PAUSED", dailyBudget: 500 }] });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(calls.map((a) => a[3])).toEqual(["list"]);
    expect(core.results[0]).toMatchObject({ result: { campaign_id: CAMPAIGN, adopted: true } });
  });

  it("enable sends exactly {status: ENABLED} with --publish; pause PAUSED", async () => {
    for (const [kind, payload, data, publish, result] of [
      ["campaign.enable", ref, { status: "ENABLED" }, true, { campaign_id: CAMPAIGN, status: "ENABLED" }],
      ["campaign.pause", ref, { status: "PAUSED" }, true, { campaign_id: CAMPAIGN, status: "PAUSED" }],
    ] as const) {
      const core = fakeCore([job({ kind, payload })]);
      const calls: string[][] = [];
      const runAdkit = async (args: string[]) => { calls.push(args); return "{}"; };
      expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]![calls[0]!.indexOf("--data") + 1]!)).toEqual(data);
      expect(calls[0]!.includes("--publish"), kind).toBe(publish);
      expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, result }]);
    }
  });

  describe("budget update is verified through campaigns list", () => {
    const budgetJob = () => job({ kind: "campaign.update_budget", payload: { ...ref, daily_budget: 750.5 } });
    const runWith = async (listed: unknown) => {
      const core = fakeCore([budgetJob()]);
      const calls: string[][] = [];
      const runAdkit = async (args: string[]) => { calls.push(args); return args[3] === "list" ? JSON.stringify(listed) : "{}"; };
      const failures = await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet });
      return { failures, calls, results: core.results };
    };

    it("sends exactly {dailyBudget} without --publish, then reports done only when AdKit lists the new budget", async () => {
      const { failures, calls, results } = await runWith({ campaigns: [{ id: CAMPAIGN, name: "petvet-search-1", status: "ENABLED", dailyBudget: 750.5 }] });
      expect(failures).toBe(0);
      expect(calls.map((a) => a[3])).toEqual(["update", "list"]);
      expect(JSON.parse(calls[0]![calls[0]!.indexOf("--data") + 1]!)).toEqual({ dailyBudget: 750.5 });
      expect(calls[0]).not.toContain("--publish");
      expect(results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, result: { campaign_id: CAMPAIGN, daily_budget: 750.5 } }]);
    });

    it("an old budget in the listing is budget_not_applied with what AdKit reports, never done", async () => {
      const { results } = await runWith({ campaigns: [{ id: CAMPAIGN, name: "petvet-search-1", status: "ENABLED", dailyBudget: 300 }] });
      expect(results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "budget_not_applied: AdKit reports 300", retryable: false }]);
    });

    it("a listing that cannot show the campaign is budget_unverified, never done", async () => {
      expect((await runWith({ campaigns: [] })).results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "budget_unverified", retryable: false }]);
    });
  });

  it("a spend job that failed before any write says wrote: false; after a write it does not", async () => {
    const before = fakeCore([job({ kind: "campaign.enable", payload: { ...ref, campaign_id: "--all" } })]);
    await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: vi.fn(async () => "{}"), fetchImpl: before.fetchImpl, ...quiet });
    expect(before.results[0]).toMatchObject({ retryable: false, wrote: false });
    const after = fakeCore([job({ kind: "campaign.enable", payload: ref })]);
    const failing = async () => { throw Object.assign(new Error("Command failed"), { stderr: "timeout" }); };
    await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: failing, fetchImpl: after.fetchImpl, ...quiet });
    expect(after.results[0]).toEqual({ job_id: JOB_ID, claim_id: CLAIM_ID, error: "timeout" });
  });

  it("fails a malformed campaign payload for good without running adkit", async () => {
    for (const [kind, payload] of [
      ["campaign.draft.create", { ...draftPayload, name: "--publish" }],
      ["campaign.draft.create", { ...draftPayload, final_url: "http://petvet.example/" }],
      ["campaign.draft.create", { ...draftPayload, daily_budget: Number.NaN }],
      ["campaign.enable", { ...ref, campaign_id: "--all" }],
      ["campaign.update_budget", { ...ref, daily_budget: -1 }],
    ] as const) {
      const core = fakeCore([job({ kind, payload })]);
      const spawn = vi.fn(async () => "{}");
      expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: spawn, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(core.results[0]).toMatchObject({ job_id: JOB_ID, claim_id: CLAIM_ID, error: `invalid ${kind} payload`, retryable: false });
    }
  });
});

describe("campaign.status_check (T13-4 F2)", () => {
  const ACCOUNT = "4811219623";
  const ref = { campaign_id: "22000000001", brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1" };
  const runWith = async (listOutput: unknown) => {
    const core = fakeCore([job({ kind: "campaign.status_check", payload: ref })]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => { calls.push(args); return JSON.stringify(listOutput); };
    const failures = await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet });
    return { failures, calls, results: core.results };
  };

  it("reports the listed status and budget with one read-only list call", async () => {
    const { failures, calls, results } = await runWith({ campaigns: [{ id: "22000000001", name: "petvet-search-1", status: "enabled", dailyBudget: 2000 }] });
    expect(failures).toBe(0);
    expect(calls.map((a) => a.slice(2, 4).join(" "))).toEqual(["campaigns list"]);
    expect(results[0]).toMatchObject({ result: { campaign_id: "22000000001", observed_status: "ENABLED", daily_budget: 2000 } });
  });

  it("reports NOT_FOUND only from a complete listing", async () => {
    expect((await runWith({ campaigns: [] })).results[0]).toMatchObject({ result: { observed_status: "NOT_FOUND", daily_budget: null } });
  });
});

describe("F3: a draft retry never creates a second campaign", () => {
  const ACCOUNT = "4811219623";
  const draftPayload = {
    brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1", daily_budget: 500,
    bid_strategy: "maximize_conversions", geo: { country: "US" }, keywords: ["personal loans"], final_url: "https://petvet.example/",
  };
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(30000000000 + from + i), name: `other-search-${from + i}`, status: "PAUSED", dailyBudget: 10 }));
  const draftJob = () => job({ kind: "campaign.draft.create", payload: draftPayload, attempts: 1 });

  it("finds the campaign on page 2 (row 750) through --page-token and adopts it without a create", async () => {
    const core = fakeCore([draftJob()]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      if (args[3] !== "list") return JSON.stringify({ campaign: { id: "9002" } });
      if (!args.includes("--page-token")) return JSON.stringify({ campaigns: filler(0, 500), nextPageToken: "tok-2" });
      expect(args[args.indexOf("--page-token") + 1]).toBe("tok-2");
      return JSON.stringify({ campaigns: [...filler(500, 249), { id: "9001", name: "petvet-search-1", status: "PAUSED", dailyBudget: 500 }] });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(calls.map((a) => a[3])).toEqual(["list", "list"]);
    expect(core.results[0]).toMatchObject({ result: { campaign_id: "9001", adopted: true, status: "PAUSED", daily_budget: 500 } });
  });

  it("a full page with no next token cannot prove the name is absent: fails for good without a create", async () => {
    const core = fakeCore([draftJob()]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => { calls.push(args); return JSON.stringify({ campaigns: filler(0, 500) }); };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(calls.map((a) => a[3])).toEqual(["list"]);
    expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "lookup_incomplete", retryable: false }]);
  });

  it("stops after the page bound and fails without a create", async () => {
    const core = fakeCore([draftJob()]);
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (args[3] !== "list") throw new Error("create must not run");
      lists++;
      return JSON.stringify({ campaigns: filler(lists * 500, 500), nextPageToken: `tok-${lists + 1}` });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(lists).toBe(8);
    expect(core.results[0]).toMatchObject({ error: "lookup_incomplete", retryable: false });
  });

  it("stops listing when the next page could run past the job deadline (25 min after the claim) and fails without a create", async () => {
    const core = fakeCore([draftJob()]);
    let clock = 1_000_000;
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (args[3] !== "list") throw new Error("create must not run");
      lists++;
      clock += 7 * 60_000; // each page takes 7 minutes
      return JSON.stringify({ campaigns: filler(lists * 500, 500), nextPageToken: `tok-${lists + 1}` });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, now: () => clock, ...quiet } as never)).toBe(1);
    // Page 4 starts at 21 min (its 120 s CLI timeout ends by 23 min). Page 5 would start at 28 min: refused.
    expect(lists).toBe(4);
    expect(core.results[0]).toMatchObject({ error: "lookup_incomplete", retryable: false });
  });

  it("an injected lookup that cannot confirm completeness blocks the create", async () => {
    const core = fakeCore([draftJob()]);
    const spawn = vi.fn(async () => "{}");
    const listCampaigns = vi.fn(async () => ({ rows: [], complete: false }));
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit: spawn, listCampaigns, fetchImpl: core.fetchImpl, ...quiet } as never)).toBe(1);
    expect(listCampaigns).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(core.results[0]).toMatchObject({ error: "lookup_incomplete", retryable: false });
  });

  it("a create that returns no campaign id fails for good, so the next run cannot create again", async () => {
    const core = fakeCore([draftJob()]);
    const runAdkit = async (args: string[]) => (args[3] === "list" ? JSON.stringify({ campaigns: [] }) : JSON.stringify({ ok: true }));
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(core.results[0]).toMatchObject({ error: expect.stringContaining("created_without_id"), retryable: false });
  });

  it.each([
    ["a timeout", { message: "Command failed", stderr: "timed out after 120 s" }, "timed out after 120 s"],
    ["a duplicate the lookup cannot find", { message: "Command failed", stderr: "campaign already exists" }, "campaign already exists"],
  ])("a create that fails with %s after it started fails for good, so no retry creates a second campaign", async (_label, err, text) => {
    const core = fakeCore([draftJob()]);
    let creates = 0;
    const runAdkit = async (args: string[]) => {
      if (args[3] === "list") return JSON.stringify({ campaigns: [] });
      creates++;
      throw Object.assign(new Error(err.message), { stderr: err.stderr });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(creates).toBe(1);
    expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: expect.stringContaining(text), retryable: false }]);
    expect(String(core.results[0]!.error)).toMatch(/^create_failed: /);
  });

  it("a duplicate create whose follow-up lookup times out fails for good, so no retry creates a second campaign", async () => {
    const core = fakeCore([draftJob()]);
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (args[3] === "list" && ++lists === 1) return JSON.stringify({ campaigns: [] });
      if (args[3] === "list") throw Object.assign(new Error("Command failed"), { stderr: "list timed out after 120 s" });
      throw Object.assign(new Error("Command failed"), { stderr: "campaign already exists" });
    };
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
    expect(lists).toBe(2);
    expect(core.results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: expect.stringMatching(/^create_failed: .*list timed out/), retryable: false }]);
  });

  it("a page token that looks like a flag is refused by the allowlist", async () => {
    const guarded = x.guardAdkit(vi.fn(async () => "{}"));
    await expect(guarded(["manage", "google", "campaigns", "list", "--account", ACCOUNT, "--limit", "500", "--page-token", "--publish", "--json"]))
      .rejects.toThrow(/not allowed/);
  });
});

describe("G2: a malformed or truncated list is never complete", () => {
  const ACCOUNT = "4811219623";
  const draftPayload = {
    brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1", daily_budget: 500,
    bid_strategy: "maximize_conversions", geo: { country: "US" }, keywords: ["personal loans"], final_url: "https://petvet.example/",
  };
  const ref = { campaign_id: "22000000001", brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1" };
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(30000000000 + i), name: `other-search-${i + 1}`, status: "PAUSED", dailyBudget: 10 }));
  const runBoth = async (listOutput: unknown) => {
    const out: Record<string, { calls: string[][]; results: Array<Record<string, unknown>> }> = {};
    for (const [kind, payload] of [["campaign.draft.create", draftPayload], ["campaign.status_check", ref]] as const) {
      const core = fakeCore([job({ kind, payload, attempts: 1 })]);
      const calls: string[][] = [];
      const runAdkit = async (args: string[]) => {
        calls.push(args);
        if (args[3] !== "list") throw new Error("create must not run");
        return JSON.stringify(listOutput);
      };
      expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
      out[kind] = { calls, results: core.results };
    }
    return out;
  };
  const failsClosed = (out: Awaited<ReturnType<typeof runBoth>>) => {
    for (const [kind, { calls, results }] of Object.entries(out)) {
      expect(calls.map((a) => a[3]), kind).toEqual(["list"]);
      expect(results, kind).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "lookup_incomplete", retryable: false }]);
    }
  };

  it.each([
    ["{}", {}],
    ["an object without a rows array", { campaigns: "none", nextPageToken: null }],
    ["null", null],
    ["500 raw rows with 1 unparseable", { campaigns: [...filler(499), { name: "broken-search-1", status: "PAUSED" }] }],
    ["3 raw rows with 1 unparseable", { campaigns: [...filler(2), { id: "not-a-number", name: "x-search-1" }] }],
    ["a row that is not an object", { campaigns: [...filler(2), "22000000001"] }],
    ["a next page token that is not a string", { campaigns: filler(2), nextPageToken: 7 }],
    ["a page cursor under an unknown name", { campaigns: filler(100), cursor: "c-2" }],
    ["hasMore: true without a token", { campaigns: filler(2), hasMore: true }],
    ["pageInfo.hasNextPage: true without a token", { campaigns: filler(2), pageInfo: { hasNextPage: true } }],
    ["an offset for the next page", { data: filler(2), nextOffset: 100 }],
    ["a total above the rows read", { campaigns: filler(2), total: 600 }],
    ["a totalCount above the rows read", { campaigns: filler(2), totalCount: 3 }],
    ["totalPages above the pages read", { campaigns: filler(2), totalPages: 2 }],
  ])("%s: no create, no NOT_FOUND", async (_label, listOutput) => {
    failsClosed(await runBoth(listOutput));
  });

  it("a page that says there is no more (hasMore: false, empty cursor) stays complete: NOT_FOUND", async () => {
    const core = fakeCore([job({ kind: "campaign.status_check", payload: ref })]);
    const runAdkit = async () => JSON.stringify({ campaigns: filler(2), hasMore: false, cursor: "", pageInfo: { hasNextPage: false }, total: 2, totalPages: 1 });
    expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
    expect(core.results[0]).toMatchObject({ result: { observed_status: "NOT_FOUND" } });
  });

  describe("L1: total and totalPages are remembered across every page", () => {
    const pagedRun = (pages: unknown[]) => {
      const calls: string[][] = [];
      const runAdkit = async (args: string[]) => {
        calls.push(args);
        if (args[3] !== "list") throw new Error("create must not run");
        const token = args.includes("--page-token") ? args[args.indexOf("--page-token") + 1]! : "p1";
        return JSON.stringify(pages[Number(token.slice(1)) - 1]);
      };
      return { calls, runAdkit };
    };

    it("page 1 says total 600 and totalPages 3, page 2 has no token and no total: lookup_incomplete, never NOT_FOUND, no create", async () => {
      const pages = [
        { campaigns: filler(1), total: 600, totalPages: 3, nextPageToken: "p2" },
        { campaigns: [{ id: "30000000099", name: "other-search-99", status: "PAUSED", dailyBudget: 10 }] },
      ];
      for (const [kind, payload] of [["campaign.status_check", ref], ["campaign.draft.create", draftPayload]] as const) {
        const core = fakeCore([job({ kind, payload, attempts: 1 })]);
        const { calls, runAdkit } = pagedRun(pages);
        expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
        expect(calls.map((a) => a[3]), kind).toEqual(["list", "list"]);
        expect(core.results, kind).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: "lookup_incomplete", retryable: false }]);
      }
    });

    it("totalPages alone on page 1 (3 pages) with 2 pages read is incomplete", async () => {
      const core = fakeCore([job({ kind: "campaign.status_check", payload: ref })]);
      const { runAdkit } = pagedRun([{ campaigns: filler(1), totalPages: 3, nextPageToken: "p2" }, { campaigns: filler(1) }]);
      expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(1);
      expect(core.results[0]).toMatchObject({ error: "lookup_incomplete", retryable: false });
    });

    it("a consistent 2-page list whose total equals the rows read stays complete: NOT_FOUND", async () => {
      const core = fakeCore([job({ kind: "campaign.status_check", payload: ref })]);
      const { calls, runAdkit } = pagedRun([
        { campaigns: filler(1), total: 2, totalPages: 2, nextPageToken: "p2" },
        { campaigns: [{ id: "30000000099", name: "other-search-99", status: "PAUSED", dailyBudget: 10 }] },
      ]);
      expect(await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet })).toBe(0);
      expect(calls).toHaveLength(2);
      expect(core.results[0]).toMatchObject({ result: { observed_status: "NOT_FOUND", daily_budget: null } });
    });
  });
});

describe("F4: adopting by name needs name, budget and a paused or draft status", () => {
  const ACCOUNT = "4811219623";
  const draftPayload = {
    brand_id: "petvet", account: ACCOUNT, project: "proj_a", name: "petvet-search-1", daily_budget: 500,
    bid_strategy: "maximize_conversions", geo: { country: "US" }, keywords: ["personal loans"], final_url: "https://petvet.example/",
  };
  const runWith = async (existing: Record<string, unknown>) => {
    const core = fakeCore([job({ kind: "campaign.draft.create", payload: draftPayload, attempts: 1 })]);
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      if (args[3] !== "list") throw new Error("create must not run");
      return JSON.stringify({ campaigns: [{ id: "9001", name: "petvet-search-1", ...existing }] });
    };
    const failures = await x.executeJobs({ baseUrl: "https://core.test", token: "tok", runAdkit, fetchImpl: core.fetchImpl, ...quiet });
    return { failures, calls, results: core.results };
  };

  it.each([
    ["a different budget", { status: "PAUSED", dailyBudget: 9000 }, "adopt_budget_mismatch"],
    ["no readable budget", { status: "PAUSED" }, "adopt_budget_mismatch"],
    ["an ENABLED campaign", { status: "ENABLED", dailyBudget: 500 }, "adopt_status_enabled"],
    ["an ENABLED campaign with another budget", { status: "ENABLED", dailyBudget: 9000 }, "adopt_status_enabled"],
  ])("refuses %s for good, without a create", async (_label, existing, code) => {
    const { failures, calls, results } = await runWith(existing);
    expect(failures).toBe(1);
    expect(calls.map((a) => a[3])).toEqual(["list"]);
    expect(results).toEqual([{ job_id: JOB_ID, claim_id: CLAIM_ID, error: code, retryable: false }]);
  });

  it.each(["PAUSED", "draft"])("adopts a matching %s campaign and reports its status and budget", async (status) => {
    const { failures, results } = await runWith({ status, dailyBudget: 500 });
    expect(failures).toBe(0);
    expect(results[0]).toMatchObject({ result: { campaign_id: "9001", adopted: true, status: status.toUpperCase(), daily_budget: 500 } });
  });
});
