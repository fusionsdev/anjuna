import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemorySubmitErrorCounts, runAlerts } from "@anjuna/insights";
import { createHarness, ROOT, type Harness } from "./helpers.js";

describe("cron wiring (no Miniflare)", () => {
  it("wrangler.jsonc declares the mailing and alerts cron triggers", () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, "workers/core/wrangler.jsonc"), "utf8")
        .replace(/^\s*\/\/.*$/gm, ""),
    );
    expect(config.triggers?.crons).toEqual(
      expect.arrayContaining(["*/5 * * * *", "0 * * * *"]),
    );
  });
});

describe("insights alerts on D1 (Miniflare — run in WSL)", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  beforeEach(async () => { await h.reset(); });
  afterAll(async () => { await h?.mf.dispose(); });

  it("all four alerts are ok with no data", async () => {
    const now = new Date().toISOString();
    const report = await runAlerts(
      h.db as unknown as D1Database,
      { submitErrorCounts: new InMemorySubmitErrorCounts([]) },
      { now },
    );
    expect(report.generated_at).toBe(now);
    expect(report.conversion_stalled.state).toBe("ok");
    expect(report.brands_without_postbacks.state).toBe("ok");
    expect(report.submit_error_rate.state).toBe("ok");
    expect(report.reject_rate.state).toBe("ok");
  });

  it("conversion_stalled alerts when a pending row is older than 6 hours", async () => {
    const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
    await h.seedLead("lead-stale");
    await h.seedConversion("lead-stale", { status: "pending", created_at: old });
    const now = new Date().toISOString();
    const report = await runAlerts(
      h.db as unknown as D1Database,
      { submitErrorCounts: new InMemorySubmitErrorCounts([]) },
      { now },
    );
    expect(report.conversion_stalled.state).toBe("alert");
    expect(report.conversion_stalled.detail.stuck_count).toBe(1);
  });
});
