import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelSpendReportResponse } from "@anjuna/contracts";
import type { ChecklistStep } from "../src/client/api";
import { LifecycleDetail, checklistFix } from "../src/client/screens/BrandLifecycle";
import { brandSpendFresh } from "../src/client/home-metrics";

afterEach(cleanup);

const owner = { id: "o", email: "o@example.test", role: "owner" as const };
const employee = { id: "e", email: "e@example.test", role: "employee" as const };
const brand = { brand_id: "brand-a", account: "account-a", hostnames: ["brand-a.example"], status: "live" as const, current_revision_id: "rev-1", runtime_sync_status: "ready" as const, bundle_form_version: "form@bundle-1", payload_version: "2026-01" };
const done = (...items: ChecklistStep["item"][]): ChecklistStep[] => items.map((item) => ({ item, done: true, evidence: "system · 2026-11-07T00:00:00Z" }));

function detail(over: Partial<Parameters<typeof LifecycleDetail>[0]> = {}) {
  return <LifecycleDetail me={owner} brand={brand} onInstall={() => {}} onRollback={() => {}} onRedeploy={() => {}} onRetry={() => {}} onRecover={() => {}} {...over} />;
}
const ADKIT = { periodLabel: "7 วัน", spendText: "฿3,500", profitText: "$120", leadsText: "40", failedText: "2", updatedText: "10 พ.ย. 09:00" };
const step = (item: string) => screen.getByText(new RegExp(`\(${item}\)`)).closest(".check-row") as HTMLElement;

