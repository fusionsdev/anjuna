import alertsFixture from "@anjuna/contracts/fixtures/admin/alerts.response.json";
import type { PanelSpendReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_GROUPS, visibleTabs } from "../src/client/nav-groups";
import { AdAllocationScreen } from "../src/client/screens/AdAllocation";
import { AlertsScreen } from "../src/client/screens/Alerts";
import { ESTIMATED_TITLE, SpendText, brandMoney } from "../src/client/screens/BrandStatsRow";
import { BrandRows } from "../src/client/screens/home/BrandRows";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = "2026-11-08T10:00:00.000Z";

const lifecycleBrand = (brand_id: string, host: string) => ({
  brand_id, name: host, account: "acct", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01", latest_install: null,
});
const spendRow = (brand_id: string, cost: number, allocation?: "exact" | "estimated") => ({
  brand_id, currency: "THB" as const, cost, cost_usd: cost / 35, clicks: 10, impressions: 100, updated_at: "2026-11-08T09:30:00.000Z",
  ...(allocation ? { allocation } : {}),
});
const spendReport = (rows: PanelSpendReportResponse["brands"]): PanelSpendReportResponse => ({
  period: "7d", from: "2026-11-02", to: "2026-11-08", totals: { cost_by_currency: { THB: 0, USD: 0 }, clicks: 0, impressions: 0 },
  brands: rows, total_cost_usd: 0, fx: { thbPerUsd: 35 },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("estimated spend marks", () => {
  it("a Home brand row with an estimated spend shows ~ and the tooltip; an exact one shows neither", () => {
    render(<BrandRows
      role="owner"
      brands={[lifecycleBrand("petvetpay", "petvetpay.test"), lifecycleBrand("bisoncash", "bisoncash.test")] as never}
      checklists={null}
      paused={new Set()}
      funnel={{ from: "2026-11-02T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z", rows: [] } as never}
      spend={spendReport([spendRow("petvetpay", 750, "estimated"), spendRow("bisoncash", 250, "exact")])}
    />);
    const spendCell = (brand: string) => document.querySelector(`[data-brand-id="${brand}"] [data-col="spend"]`)!;
    expect(spendCell("petvetpay").textContent).toBe("~฿750");
    expect(within(spendCell("petvetpay") as HTMLElement).getByTitle(ESTIMATED_TITLE).textContent).toBe("~฿750");
    expect(spendCell("bisoncash").textContent).toBe("฿250");
    expect(spendCell("bisoncash").querySelector("[title]")).toBeNull();
  });

  it("the Brands table money marks a brand estimated only from an estimated row; a row without the field is exact", () => {
    const report = spendReport([spendRow("petvetpay", 750, "estimated"), spendRow("bisoncash", 250)]);
    expect(brandMoney("petvetpay", null, null, report)).toMatchObject({ spendText: "฿750", estimated: true });
    expect(brandMoney("bisoncash", null, null, report)).toMatchObject({ spendText: "฿250", estimated: false });
  });

  it("never marks an unknown number", () => {
    render(<p data-testid="cell"><SpendText text="—" estimated /></p>);
    expect(screen.getByTestId("cell").textContent).toBe("—");
    expect(screen.queryByTitle(ESTIMATED_TITLE)).toBeNull();
  });
});

describe("allocation tab", () => {
  it("is a Settings tab for the owner and is left out for an employee", () => {
    expect(visibleTabs(NAV_GROUPS.settings, "owner").map((t) => t.id)).toContain("ad-allocation");
    expect(visibleTabs(NAV_GROUPS.settings, "employee").map((t) => t.id)).not.toContain("ad-allocation");
  });

  it("lists the shared account and its campaigns, and assigning an unmapped campaign PATCHes and shows it as manual", async () => {
    let owner: { brand_id: string; source: "manual" } | null = null;
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/brands") return json({ brands: [] });
      if (input === "/api/lifecycle/brands") return json({ brands: [] });
      if (input !== "/api/ad-allocation") throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
      if (method === "PATCH") {
        const body = JSON.parse(init!.body as string) as { brand_id: string };
        sent.push(body);
        owner = { brand_id: body.brand_id, source: "manual" };
        return json({ ...body, source: "manual", updated_at: NOW });
      }
      return json({
        mode: "estimated", from: "2026-11-02", to: "2026-11-08",
        accounts: [{ account: "5381163935", brands: ["bisoncash", "petvetpay"], cost_by_currency: { THB: 1000, USD: 0 }, unmapped_cost_by_currency: { THB: owner ? 0 : 300, USD: 0 } }],
        campaigns: [
          { account: "5381163935", campaign_id: "222", currency: "THB", cost: 300, clicks: 12, brand_id: owner?.brand_id ?? null, source: owner?.source ?? null },
          { account: "5381163935", campaign_id: "111", currency: "THB", cost: 700, clicks: 30, brand_id: "petvetpay", source: "click" },
        ],
        unallocated_by_currency: { THB: 0, USD: 0 },
      });
    }));
    render(<AdAllocationScreen />);
    const accounts = within(await screen.findByRole("table", { name: "บัญชีที่ใช้ร่วมกัน" }));
    expect(accounts.getByText("538-116-3935")).toBeTruthy();
    expect(accounts.getByText("30%")).toBeTruthy();
    expect(screen.getByText(/ประมาณจากสัดส่วนคลิก:/)).toBeTruthy();
    const campaigns = within(screen.getByRole("table", { name: "แคมเปญ" }));
    expect(campaigns.getByText("ยังไม่จัดสรร")).toBeTruthy();
    expect(campaigns.getByText("จากคลิก")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "แบรนด์ของแคมเปญ 222" }), { target: { value: "bisoncash" } });
    await waitFor(() => expect(campaigns.getByText("กำหนดเอง")).toBeTruthy());
    expect(sent).toEqual([{ account: "5381163935", campaign_id: "222", brand_id: "bisoncash" }]);
    expect((screen.getByRole("combobox", { name: "แบรนด์ของแคมเปญ 222" }) as HTMLSelectElement).value).toBe("bisoncash");
    expect(campaigns.queryByText("ยังไม่จัดสรร")).toBeNull();
  });

  it("shows the Thai error and a retry when the read fails (an employee gets 403 from the server)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/ad-allocation") return json({ error: "forbidden_role", required_role: "owner", request_id: "r" }, 403);
      return json({ brands: [] });
    }));
    render(<AdAllocationScreen />);
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(screen.getByRole("button", { name: "ลองอีกครั้ง" })).toBeTruthy();
  });
});

describe("alert row ค่าโฆษณายังไม่จัดสรร", () => {
  it("lists each account above the threshold with its unmapped share", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/alerts") return json({ ...alertsFixture, ad_spend_unallocated: {
        state: "alert", detail: { window_days: 7, alert_at: 0.2, accounts: [{ account: "5381163935", currency: "THB", share: 0.21 }] },
      } });
      return json({ brands: [] });
    }));
    render(<AlertsScreen />);
    expect(await screen.findByText("ค่าโฆษณายังไม่จัดสรร")).toBeTruthy();
    expect(screen.getByText("1 บัญชีมีแคมเปญที่ยังไม่จัดสรรเกิน 20% ของค่าโฆษณา 7 วัน")).toBeTruthy();
    expect(screen.getByText(/บัญชี 538-116-3935 · THB · ยังไม่จัดสรร 21%/)).toBeTruthy();
  });
});
