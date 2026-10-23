import { LifecycleBrandSummary } from "@anjuna/contracts";
import { describe, expect, it } from "vitest";
import { BRAND_CHIPS, BRAND_SORTS, brandHealth, matchesBrandChip, matchesBrandSearch, sortBrands, sortWorstProfitFirst, type BrandChip, type BrandHealth } from "../src/client/brand-health";
import { finalUrl, siteUrl } from "../src/client/final-url";

const brand = (over: Partial<LifecycleBrandSummary> = {}) => LifecycleBrandSummary.parse({
  brand_id: "brand-a", account: "acc", hostnames: ["a.test", "www.a.test"], status: "live",
  current_revision_id: "r1", runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...over,
});

const install = (status: "queued" | "running" | "ready" | "failed" | "rolled_back", startedAt = "2026-10-20T00:00:00.000Z") => ({
  install_id: "i", operation: "install" as const, status, started_at: startedAt, finished_at: null, started_by: "o",
});

describe("brandHealth", () => {
  it("has no issue for a live, synced, installed brand", () => { expect(brandHealth(brand(), { status: "live" }).issues).toEqual([]); });
  it("flags a failed factory status and a failed latest install", () => {
    expect(brandHealth(brand({ status: "failed" }), undefined).issues).toContain("install_failed");
    expect(brandHealth(brand({ latest_install: { install_id: "i", operation: "redeploy", status: "rolled_back", started_at: "2026-10-20T00:00:00.000Z", finished_at: null, started_by: "o" } }), { status: "live" }).issues).toContain("install_failed");
  });
  it("flags sync_error only while the factory status is live", () => {
    expect(brandHealth(brand({ runtime_sync_status: "sync_error" }), { status: "live" }).issues).toContain("sync_error");
    expect(brandHealth(brand({ status: "draft", current_revision_id: null, runtime_sync_status: "sync_error" }), undefined).issues).not.toContain("sync_error");
  });
  it("flags install_running from the factory status and from a queued install", () => {
    expect(brandHealth(brand({ status: "installing" }), undefined).issues).toContain("install_running");
    expect(brandHealth(brand({ latest_install: install("queued") }), { status: "live" }).issues).toContain("install_running");
    expect(brandHealth(brand({ latest_install: install("running") }), { status: "live" }).issues).toContain("install_running");
  });
  it("flags no_domain when the brand has never installed", () => {
    expect(brandHealth(brand({ status: "draft", current_revision_id: null, runtime_sync_status: "queued" }), undefined).issues).toContain("no_domain");
  });
  it("does not flag no_domain for a core-only brand, which has no factory revision but is served by core", () => {
    const health = brandHealth(brand({ status: "unmanaged", current_revision_id: null, bundle_form_version: null, payload_version: null }), { status: "live" });
    expect(health.issues).not.toContain("no_domain");
    expect(health.issues).toEqual([]);
    expect(health.severity).toBe(99);
  });
  it("raises sync_error for a live brand, and not while the core list failed", () => {
    const row = brand({ runtime_sync_status: "sync_error" });
    expect(brandHealth(row, { status: "live" }).issues).toContain("sync_error");
    expect(brandHealth(row, { status: "live" }, { coreListFailed: false }).issues).toContain("sync_error");
    expect(brandHealth(row, { status: "live" }, { coreListFailed: true }).issues).not.toContain("sync_error");
    expect(brandHealth(row, { status: "live" }, { coreListFailed: true }).severity).toBe(99);
  });
  it("flags paused from the core runtime row and from the factory status", () => {
    expect(brandHealth(brand(), { status: "paused" }).issues).toContain("paused");
    expect(brandHealth(brand({ status: "paused" }), undefined).issues).toContain("paused");
  });
  it("reads severity as the worst issue and activityAt from the latest install", () => {
    const health = brandHealth(brand({ status: "failed", latest_install: { install_id: "i", operation: "install", status: "failed", started_at: "2026-10-20T00:00:00.000Z", finished_at: null, started_by: "o" } }), { status: "paused" });
    expect(health.issues[0]).toBe("install_failed");
    expect(health.severity).toBe(0);
    expect(health.activityAt).toBe("2026-10-20T00:00:00.000Z");
  });
  it("pins the severity index of every issue", () => {
    const cases = [
      ["install_failed", 0, brandHealth(brand({ status: "failed" }), { status: "live" })],
      ["sync_error", 1, brandHealth(brand({ runtime_sync_status: "sync_error" }), { status: "live" })],
      ["install_running", 2, brandHealth(brand({ status: "installing" }), { status: "live" })],
      ["no_domain", 3, brandHealth(brand({ status: "draft", current_revision_id: null, runtime_sync_status: "queued" }), undefined)],
      ["paused", 4, brandHealth(brand(), { status: "paused" })],
    ] as const;
    for (const [issue, severity, health] of cases) {
      expect(health.issues).toEqual([issue]);
      expect(health.severity).toBe(severity);
    }
  });
  it("reads severity 99 and a null activityAt for a healthy brand with no install row", () => {
    const health = brandHealth(brand({ latest_install: null }), { status: "live" });
    expect(health.severity).toBe(99);
    expect(health.activityAt).toBeNull();
  });
});

