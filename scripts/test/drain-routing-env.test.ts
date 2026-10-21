import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../drain/routing-env.mjs", import.meta.url));
const ROUTE = '{"brand-a":{"account":"4811219623","conversionAction":"7754587837"}}';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "drain-routing-env-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function cli(file: string) {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, [script, file], { timeout: 20_000, windowsHide: true }, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout }));
  });
}

// What run.sh and scheduler.mjs export as BRAND_ROUTING_JSON. An empty map must stay unset, or
// drain.mjs runs "routing active, 0 keys" and skips every row instead of legacy single-account mode.
describe("scripts/drain/routing-env.mjs", () => {
  it("prints a map with at least 1 brand", async () => {
    const file = join(directory, "routing.json");
    await writeFile(file, `${ROUTE}\n`);
    expect(await cli(file)).toEqual({ code: 0, stdout: ROUTE });
  });

  it.each([
    ["an empty map", "{}\n"],
    ["an empty file", ""],
    ["malformed JSON", "{not json"],
    ["an array", '["brand-a"]'],
    ["null", "null"],
  ])("prints nothing and exits 1 for %s", async (_name, text) => {
    const file = join(directory, "routing.json");
    await writeFile(file, text);
    expect(await cli(file)).toEqual({ code: 1, stdout: "" });
  });

  it("prints nothing and exits 1 for a missing file", async () => {
    expect(await cli(join(directory, "absent.json"))).toEqual({ code: 1, stdout: "" });
  });

  it("gives scheduler.mjs the same answer through routingFromFile", async () => {
    const helper = await import(pathToFileURL(script).href) as { routingFromFile: (file: string) => string | null };
    const full = join(directory, "full.json");
    const empty = join(directory, "empty.json");
    await writeFile(full, ROUTE);
    await writeFile(empty, "{}");
    expect(helper.routingFromFile(full)).toBe(ROUTE);
    expect(helper.routingFromFile(empty)).toBeNull();
    expect(helper.routingFromFile(join(directory, "absent.json"))).toBeNull();
  });
});
