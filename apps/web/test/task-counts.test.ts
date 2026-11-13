import { LifecycleBrandSummary } from "@anjuna/contracts";
import { describe, expect, it } from "vitest";
import { brandHealth } from "../src/client/brand-health";
import { DEFAULT_SCOPE } from "../src/client/brand-scope";
import { awaitingApproval, isDraft, listedInBrands, matchesListChip, needsDrainRoute, needsTestSold, scopeTest } from "../src/client/task-counts";
import { hostnameBrand, isOpenIncident, openAlertCount } from "../src/client/alert-incidents";
import alertsFixture from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { AlertsReportResponse } from "@anjuna/contracts";

const brand = (extra: Record<string, unknown> = {}) => LifecycleBrandSummary.parse({
  brand_id: "b1", name: "Lender", account: "a", hostnames: ["lender.test"], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", ...extra,
});
const entry = (...items: string[]) => ({ checklist: items.map((item) => ({ item })) });

describe("task predicates", () => {
  it("needsTestSold: a live, non-demo brand whose checklist lacks test_sold", () => {
    expect(needsTestSold(brand(), entry("drain_route"))).toBe(true);
    expect(needsTestSold(brand(), entry("test_sold"))).toBe(false);
    expect(needsTestSold(brand({ status: "draft" }), entry())).toBe(false);
    expect(needsTestSold(brand({ name: "demo07" }), entry())).toBe(false);
    // An unknown or missing checklist never counts.
    expect(needsTestSold(brand(), undefined)).toBe(false);
    expect(needsTestSold(brand(), { ...entry(), unknown: true })).toBe(false);
  });

  it("needsDrainRoute: a live, non-demo brand whose checklist lacks drain_route", () => {
    expect(needsDrainRoute(brand(), entry("test_sold"))).toBe(true);
    expect(needsDrainRoute(brand(), entry("drain_route"))).toBe(false);
    expect(needsDrainRoute(brand({ name: "demo1" }), entry())).toBe(false);
    expect(needsDrainRoute(brand(), undefined)).toBe(false);
  });

  it("isDraft and awaitingApproval", () => {
    expect(isDraft(brand({ status: "draft" }))).toBe(true);
    expect(isDraft(brand())).toBe(false);
    expect(awaitingApproval({ status: "awaiting_approval", archived: false })).toBe(true);
    expect(awaitingApproval({ status: "awaiting_approval", archived: true })).toBe(false);
    expect(awaitingApproval({ status: "approved", archived: false })).toBe(false);
  });

  it("listedInBrands applies the brand ticks, the demo box and hideInactive", () => {
    expect(listedInBrands(DEFAULT_SCOPE, brand(), "live")).toBe(true);
    expect(listedInBrands(DEFAULT_SCOPE, brand(), "paused")).toBe(false);
    expect(listedInBrands(DEFAULT_SCOPE, brand(), "paused", false)).toBe(true);
    expect(listedInBrands(DEFAULT_SCOPE, brand({ name: "demo2" }), undefined)).toBe(false);
    expect(listedInBrands({ ...DEFAULT_SCOPE, showDemo: true }, brand({ name: "demo2" }), undefined)).toBe(true);
    expect(listedInBrands({ ...DEFAULT_SCOPE, brandIds: ["other"] }, brand(), undefined)).toBe(false);
  });

  it("matchesListChip sends task chips to the predicates and the rest to brand health", () => {
    const live = brand();
    const health = brandHealth(live, { status: "live" });
    expect(matchesListChip("test-sold", health, live, entry())).toBe(true);
    expect(matchesListChip("drain-route", health, live, entry("drain_route"))).toBe(false);
    expect(matchesListChip("drafts", health, live, entry())).toBe(false);
    expect(matchesListChip("live", health, live, undefined)).toBe(true);
  });

  it("scopeTest follows the full scope for a listed brand and the ticks for an unknown id", () => {
    const test = scopeTest({ ...DEFAULT_SCOPE, brandIds: ["b1", "ghost"] }, [brand()], () => "paused");
    expect(test("b1")).toBe(false);
    expect(test("ghost")).toBe(true);
    expect(test("nobody")).toBe(false);
  });
});

describe("open alert count", () => {
  const report = alertsFixture as unknown as AlertsReportResponse;
  it("counts acknowledged incidents as open and drops closed ones", () => {
    const withReject: AlertsReportResponse = { ...report, reject_rate: { state: "alert", detail: { ...report.reject_rate.detail, brands: [{ brand: "b1", rejected: 5, decided: 10, rate: 0.5 }] } } } as AlertsReportResponse;
    const none = new Map<string, { closed_at: string | null }>();
    const base = openAlertCount(withReject, none, () => null);
    expect(openAlertCount(withReject, new Map([["reject_rate:b1", { closed_at: null }]]), () => null)).toBe(base);
    expect(openAlertCount(withReject, new Map([["reject_rate:b1", { closed_at: "2026-11-13T00:00:00.000Z" }]]), () => null)).toBe(base - 1);
    expect(isOpenIncident({ id: "x", rule: "click_risk", level: "ok", key: null, brand: null, detail: "" }, none)).toBe(false);
  });

  it("maps a hostname to its brand ignoring case and www", () => {
    expect(hostnameBrand(new Map([["b1", "lender.test"]]))("WWW.Lender.test")).toBe("b1");
    expect(hostnameBrand(new Map([["b1", "lender.test"]]))("other.test")).toBeNull();
  });
});