describe("matchesBrandChip", () => {
  it("counts a healthy live brand under live and not under failed", () => {
    const row = brand();
    const health = brandHealth(row, { status: "live" });
    const hits = (chip: BrandChip) => matchesBrandChip(health, row, chip);
    expect(hits("all")).toBe(true);
    expect(hits("live")).toBe(true);
    expect(hits("paused")).toBe(false);
    expect(hits("failed")).toBe(false);
    expect(hits("no_domain")).toBe(false);
  });
  it("puts a paused brand under paused and not under live", () => {
    const row = brand();
    const health = brandHealth(row, { status: "paused" });
    expect(matchesBrandChip(health, row, "paused")).toBe(true);
    expect(matchesBrandChip(health, row, "live")).toBe(false);
  });
  it("puts a failed brand under failed and not under live", () => {
    const row = brand({ status: "failed" });
    const health = brandHealth(row, { status: "live" });
    expect(matchesBrandChip(health, row, "failed")).toBe(true);
    expect(matchesBrandChip(health, row, "live")).toBe(false);
  });
  it("puts a brand that never installed under no_domain", () => {
    const row = brand({ status: "draft", current_revision_id: null, runtime_sync_status: "queued" });
    const health = brandHealth(row, undefined);
    expect(matchesBrandChip(health, row, "no_domain")).toBe(true);
    expect(matchesBrandChip(health, row, "failed")).toBe(false);
  });
  it("keeps a core-only brand out of no_domain and out of live", () => {
    const row = brand({ status: "unmanaged", current_revision_id: null });
    const health = brandHealth(row, { status: "live" });
    expect(matchesBrandChip(health, row, "no_domain")).toBe(false);
    expect(matchesBrandChip(health, row, "live")).toBe(false);
    expect(matchesBrandChip(health, row, "all")).toBe(true);
  });
  it("lists every chip and sort, with profit the only owner-only sort", () => {
    expect(BRAND_CHIPS.map((chip) => chip.id)).toEqual(["all", "live", "paused", "failed", "no_domain"]);
    expect(BRAND_SORTS.filter((sort) => sort.ownerOnly).map((sort) => sort.id)).toEqual(["profit"]);
  });
});

describe("matchesBrandSearch", () => {
  it("matches a hostname, the name and the id, case-insensitively", () => {
    expect(matchesBrandSearch(brand({ name: "Credit Genie" }), "A.TEST")).toBe(true);
    expect(matchesBrandSearch(brand({ name: "Credit Genie" }), "genie")).toBe(true);
    expect(matchesBrandSearch(brand(), "BRAND-a")).toBe(true);
    expect(matchesBrandSearch(brand(), "floatme")).toBe(false);
  });
  it("matches everything for a blank or whitespace query", () => { expect(matchesBrandSearch(brand(), "   ")).toBe(true); });
});

