/**
 * Provenance checks against real checkouts of the port sources. Skipped unless the paths are
 * given, because CI does not clone them:
 *   V1_DIR=/tmp/v1 FORM_DIR=/tmp/form bun run test
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORM_TRACKING_KEYS, PENDING_ROW_KEYS, V1_AMOUNT_BUCKETS } from "../src/index.js";
import { PKG_DIR } from "./helpers.js";

const V1_DIR = process.env.V1_DIR;
const FORM_DIR = process.env.FORM_DIR;
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe.skipIf(!V1_DIR)("V1 core source (V1_DIR)", () => {
  const api = () => lf(readFileSync(join(V1_DIR!, "functions", "api", "[[path]].ts"), "utf8"));

  it("vendored drain.mjs equals V1 drain/drain.mjs", () => {
    const vendored = readFileSync(join(PKG_DIR, "test", "v1", "drain.mjs"), "utf8");
    expect(vendored).toBe(lf(readFileSync(join(V1_DIR!, "drain", "drain.mjs"), "utf8")));
  });

  it("validate-lead.v1.ts excerpt ranges are verbatim", () => {
    const lines = api().split("\n");
    const excerpt = readFileSync(join(PKG_DIR, "test", "v1", "validate-lead.v1.ts"), "utf8");
    const ranges = [[98, 103], [118, 124], [145, 158], [1044, 1088], [1187, 1384], [1431, 1444], [1501, 1548]];
    const expected = ranges.map(([a, b]) => lines.slice(a! - 1, b).join("\n")).join("\n");
    expect(excerpt).toContain(expected);
  });

  it("pending RETURNING and peek SELECT columns = PENDING_ROW_KEYS minus brand/hostname", () => {
    const src = api();
    // The claim UPDATE's RETURNING list (the click-session claim has its own, starting with gclid).
    const returning = /RETURNING (lead_id, [a-z_, ]+)\n/.exec(src)![1]!.split(",").map((s) => s.trim());
    expect([...returning, "brand", "hostname"]).toEqual([...PENDING_ROW_KEYS]);
    const peek = /SELECT (cu\.lead_id[\s\S]*?)\n\s*FROM conversion_uploads cu/.exec(src)![1]!
      .split(",").map((s) => s.trim().replace(/^(cu|l)\./, ""));
    expect(peek).toEqual([...PENDING_ROW_KEYS]);
  });
});

describe.skipIf(!FORM_DIR)("form source (FORM_DIR)", () => {
  const app = () => lf(readFileSync(join(FORM_DIR!, "src", "App.tsx"), "utf8"));

  it("TRACKING_KEYS match", () => {
    const block = /const TRACKING_KEYS = \[([\s\S]*?)\];/.exec(app())![1]!;
    expect([...block.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1])).toEqual([...FORM_TRACKING_KEYS]);
  });

  it("REQUESTED_AMOUNT_BUCKETS match", () => {
    const block = /REQUESTED_AMOUNT_BUCKETS = new Set\(\[([^\]]*)\]/.exec(app())![1]!;
    expect(block.split(",").map((s) => Number(s.trim()))).toEqual([...V1_AMOUNT_BUCKETS]);
  });
});
