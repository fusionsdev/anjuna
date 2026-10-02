import { describe, expect, it } from "vitest";
import { BrandSettings, RUN_WORKER_FIRST } from "../src/index.js";
import { assignVariant } from "../src/assignment.js";
import wrangler from "../example/wrangler.jsonc?raw";
import { cfg, cookieHeader, HANDOFF, setup } from "./helpers.js";

describe("server weighted assignment", () => {
  it("10,000 independent visitors land within two percentage points of 30/70 and remain sticky", () => {
    const settings = BrandSettings.parse(setup({ ab_config: { experiment_id: "test1", variants: [{ id: "a", weight: 30 }, { id: "b", weight: 70 }] } }).config);
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) {
      const assignment = assignVariant(new Request("https://brand-a.example/"), settings);
      counts[assignment.variant]!++;
      expect(assignment.setCookie).toContain("Max-Age=2592000");
      expect(assignment.setCookie).not.toMatch(/domain=/i);
      const again = assignVariant(new Request("https://brand-a.example/request", { headers: { cookie: assignment.setCookie!.split(";")[0]! } }), settings);
      expect(again).toEqual({ experiment_id: "test1", variant: assignment.variant });
    }
    expect(counts.a! / 10_000).toBeGreaterThanOrEqual(0.28);
    expect(counts.a! / 10_000).toBeLessThanOrEqual(0.32);
    expect(counts.b! / 10_000).toBeGreaterThanOrEqual(0.68);
    expect(counts.b! / 10_000).toBeLessThanOrEqual(0.72);
  }, 30_000);
  it("keeps old visitors after weights change, assigns only new visitors to nonzero arms", async () => {
    const { get, config, core } = setup({ ab_config: { experiment_id: "test1", variants: [{ id: "a", weight: 100 }, { id: "b", weight: 0 }] } });
    const landing = await get("/?gclid=first");
    const cookie = cookieHeader(landing);
    expect(cookie).toContain("test1.a");
    expect(core.calls.recordClick[0]).toMatchObject({ experiment_id: "test1", variant: "a" });
    config.ab_config!.variants = [{ id: "a", weight: 0 }, { id: "b", weight: 100 }];
    expect((await cfg(await get(`/request?${HANDOFF}`, { headers: { cookie } }))).variant).toBe("a");
    expect((await cfg(await get(`/request?${HANDOFF}`))).variant).toBe("b");
    config.ab_config!.experiment_id = "test2";
    expect((await cfg(await get(`/request?${HANDOFF}`, { headers: { cookie } }))).variant).toBe("b");
  });
  it.each(["_ab=%invalid", "_ab=test1.unknown", "_ab=stale.a", "_ab=test1.a.extra"])("reassigns invalid cookie %s", async (cookie) => {
    const { get } = setup({ ab_config: { experiment_id: "test1", variants: [{ id: "a", weight: 0 }, { id: "b", weight: 100 }] } });
    expect((await cfg(await get(`/request?${HANDOFF}`, { headers: { cookie } }))).variant).toBe("b");
  });
  it.each([
    [{ id: "A", weight: 50 }, { id: "b", weight: 50 }],
    [{ id: "a", weight: 49 }, { id: "b", weight: 50 }],
    [{ id: "a", weight: 49.5 }, { id: "b", weight: 50.5 }],
    [{ id: "a", weight: -1 }, { id: "b", weight: 101 }],
    [{ id: "a", weight: 50 }, { id: "a", weight: 50 }],
    [{ id: "anjuna", weight: 50 }, { id: "b", weight: 50 }],
  ])("rejects invalid weights or identifiers %#", (...variants) => {
    expect(() => setup({ ab_config: { experiment_id: "test1", variants } })).toThrow();
  });
  it("example uses an array matching public static exclusions with an explicit uniform 404 asset", () => {
    const config = JSON.parse(wrangler);
    expect(config.compatibility_flags).toEqual(["global_fetch_strictly_public"]);
    expect(Array.isArray(config.assets.run_worker_first)).toBe(true);
    expect(config.assets.run_worker_first).toEqual(RUN_WORKER_FIRST);
    expect(config.assets.html_handling).toBe("none");
    expect(config.assets.not_found_handling).toBe("404-page");
  });
});
