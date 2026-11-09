import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { api } from "../src/client/api";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { brandMoney, periodWindow, sortWorstProfitFirst, type SpendReport } from "../src/client/screens/BrandStatsRow";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { ...owner, id: "employee", role: "employee" as const };

const lifecycle = (id: string, name: string, host: string) => LifecycleBrandSummary.parse({
  brand_id: id, name, account: "test-account", hostnames: [host], status: "live", current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
// API order: Credit Genie, FloatMe, Alpha Loans, Wizard Demo. All four are healthy, so the default issues-first sort falls back to domain A-Z: Alpha Loans, Credit Genie, FloatMe, Wizard Demo.
const lifecycleRows = [
  lifecycle("brand-cg", "Credit Genie", "creditsgene.test"),
  lifecycle("brand-fm", "FloatMe", "floatsme.test"),
  lifecycle("brand-al", "Alpha Loans", "alpha.test"),
  lifecycle("brand-wd", "Wizard Demo", "wizard.test"),
];
const runtimeRow = (id: string) => ({
  brand_id: id, hostnames: [`${id}.test`], status: "live", flow_gate_mode: "param", ab_config: null, form_version: null,
  stats_7d: { leads: 9, sold: 3, pending: 2 },
});
const funnelRow = (brand: string, clicks: number, submits: number, revenue: number) => ({
  brand, keyword: null, variant: null, clicks, go_count: 0, form_views: 0, submits, sold: 0, revenue, submit_rate: null, sold_rate: null,
});
// `usd` dollars of spend, billed in baht at 35 THB per USD: the server sends cost in THB and cost_usd.
const cost = (brand_id: string, usd: number) => ({ brand_id, currency: "THB" as const, cost: usd * 35, cost_usd: usd, clicks: 1, impressions: 1, updated_at: "2026-10-06T00:00:00.000Z" });

// Per period: [funnel rows, spend rows]. Wizard Demo has funnel numbers but no spend row, so its profit is unknown.
const DATA: Record<string, { funnel: ReturnType<typeof funnelRow>[]; spend: ReturnType<typeof cost>[] }> = {
  "7d": {
    funnel: [funnelRow("brand-cg", 212, 10, 254), funnelRow("brand-fm", 96, 0, 0), funnelRow("brand-al", 50, 5, 400), funnelRow("brand-wd", 40, 4, 300)],
    spend: [cost("brand-cg", 800), cost("brand-fm", 620), cost("brand-al", 100)],
  },
  today: {
    funnel: [funnelRow("brand-cg", 20, 2, 500), funnelRow("brand-fm", 9, 0, 0), funnelRow("brand-al", 5, 1, 60)],
    spend: [cost("brand-cg", 90), cost("brand-fm", 60), cost("brand-al", 10)],
  },
};

type Handler = (init?: RequestInit) => Response | Promise<Response>;
type SpendFn = (period: string) => Promise<unknown>;
const apiWithSpend = api as unknown as { spend?: SpendFn };
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string }>;
let spend: ReturnType<typeof vi.fn>;
let originalSpend: SpendFn | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const spendReport = (period: string) => {
  const { spend: rows } = DATA[period] ?? DATA["7d"]!;
  return {
    period, from: "2026-10-01", to: "2026-10-07", totals: { cost_by_currency: { THB: rows.reduce((sum, row) => sum + row.cost, 0), USD: 0 }, clicks: 0, impressions: 0 }, brands: rows,
    total_cost_usd: rows.reduce((sum, row) => sum + row.cost_usd, 0), fx: { thbPerUsd: 35 },
  };
};

beforeEach(() => {
  requests = [];
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    ["GET /api/lifecycle/brands", () => json({ brands: lifecycleRows })],
    ["GET /api/brands", () => json({ brands: lifecycleRows.map((row) => runtimeRow(row.brand_id)), generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/funnel", () => json({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", rows: DATA["7d"]!.funnel })],
  ]);
  for (const row of lifecycleRows) {
    routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
    routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
    routes.set(`GET /api/brands/${row.brand_id}/revisions`, () => json({
      // A real earlier revision as the target: the Rollback confirm is disabled when the server names none.
      brand_id: row.brand_id, current_revision_id: row.current_revision_id, rollback_target_revision_id: row.current_revision_id ? `${row.current_revision_id}-prev` : null,
      revisions: row.current_revision_id ? [{
        revision_id: row.current_revision_id, revision: 2, template_version_id: "tpl-v2", form_artifact_id: "fa-2",
        bundle_form_version: "form@abcdef1", worker_version_id: "wv-2", created_by: "owner", created_at: "2026-10-02T00:00:00.000Z", is_current: true,
      }, {
        revision_id: `${row.current_revision_id}-prev`, revision: 1, template_version_id: "tpl-v1", form_artifact_id: "fa-1",
        bundle_form_version: "form@abcdef0", worker_version_id: "wv-1", created_by: "owner", created_at: "2026-10-01T00:00:00.000Z", is_current: false,
      }] : [],
    }));
  }
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    // The funnel of "today" starts at the same UTC day it ends on minus one day; every other window is the 7d fixture.
    if (input.startsWith("/api/funnel?")) {
      const params = new URLSearchParams(input.split("?")[1]);
      const days = Math.round((Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / 86_400_000);
      return json({ from: params.get("from"), to: params.get("to"), rows: (days === 1 ? DATA.today! : DATA["7d"]!).funnel });
    }
    const handler = routes.get(`${method} ${input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
  originalSpend = apiWithSpend.spend;
  spend = vi.fn(async (period: string) => spendReport(period));
  apiWithSpend.spend = spend as unknown as SpendFn;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalSpend) apiWithSpend.spend = originalSpend; else delete apiWithSpend.spend;
});

const names = () => [...document.querySelectorAll(".brand-table button.brand-pick")].map((button) => button.querySelector("b")?.textContent);
/** The cells of a brand's table row after the name: status, flow gate, then the numbers. */
const cells = (name: string) => {
  const row = [...document.querySelectorAll(".brand-table button.brand-pick")].find((button) => button.querySelector("b")?.textContent === name)!.closest("tr")!;
  // Read the text a person reads: the status badge icon is aria-hidden, and the Pause or Resume button is not a status.
  return [...row.querySelectorAll("td")].slice(1).map((cell) => {
    const copy = cell.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], .row-action').forEach((icon) => icon.remove());
    return copy.textContent;
  });
};
const sortSelect = () => screen.getByLabelText(/เรียงลำดับ/) as unknown as HTMLSelectElement;
const funnelPaths = () => requests.filter((r) => r.path.startsWith("/api/funnel?")).map((r) => r.path);

describe("brands table for the Owner", () => {
  it("lists spend, clicks, leads, cost per lead and profit, issues first", async () => {
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(names()).toEqual(["alpha.test", "creditsgene.test", "floatsme.test", "wizard.test"]));
    expect(cells("floatsme.test")).toEqual(["live", "Keyword Param", "฿21,700", "96", "0", "—", "−$620"]);
    expect(cells("creditsgene.test")).toEqual(["live", "Keyword Param", "฿28,000", "212", "10", "฿2,800", "−$546"]);
    expect(cells("alpha.test")).toEqual(["live", "Keyword Param", "฿3,500", "50", "5", "฿700", "$300"]);
    // No spend row: spend, cost per lead and profit are unknown, never 0.
    expect(cells("wizard.test")).toEqual(["live", "Keyword Param", "—", "40", "4", "—", "—"]);
    expect(screen.getByRole("columnheader", { name: /กำไร/ })).toBeTruthy();
    expect(spend).toHaveBeenCalledWith("7d");
  });

  it("shows ฿350 spend against $20 revenue at 35 THB per USD as a $10 profit, never $20 − 350", async () => {
    const week = DATA["7d"]!;
    const saved = { funnel: week.funnel, spend: week.spend };
    week.funnel = [funnelRow("brand-al", 50, 5, 20)];
    week.spend = [cost("brand-al", 10)];
    try {
      render(<BrandLifecycle me={owner} />);
      await waitFor(() => expect(cells("alpha.test")).toEqual(["live", "Keyword Param", "฿350", "50", "5", "฿70", "$10"]));
    } finally {
      Object.assign(week, saved);
    }
  });

  it("marks spend, cost per lead and profit with ~ when the spend row is an estimated campaign share", async () => {
    const week = DATA["7d"]!;
    const saved = { funnel: week.funnel, spend: week.spend };
    week.funnel = [funnelRow("brand-al", 50, 5, 20)];
    week.spend = [{ ...cost("brand-al", 10), allocation: "estimated" } as never];
    try {
      render(<BrandLifecycle me={owner} />);
      await waitFor(() => expect(cells("alpha.test")).toEqual(["live", "Keyword Param", "~฿350", "50", "5", "~฿70", "~$10"]));
    } finally {
      Object.assign(week, saved);
    }
  });

  it("shows a loss in the negative colour class and a gain in the positive one", async () => {
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(cells("floatsme.test")[6]).toBe("−$620"));
    const profitClass = (name: string) => [...document.querySelectorAll(".brand-table button.brand-pick")].find((b) => b.querySelector("b")?.textContent === name)!.closest("tr")!.querySelectorAll("td")[7]!.className;
    expect(profitClass("floatsme.test")).toBe("neg");
    expect(profitClass("alpha.test")).toBe("pos");
  });

  it("serves the 7-day table and the 7-day stats row with one funnel request, and refetches both sources for another period", async () => {
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(names()[0]).toBe("alpha.test"));
    expect(funnelPaths()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "7 วัน" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(sortSelect(), { target: { value: "profit" } });
    await waitFor(() => expect(names()).toEqual(["floatsme.test", "creditsgene.test", "alpha.test", "wizard.test"]));

    fireEvent.click(screen.getByRole("button", { name: "วันนี้" }));
    await waitFor(() => expect(spend).toHaveBeenCalledWith("today"));
    await waitFor(() => expect(cells("creditsgene.test")).toEqual(["live", "Keyword Param", "฿3,150", "20", "2", "฿1,575", "$410"]));
    expect(screen.getByRole("button", { name: "วันนี้" }).getAttribute("aria-pressed")).toBe("true");
    const today = funnelPaths().at(-1)!;
    const params = new URLSearchParams(today.split("?")[1]);
    expect(Date.parse(params.get("to")!) - Date.parse(params.get("from")!)).toBe(86_400_000);
    // The loss order follows the period: creditsgene.test now earns money, floatsme.test still loses.
    await waitFor(() => expect(names()).toEqual(["floatsme.test", "alpha.test", "creditsgene.test", "wizard.test"]));
    // The stats row under each brand stays the 7-day one.
    expect(screen.getByRole("group", { name: /สถิติ 7 วัน \(7-day stats\) creditsgene.test/ })).toBeTruthy();
  });

  it("shows spend, cost per lead and profit as unknown when the spend report fails", async () => {
    spend.mockRejectedValue(new Error("down"));
    render(<BrandLifecycle me={owner} />);
    await waitFor(() => expect(cells("floatsme.test")).toEqual(["live", "Keyword Param", "—", "96", "0", "—", "—"]));
    // Nothing to rank by, so the API order stays.
    fireEvent.change(sortSelect(), { target: { value: "profit" } });
    expect(names()).toEqual(["creditsgene.test", "floatsme.test", "alpha.test", "wizard.test"]);
  });
});

describe("brands table for an Employee", () => {
  it("has no money column, never asks for spend and shows no dollar amount", async () => {
    render(<BrandLifecycle me={employee} />);
    await waitFor(() => expect(cells("creditsgene.test")).toEqual(["live", "Keyword Param", "212", "10"]));
    expect(names()).toEqual(["alpha.test", "creditsgene.test", "floatsme.test", "wizard.test"]);
    expect(screen.queryByRole("columnheader", { name: /ค่าโฆษณา/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /ต้นทุน/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /กำไร/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$|AdKit/);
    expect(spend).not.toHaveBeenCalled();
    expect(requests.some((r) => r.path.startsWith("/api/spend"))).toBe(false);
  });
});

describe("side panel of the selected brand", () => {
  it("shows the clicked row's brand and sends its install actions with that brand id", async () => {
    routes.set("POST /api/brands/brand-fm/rollback", () => json({ error: "factory_dispatch_failed", message: "no factory" }, 502));
    render(<BrandLifecycle me={owner} />);
    // The default selection is the first brand of the API list, not the first table row.
    await screen.findByRole("heading", { name: "creditsgene.test" });
    await waitFor(() => expect(names()[0]).toBe("alpha.test"));

    fireEvent.click(screen.getByRole("button", { name: /floatsme.test/ }));
    const heading = await screen.findByRole("heading", { name: "floatsme.test" });
    const panel = within(heading.closest("section")!);
    await waitFor(() => expect(requests.some((r) => r.path === "/api/brands/brand-fm/installs")).toBe(true));
    fireEvent.click(await panel.findByRole("button", { name: "ย้อนกลับ" }));
    await answerConfirm(true);
    await waitFor(() => expect(requests.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/api/brands/brand-fm/rollback"]));
  });

  it("selects a brand from its stats row too", async () => {
    render(<BrandLifecycle me={employee} />);
    const group = await screen.findByRole("group", { name: /สถิติ 7 วัน \(7-day stats\) alpha.test/ });
    fireEvent.click(group);
    expect(await screen.findByRole("heading", { name: "alpha.test" })).toBeTruthy();
  });
});

describe("brandMoney, periodWindow and sortWorstProfitFirst", () => {
  const spendFixture: SpendReport = {
    period: "7d", from: "2026-10-01", to: "2026-10-07", totals: { cost_by_currency: { THB: 350, USD: 0 }, clicks: 0, impressions: 0 },
    brands: [{ brand_id: "b", currency: "THB", cost: 350, cost_usd: 10, clicks: 0, impressions: 0, updated_at: "2026-10-06T00:00:00.000Z" }],
    total_cost_usd: 10, fx: { thbPerUsd: 35 }, daily: [],
  };
  const runtime = [runtimeRow("b"), runtimeRow("c")] as never;
  const funnel = { from: "", to: "", rows: [funnelRow("b", 10, 4, 120), funnelRow("b", 5, 1, 30)] };

  it("sums the funnel rows of a brand and derives cost per lead and profit", () => {
    expect(brandMoney("b", runtime, funnel, spendFixture)).toEqual({
      clicks: 15, leads: 5, spend: { THB: 350 }, costPerLead: { THB: 70 }, profit: 140, estimated: false, spendText: "฿350", costPerLeadText: "฿70",
    });
  });

  it("keeps every currency row of a brand and takes profit from the summed cost_usd", () => {
    const twoCurrencies: SpendReport = {
      ...spendFixture,
      brands: [...spendFixture.brands, { brand_id: "b", currency: "USD", cost: 5, cost_usd: 5, clicks: 0, impressions: 0, updated_at: "2026-10-06T00:00:00.000Z" }],
    };
    expect(brandMoney("b", runtime, funnel, twoCurrencies)).toEqual({
      clicks: 15, leads: 5, spend: { THB: 350, USD: 5 }, costPerLead: { THB: 70, USD: 1 }, profit: 135, estimated: false, spendText: "฿350 + $5", costPerLeadText: "฿70 + $1",
    });
  });

  it("keeps a missing source unknown instead of 0", () => {
    const unknown = { spend: null, costPerLead: null, profit: null, estimated: false, spendText: "—", costPerLeadText: "—" };
    expect(brandMoney("c", runtime, funnel, spendFixture)).toEqual({ clicks: 0, leads: 0, ...unknown });
    expect(brandMoney("b", runtime, null, spendFixture)).toEqual({ clicks: null, leads: null, ...unknown, spend: { THB: 350 }, spendText: "฿350" });
    expect(brandMoney("b", null, funnel, null)).toEqual({ clicks: null, leads: null, ...unknown });
    expect(brandMoney("draft", runtime, funnel, spendFixture).clicks).toBeNull();
  });

  it("windows a period in whole UTC days ending after today", () => {
    const now = new Date("2026-10-22T15:30:00.000Z");
    expect(periodWindow("today", now)).toEqual({ from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" });
    expect(periodWindow("7d", now)).toEqual({ from: "2026-10-16T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" });
    expect(periodWindow("30d", now)).toEqual({ from: "2026-09-23T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" });
  });

  it("sorts the lowest profit first and keeps unknown profits last in their order", () => {
    const rows = [{ n: "u1", p: null }, { n: "gain", p: 5 }, { n: "loss", p: -9 }, { n: "u2", p: null }, { n: "flat", p: 0 }];
    expect(sortWorstProfitFirst(rows, (row) => row.p).map((row) => row.n)).toEqual(["loss", "flat", "gain", "u1", "u2"]);
  });
});