describe("sortBrands", () => {
  interface Row { id: string; domain: string; severity: number; activityAt: string | null; profit: number | null }
  const row = (id: string, domain: string, severity: number, activityAt: string | null, profit: number | null = null): Row => ({ id, domain, severity, activityAt, profit });
  const read = (r: Row): { health: BrandHealth; domain: string; profit: number | null } => ({
    health: { issues: [], severity: r.severity, activityAt: r.activityAt },
    domain: r.domain,
    profit: r.profit,
  });
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  it("issues puts the worst severity first, then the newest activity, then the domain", () => {
    const rows = [
      row("healthy", "a.test", 99, "2026-10-22T00:00:00.000Z"),
      row("old-fail", "b.test", 0, "2026-10-01T00:00:00.000Z"),
      row("new-fail", "z.test", 0, "2026-10-20T00:00:00.000Z"),
      row("tie-fail", "c.test", 0, "2026-10-20T00:00:00.000Z"),
    ];
    expect(ids(sortBrands(rows, "issues", read))).toEqual(["tie-fail", "new-fail", "old-fail", "healthy"]);
  });
  it("issues orders every severity level ahead of the next, whatever the activity", () => {
    // Newest activity belongs to the least severe row, so only severity can produce this order.
    const rows = [
      row("healthy", "a.test", 99, "2026-10-25T00:00:00.000Z"),
      row("paused", "b.test", 4, "2026-10-24T00:00:00.000Z"),
      row("no-domain", "c.test", 3, "2026-10-23T00:00:00.000Z"),
      row("running", "d.test", 2, "2026-10-22T00:00:00.000Z"),
      row("sync", "e.test", 1, "2026-10-21T00:00:00.000Z"),
      row("failed", "f.test", 0, "2026-10-20T00:00:00.000Z"),
    ];
    expect(ids(sortBrands(rows, "issues", read))).toEqual(["failed", "sync", "running", "no-domain", "paused", "healthy"]);
  });
  it("activity puts a null activityAt last", () => {
    const rows = [row("none", "a.test", 99, null), row("old", "b.test", 99, "2026-10-01T00:00:00.000Z"), row("new", "c.test", 99, "2026-10-20T00:00:00.000Z")];
    expect(ids(sortBrands(rows, "activity", read))).toEqual(["new", "old", "none"]);
  });
  it("az sorts by the apex hostname", () => {
    const rows = [row("c", "c.test", 99, null), row("a", "a.test", 99, null), row("b", "b.test", 99, null)];
    expect(ids(sortBrands(rows, "az", read))).toEqual(["a", "b", "c"]);
  });
  it("profit matches sortWorstProfitFirst, nulls last", () => {
    const rows = [row("gain", "a.test", 99, null, 50), row("none", "b.test", 99, null, null), row("loss", "c.test", 99, null, -20)];
    const sorted = sortBrands(rows, "profit", read);
    expect(ids(sorted)).toEqual(["loss", "gain", "none"]);
    expect(ids(sorted)).toEqual(ids(sortWorstProfitFirst(rows, (r) => r.profit)));
  });
  it("does not mutate its input", () => {
    const rows = [row("c", "c.test", 99, null), row("a", "a.test", 99, null), row("b", "b.test", 99, null)];
    for (const mode of ["issues", "activity", "az", "profit"] as const) {
      sortBrands(rows, mode, read);
      expect(ids(rows)).toEqual(["c", "a", "b"]);
    }
  });
});

describe("finalUrl and siteUrl", () => {
  it("builds the keyword URL from the apex hostname", () => {
    expect(finalUrl(["a.test", "www.a.test"])).toBe("https://a.test/?keyword={keyword}");
    expect(siteUrl(["a.test", "www.a.test"])).toBe("https://a.test");
  });
  it("answers null with no hostname", () => { expect(finalUrl([])).toBeNull(); expect(siteUrl([])).toBeNull(); });
  it("uses the first hostname even when core returns a www host first", () => {
    // A core-only brand's hostnames are whatever core returned.
    expect(finalUrl(["www.b.test"])).toBe("https://www.b.test/?keyword={keyword}");
  });
});
