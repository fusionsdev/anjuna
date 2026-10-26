import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fixture CLI output only. Every test injects runAdkit and fetchImpl: none spawns adkit or reaches core.
const script = fileURLToPath(new URL("../drain/conversion-sync.mjs", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

interface Route { account: string; project?: string | null }
interface ConversionSync {
  generateName(randomBytes?: (n: number) => Buffer): string;
  pickUniqueName(existing: Map<string, string>, generate?: () => string): string;
  conversionCreateArgs(route: Route, name: string, fallbackProject?: string): string[];
  conversionListArgs(route: Route, fallbackProject?: string): string[];
  parseAdkitJson(stdout: string): unknown;
  conversionsByName(out: unknown): Map<string, string>;
  createdConversionId(out: unknown): string;
  syncConversions(options: {
    baseUrl: string; token: string; fallbackProject?: string; dryRun?: boolean;
    runAdkit: (args: string[]) => Promise<string>; fetchImpl: typeof fetch;
    generate?: () => string;
    log?: (line: string) => void; error?: (line: string) => void;
  }): Promise<number>;
}

let c: ConversionSync;
beforeAll(async () => { c = await import(pathToFileURL(script).href) as ConversionSync; });

const NAME_A = "cv-aaaaaaaaaaaaaaaa";
const NAME_STORED = "cv-0123456789abcdef";

describe("scripts/drain/conversion-sync.mjs helpers", () => {
  it("generateName returns cv- plus 16 hex and never contains brand or host text", () => {
    const name = c.generateName(() => Buffer.from("00ff10ab20cd30ef", "hex"));
    expect(name).toBe("cv-00ff10ab20cd30ef");
    expect(name).toMatch(/^cv-[0-9a-f]{16}$/);
    expect(c.generateName()).toMatch(/^cv-[0-9a-f]{16}$/);
  });

  it("pickUniqueName regenerates on a collision and throws after 5 collisions", () => {
    const taken = new Map([[NAME_A, "1"]]);
    const names = [NAME_A, NAME_A, "cv-bbbbbbbbbbbbbbbb"];
    expect(c.pickUniqueName(taken, () => names.shift() as string)).toBe("cv-bbbbbbbbbbbbbbbb");
    let calls = 0;
    expect(() => c.pickUniqueName(taken, () => { calls++; return NAME_A; })).toThrow(/unique/);
    expect(calls).toBe(5);
  });

  it("conversionCreateArgs builds manage google conversions create with --data settings, --publish and --json, plus --project", () => {
    const args = c.conversionCreateArgs({ account: "4811219623", project: "proj_a" }, NAME_A, "global");
    expect(args.slice(0, 6)).toEqual(["manage", "google", "conversions", "create", "--account", "4811219623"]);
    expect(JSON.parse(args[args.indexOf("--data") + 1])).toEqual({
      name: NAME_A, type: "upload_clicks", category: "purchase", status: "enabled", countingType: "one",
      defaultValue: 0, currency: "USD", alwaysUseDefaultValue: false, isPrimary: true,
    });
    expect(args).toContain("--publish");
    expect(args).toContain("--json");
    expect(args.slice(-2)).toEqual(["--project", "proj_a"]);
    expect(c.conversionCreateArgs({ account: "4811219623" }, NAME_A, "global").slice(-2)).toEqual(["--project", "global"]);
    expect(c.conversionCreateArgs({ account: "4811219623" }, NAME_A)).not.toContain("--project");
  });

  it("conversionListArgs builds the list call with --limit 500 and --json", () => {
    expect(c.conversionListArgs({ account: "4811219623", project: null })).toEqual([
      "manage", "google", "conversions", "list", "--account", "4811219623", "--limit", "500", "--json",
    ]);
    expect(c.conversionListArgs({ account: "4811219623", project: "proj_a" }).slice(-2)).toEqual(["--project", "proj_a"]);
  });

  it("parses the JSON tail after a notice line and maps names to ids", () => {
    const map = c.conversionsByName(c.parseAdkitJson(fixture("adkit-conversions-list.txt")));
    expect([...map]).toEqual([
      ["Purchase (legacy)", "7300000001"], [NAME_STORED, "7300000002"], ["cv-fedcba9876543210", "7300000003"],
    ]);
    expect(map.has("cv-1111111111111111")).toBe(false);
    expect(c.conversionsByName({})).toEqual(new Map());
  });

  it("conversionsByName skips removed actions case-insensitively", () => {
    const map = c.conversionsByName([
      { platformId: "1", name: "cv-aaaaaaaaaaaaaaaa", status: "removed" },
      { platformId: "2", name: "cv-bbbbbbbbbbbbbbbb", status: "Removed" },
      { platformId: "3", name: "cv-cccccccccccccccc", status: "ENABLED" },
    ]);
    expect([...map]).toEqual([["cv-cccccccccccccccc", "3"]]);
  });

  it("createdConversionId prefers a nested platformId over a generic top-level id", () => {
    expect(c.createdConversionId({ id: "rec_abc", conversion: { platformId: "123" } })).toBe("123");
    expect(c.createdConversionId({ id: "9", data: { conversionActionId: "77" } })).toBe("77");
    expect(c.createdConversionId({ id: "9", resourceName: "customers/1/conversionActions/55" })).toBe("9");
  });

  it("createdConversionId reads platformId, nested id and a resource name, and rejects non-digits", () => {
    expect(c.createdConversionId(c.parseAdkitJson(fixture("adkit-conversion-create.txt")))).toBe("7300000099");
    expect(c.createdConversionId({ platformId: 123 })).toBe("123");
    expect(c.createdConversionId({ result: { id: "456" } })).toBe("456");
    expect(c.createdConversionId({ data: { conversionActionId: "789" } })).toBe("789");
    expect(c.createdConversionId({ resourceName: "customers/4811219623/conversionActions/321" })).toBe("321");
    expect(() => c.createdConversionId({ platformId: "abc" })).toThrow();
    expect(() => c.createdConversionId({ platformId: "1".repeat(21) })).toThrow();
    expect(() => c.createdConversionId({ ok: true })).toThrow();
  });
});

describe("scripts/drain/conversion-sync.mjs job", () => {
  interface Setup { claimStatus?: number; resultStatus?: number; pending?: unknown[]; claimName?: string; claimAccount?: string }

  function fakeCore(setup: Setup = {}) {
    const pending = setup.pending ?? [{ brand_id: "brand-a", account: "4811219623", project: "proj_a", name: null }];
    const claims: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
      const path = new URL(String(url)).pathname;
      if (path === "/api/conversions/setup/pending") return Response.json({ brands: pending });
      if (path === "/api/conversions/setup/claim") {
        const body = JSON.parse(String(init?.body));
        claims.push(body);
        if (setup.claimStatus === 409) return Response.json({ status: "busy" }, { status: 409 });
        const row = (pending as { brand_id: string; account: string; project: string | null }[]).find((b) => b.brand_id === body.brand_id);
        return Response.json({
          status: "claimed", claim_id: `claim-${body.brand_id}`, name: setup.claimName ?? body.name,
          account: setup.claimAccount ?? row?.account, project: row?.project ?? null,
        });
      }
      if (path === "/api/conversions/setup/result") {
        results.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "created" }, { status: setup.resultStatus ?? 200 });
      }
      return new Response("Not Found", { status: 404 });
    });
    return { claims, results, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  const run = (core: ReturnType<typeof fakeCore>, runAdkit: (args: string[]) => Promise<string>, extra: Record<string, unknown> = {}) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const promise = c.syncConversions({
      baseUrl: "https://core.test/", token: "tok", runAdkit, fetchImpl: core.fetchImpl, generate: () => NAME_A,
      log: (l) => logs.push(l), error: (l) => errors.push(l), ...extra,
    });
    return { promise, logs, errors };
  };

  const isList = (args: string[]) => args[3] === "list";
  const isCreate = (args: string[]) => args[3] === "create";

  it("syncConversions creates, then records the id with the claim id", async () => {
    const core = fakeCore();
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return isList(args) ? '{"conversions":[],"total":0}' : fixture("adkit-conversion-create.txt");
    };
    const { promise, logs } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(core.claims).toEqual([{ brand_id: "brand-a", name: NAME_A }]);
    expect(calls.map((a) => a[3])).toEqual(["list", "create"]);
    expect(calls[1].slice(-2)).toEqual(["--project", "proj_a"]);
    expect(core.results).toEqual([{ brand_id: "brand-a", claim_id: "claim-brand-a", conversion_action_id: "7300000099" }]);
    expect(logs).toContain(`conversion-sync: brand-a created 7300000099 name=${NAME_A}`);
    expect(logs).toContain("conversion-sync: 1 created, 0 failed");
  });

  it("syncConversions adopts an existing conversion with the stored name and runs no create", async () => {
    const core = fakeCore({ pending: [{ brand_id: "brand-a", account: "4811219623", project: null, name: NAME_STORED }] });
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => { calls.push(args); return fixture("adkit-conversions-list.txt"); };
    const { promise, logs } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(calls.some(isCreate)).toBe(false);
    expect(core.claims).toEqual([{ brand_id: "brand-a", name: NAME_STORED }]);
    expect(core.results).toEqual([{ brand_id: "brand-a", claim_id: "claim-brand-a", conversion_action_id: "7300000002" }]);
    expect(logs).toContain(`conversion-sync: brand-a adopted 7300000002 name=${NAME_STORED}`);
  });

  it("syncConversions on a duplicate-name create error lists again and adopts", async () => {
    const core = fakeCore();
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (isList(args)) {
        lists++;
        return lists === 1 ? '{"conversions":[]}' : `{"conversions":[{"platformId":"555","name":"${NAME_A}"}]}`;
      }
      throw new Error("Command failed: conversion name already exists");
    };
    const { promise, logs } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(lists).toBe(2);
    expect(core.results).toEqual([{ brand_id: "brand-a", claim_id: "claim-brand-a", conversion_action_id: "555" }]);
    expect(logs).toContain(`conversion-sync: brand-a adopted 555 name=${NAME_A}`);
  });

  it("syncConversions posts an error result when a duplicate name is still not listed", async () => {
    const core = fakeCore();
    const runAdkit = async (args: string[]) => {
      if (isList(args)) return '{"conversions":[]}';
      return '{"error":"DUPLICATE_NAME"}';
    };
    const { promise } = run(core, runAdkit);
    expect(await promise).toBe(1);
    expect(core.results).toHaveLength(1);
    expect(core.results[0]).toMatchObject({ brand_id: "brand-a", claim_id: "claim-brand-a" });
    expect(core.results[0]).not.toHaveProperty("conversion_action_id");
  });

  it("syncConversions records a failure and continues with the next brand; exit count 1", async () => {
    const core = fakeCore({
      pending: [
        { brand_id: "brand-a", account: "4811219623", project: null, name: null },
        { brand_id: "brand-b", account: "1234567890", project: null, name: null },
      ],
    });
    const runAdkit = async (args: string[]) => {
      if (isList(args)) return '{"conversions":[]}';
      if (args.includes("4811219623")) throw new Error(`quota exceeded ${"x".repeat(900)}`);
      return fixture("adkit-conversion-create.txt");
    };
    const { promise, logs, errors } = run(core, runAdkit);
    expect(await promise).toBe(1);
    expect(core.results).toHaveLength(2);
    const failed = core.results[0] as { error: string };
    expect(failed.error).toContain("quota exceeded");
    expect(failed.error.length).toBeLessThanOrEqual(500);
    expect(core.results[1]).toMatchObject({ brand_id: "brand-b", conversion_action_id: "7300000099" });
    expect(errors.join("\n")).toContain("conversion-sync: brand-a failed: ");
    expect(logs).toContain("conversion-sync: 1 created, 1 failed");
  });

  it("syncConversions skips a busy claim without calling create", async () => {
    const core = fakeCore({ claimStatus: 409 });
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => { calls.push(args); return '{"conversions":[]}'; };
    const { promise, logs } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(calls.some(isCreate)).toBe(false);
    expect(core.results).toEqual([]);
    expect(logs).toContain("conversion-sync: brand-a busy");
  });

  it("syncConversions counts a stale result as a failure", async () => {
    const core = fakeCore({ resultStatus: 409 });
    const runAdkit = async (args: string[]) => (isList(args) ? '{"conversions":[]}' : fixture("adkit-conversion-create.txt"));
    const { promise, errors } = run(core, runAdkit);
    expect(await promise).toBe(1);
    expect(errors.join("\n")).toContain("stale");
  });

  it("--dry-run prints the planned creates and sends no claim, create or result", async () => {
    const core = fakeCore({
      pending: [
        { brand_id: "brand-a", account: "4811219623", project: null, name: null },
        { brand_id: "brand-b", account: "1234567890", project: null, name: NAME_STORED },
      ],
    });
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      return args.includes("1234567890") ? fixture("adkit-conversions-list.txt") : '{"conversions":[]}';
    };
    const { promise, logs } = run(core, runAdkit, { dryRun: true });
    expect(await promise).toBe(0);
    expect(calls.every(isList)).toBe(true);
    expect(core.claims).toEqual([]);
    expect(core.results).toEqual([]);
    expect(logs).toContain(`conversion-sync: brand-a plan create name=${NAME_A}`);
    expect(logs).toContain(`conversion-sync: brand-b plan adopt 7300000002 name=${NAME_STORED}`);
  });

  it("syncConversions lists the claimed account again when it differs from pending", async () => {
    const core = fakeCore({
      pending: [{ brand_id: "brand-a", account: "4811219623", project: null, name: NAME_STORED }],
      claimAccount: "9999999999",
    });
    const calls: string[][] = [];
    const runAdkit = async (args: string[]) => {
      calls.push(args);
      if (isList(args)) return args.includes("4811219623") ? fixture("adkit-conversions-list.txt") : '{"conversions":[]}';
      return fixture("adkit-conversion-create.txt");
    };
    const { promise } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(calls.map((a) => `${a[3]}:${a[5]}`)).toEqual(["list:4811219623", "list:9999999999", "create:9999999999"]);
    expect(core.results).toEqual([{ brand_id: "brand-a", claim_id: "claim-brand-a", conversion_action_id: "7300000099" }]);
  });

  it("syncConversions posts an error result when the duplicate-path list fails", async () => {
    const core = fakeCore();
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (isList(args)) {
        lists++;
        if (lists === 1) return '{"conversions":[]}';
        throw new Error("list exploded");
      }
      throw new Error("Command failed: conversion name already exists");
    };
    const { promise } = run(core, runAdkit);
    expect(await promise).toBe(1);
    expect(core.results).toHaveLength(1);
    const posted = core.results[0] as { claim_id: string; error: string };
    expect(posted.claim_id).toBe("claim-brand-a");
    expect(posted.error).toContain("already exists");
    expect(posted.error).toContain("list exploded");
    expect(posted.error.length).toBeLessThanOrEqual(500);
  });

  it("syncConversions on a duplicate in e.stdout adopts, and the error text carries no argv", async () => {
    const core = fakeCore();
    let lists = 0;
    const runAdkit = async (args: string[]) => {
      if (isList(args)) {
        lists++;
        return lists === 1 ? '{"conversions":[]}' : `{"conversions":[{"platformId":"555","name":"${NAME_A}"}]}`;
      }
      throw Object.assign(new Error(`Command failed: adkit ${args.join(" ")} --data {"name":"${NAME_A}"}`), {
        stdout: '{"error":"Duplicate name"}', stderr: "",
      });
    };
    const { promise } = run(core, runAdkit);
    expect(await promise).toBe(0);
    expect(core.results).toEqual([{ brand_id: "brand-a", claim_id: "claim-brand-a", conversion_action_id: "555" }]);

    const failing = fakeCore();
    const second = run(failing, async (args) => {
      if (isList(args)) return '{"conversions":[]}';
      throw Object.assign(new Error(`Command failed: adkit ${args.join(" ")} --data {"name":"${NAME_A}"}`), {
        stdout: '{"error":"quota exceeded"}', stderr: "",
      });
    });
    expect(await second.promise).toBe(1);
    const posted = failing.results[0] as { error: string };
    expect(posted.error).toContain("quota exceeded");
    expect(posted.error).not.toContain("--data");
  });

  it("syncConversions counts an empty pending name as a failure without claim, create or result", async () => {
    const core = fakeCore({ pending: [{ brand_id: "brand-a", account: "4811219623", project: null, name: "" }] });
    const calls: string[][] = [];
    const { promise, errors } = run(core, async (args) => { calls.push(args); return '{"conversions":[]}'; });
    expect(await promise).toBe(1);
    expect(core.claims).toEqual([]);
    expect(core.results).toEqual([]);
    expect(calls.some(isCreate)).toBe(false);
    expect(errors.join("\n")).toContain("invalid conversion name");
  });

  it("syncConversions rejects a malformed name without claiming", async () => {
    const core = fakeCore({ pending: [{ brand_id: "brand-a", account: "4811219623", project: null, name: "Purchase (legacy)" }] });
    const { promise, errors } = run(core, async () => '{"conversions":[]}');
    expect(await promise).toBe(1);
    expect(core.claims).toEqual([]);
    expect(core.results).toEqual([]);
    expect(errors.join("\n")).toContain("invalid conversion name");

    const bad = fakeCore({ claimName: "not-a-name" });
    const calls: string[][] = [];
    const second = run(bad, async (args) => { calls.push(args); return '{"conversions":[]}'; });
    expect(await second.promise).toBe(1);
    expect(calls.some(isCreate)).toBe(false);
    expect(bad.results).toHaveLength(1);
    expect(bad.results[0]).toMatchObject({ claim_id: "claim-brand-a" });
    expect(bad.results[0]).toHaveProperty("error");
  });

  it("no test spawns adkit: the default runner is never reached", async () => {
    const core = fakeCore();
    const runAdkit = vi.fn(async (args: string[]) => (isList(args) ? '{"conversions":[]}' : fixture("adkit-conversion-create.txt")));
    const { promise } = run(core, runAdkit);
    await promise;
    expect(runAdkit).toHaveBeenCalledTimes(2);
  });
});
