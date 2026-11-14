import type { ConversionsReportResponse, LifecycleBrandSummary } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { resetAlertSession } from "../src/client/alerts-session";
import { api } from "../src/client/api";

// FUS-393: the งานรอทำ badge equals the rows of the page after a return to `/`, also when the data changed in between.

vi.mock("../src/client/screens/Money", () => ({ MoneyScreen: () => <h1>Money screen</h1> }));

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const HEALTHY = {
  generated_at: "2026-11-10T00:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, samples: [] } },
  reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, brands: [] } },
  click_risk: { state: "ok", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [] } },
};
const brand = (brand_id: string, status: string) => ({
  brand_id, name: brand_id, account: "acct", hostnames: [`${brand_id}.test`], status, current_revision_id: status === "draft" ? null : "rev-1",
  runtime_sync_status: status === "draft" ? "queued" : "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", latest_install: null,
} as unknown as LifecycleBrandSummary);
// Two dead sales: one ระบบ row.
const DEAD = {
  period: "30d", from: "2026-10-11T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z",
  totals: { pending: 0, processing: 0, uploaded: 0, dead: 2 }, value_totals: null, stalled: 0, rows: [], truncated: true,
} as ConversionsReportResponse;

let brands: LifecycleBrandSummary[];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  brands = [brand("cg", "live")];
  vi.spyOn(api, "me").mockResolvedValue(owner);
  vi.spyOn(api, "mePrefs").mockRejectedValue(new Error("unavailable"));
  // The server answers 1 both times: the second answer is older than the data the page reads on the return.
  vi.spyOn(api, "navCounts").mockResolvedValue({ brands_need_fix: 1, templates_awaiting: 0, alerts_open: 0, tasks_open: 1 });
  const replies: Record<string, () => unknown> = {
    "/api/alerts": () => HEALTHY,
    "/api/alerts/state": () => ({ rows: [], next_cursor: null }),
    "/api/lifecycle/brands": () => ({ brands }),
    "/api/brands": () => ({ brands: [{ brand_id: "cg", status: "live", hostnames: ["cg.test"] }], generated_at: "2026-11-10T00:00:00.000Z" }),
    "/api/brands/checklists": () => ({ brands: { cg: { checklist: [{ item: "drain_route", evidence: {} }, { item: "test_sold", evidence: {} }], template_approved: true, template_waiting_id: null } } }),
    "/api/templates": () => ({ templates: [], categories: [] }),
    "/api/conversions": () => DEAD,
    "/api/spend": () => ({ period: "today", from: "2026-11-10", to: "2026-11-10", totals: { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 }, brands: [], total_cost_usd: 0, fx: { thbPerUsd: 33 } }),
    "/api/funnel": () => ({ from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z", rows: [] }),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const reply = replies[new URL(input, "http://panel.test").pathname];
    if (!reply) throw new Error(`Unexpected test HTTP request: ${input}`);
    return json(reply());
  }));
});
afterEach(() => {
  cleanup();
  resetAlertSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const nav = () => screen.getByRole("navigation", { name: "เมนูหลัก" });
const rows = () => document.querySelectorAll(".task-row").length;

describe("งานรอทำ badge", () => {
  it("equals the rows after returning to / with new data", async () => {
    render(<App />);
    expect((await screen.findByLabelText("1 เรื่องรอทำ")).textContent).toBe("1");
    await waitFor(() => expect(rows()).toBe(1));
    fireEvent.click(within(nav()).getByRole("link", { name: /เงิน/ }));
    await screen.findByRole("heading", { name: "Money screen" });
    // A draft brand appears while the user is on another page: งานรอทำ now has a second row.
    brands = [brand("cg", "live"), brand("dr", "draft")];
    fireEvent.click(within(nav()).getByRole("link", { name: /งานรอทำ/ }));
    await waitFor(() => expect(rows()).toBe(2));
    // The return read the counts again, and the badge shows the rows on screen.
    await waitFor(() => expect(api.navCounts).toHaveBeenCalledTimes(2));
    expect((await screen.findByLabelText("2 เรื่องรอทำ")).textContent).toBe("2");
  });
});