describe("brand checklist fix buttons", () => {
  it("a failing step shows its fix button inside the step and runs the action for that item", () => {
    const onFix = vi.fn();
    render(detail({ onFix, install: { install_id: "inst-1", status: "failed", receipts: [], runtime_sync_status: "ready" } as never }));
    fireEvent.click(within(step("test_sold")).getByRole("button", { name: "ยืนยันการทดสอบการขาย" }));
    fireEvent.click(within(step("drain_route")).getByRole("button", { name: "ตั้งเส้นทางส่งยอดขาย" }));
    fireEvent.click(within(step("final_url")).getByRole("button", { name: "ลองติดตั้งใหม่" }));
    expect(onFix.mock.calls.map(([item]) => item)).toEqual(["test_sold", "drain_route", "final_url"]);
  });

  it("a passing step shows no fix button", () => {
    render(detail({ onFix: () => {}, install: { install_id: "inst-1", status: "failed", receipts: [], runtime_sync_status: "ready" } as never, steps: done("test_sold", "drain_route", "final_url") }));
    for (const item of ["test_sold", "drain_route", "final_url"]) expect(within(step(item)).queryByRole("button")).toBeNull();
  });

  it("leadsgate_postbacks has no fix button, only its automatic note", () => {
    render(detail({ onFix: () => {} }));
    expect(within(step("leadsgate_postbacks")).queryByRole("button")).toBeNull();
  });

  it("final_url offers the retry only when the install failed", () => {
    render(detail({ onFix: () => {}, install: { install_id: "inst-1", status: "ready", receipts: [], runtime_sync_status: "ready" } as never }));
    expect(within(step("final_url")).queryByRole("button")).toBeNull();
  });

  it("an employee sees the drain_route fix disabled with a Thai reason", () => {
    render(detail({ me: employee, onFix: () => {} }));
    const button = within(step("drain_route")).getByRole("button", { name: "ตั้งเส้นทางส่งยอดขาย" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("เฉพาะเจ้าของตั้งเส้นทางได้");
  });

  it("test_sold has no inline lead_id field once the fix button exists", () => {
    render(detail({ onFix: () => {} }));
    expect(screen.queryByLabelText("lead_id")).toBeNull();
  });

  it("checklistFix maps each item", () => {
    expect(checklistFix("leadsgate_postbacks", { owner: true, installFailed: true })).toBeNull();
    expect(checklistFix("final_url", { owner: true, installFailed: false })).toBeNull();
    expect(checklistFix("final_url", { owner: false, installFailed: true })?.action).toBe("retry-install");
    expect(checklistFix("test_sold", { owner: false, installFailed: false })?.action).toBe("test-sold");
    expect(checklistFix("drain_route", { owner: false, installFailed: false })?.reason).toBe("เฉพาะเจ้าของตั้งเส้นทางได้");
  });
});

describe("AdKit block on the brand", () => {
  it("shows baht spend and USD profit", () => {
    render(detail({ adkit: ADKIT }));
    const block = screen.getByRole("region", { name: "ตัวเลขโฆษณา" });
    expect(block.textContent).toContain("฿3,500");
    expect(block.textContent).toContain("$120");
  });

  it("shows no block for an employee even when the numbers are passed in", () => {
    render(detail({ me: employee, adkit: ADKIT }));
    expect(screen.queryByRole("region", { name: "ตัวเลขโฆษณา" })).toBeNull();
  });
});

describe("brandSpendFresh", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");
  const report = (rows: Array<{ currency: "THB" | "USD"; updated_at: string }>) => ({
    brands: rows.map((row) => ({ brand_id: "brand-a", cost: 1, clicks: 1, impressions: 1, cost_usd: 1, ...row })),
  }) as unknown as PanelSpendReportResponse;

  it("is false without a report or without rows for the brand", () => {
    expect(brandSpendFresh(null, "brand-a", now)).toBe(false);
    expect(brandSpendFresh(report([]), "brand-a", now)).toBe(false);
  });
  it("is true when every row is under 2 hours old", () => {
    expect(brandSpendFresh(report([{ currency: "THB", updated_at: "2026-11-07T11:00:00.000Z" }]), "brand-a", now)).toBe(true);
  });
  it("is false when every row is older than 2 hours", () => {
    expect(brandSpendFresh(report([{ currency: "THB", updated_at: "2026-11-07T09:00:00.000Z" }, { currency: "USD", updated_at: "2026-11-07T08:00:00.000Z" }]), "brand-a", now)).toBe(false);
  });
  it("is false when one currency row is stale, so no number mixes fresh and old data", () => {
    expect(brandSpendFresh(report([{ currency: "THB", updated_at: "2026-11-07T11:30:00.000Z" }, { currency: "USD", updated_at: "2026-11-07T08:00:00.000Z" }]), "brand-a", now)).toBe(false);
  });
});

describe("brand detail panel layout", () => {
  it("draws the four checklist steps as cards with an icon each, finished ones marked", () => {
    render(detail({ steps: done("drain_route") }));
    const cards = [...document.querySelectorAll(".check-grid .check-row")];
    expect(cards).toHaveLength(4);
    expect(cards.every((card) => card.querySelector("svg.check-icon"))).toBe(true);
    expect(step("drain_route").className).toContain("done");
    expect(step("test_sold").className).not.toContain("done");
  });

  it("puts the checklist cards above the action buttons", () => {
    render(detail());
    const cards = document.querySelector(".check-grid")!;
    const actions = document.querySelector(".side-actions")!;
    expect(Boolean(cards.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("keeps the installation section collapsed for a finished install and open for a failed one", () => {
    const install = { install_id: "i-1", brand_id: "brand-a", operation: "install", status: "ready", runtime_sync_status: "ready", revision_id: "rev-1", started_at: "2026-11-01T00:00:00.000Z", finished_at: "2026-11-01T00:01:00.000Z", started_by: "owner", error: null, recovery_required: false, steps: [], receipts: [] } as never;
    const view = render(detail({ install }));
    expect(document.querySelector<HTMLDetailsElement>("details.install-details")!.open).toBe(false);
    expect(within(document.querySelector("details.install-details")!).getByText("การติดตั้ง")).toBeTruthy();
    view.unmount();
    render(detail({ install: { ...(install as object), status: "failed" } as never }));
    expect(document.querySelector<HTMLDetailsElement>("details.install-details")!.open).toBe(true);
  });
});
