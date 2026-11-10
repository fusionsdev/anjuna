import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleBrandSummary } from "@anjuna/contracts";
import { BrandLifecycle } from "../src/client/screens/BrandLifecycle";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const lifecycle = (id: string, host: string, status: string) => LifecycleBrandSummary.parse({
  brand_id: id, account: "test-account", hostnames: [host], status, current_revision_id: "rev-1",
  runtime_sync_status: "ready", bundle_form_version: "form@abcdef1", payload_version: "2026-01",
});
const rows = [lifecycle("b-live", "live.example", "live"), lifecycle("b-paused", "paused.example", "paused")];
const runtimeRow = (id: string, status: string, flow_gate_mode: string) => ({
  brand_id: id, hostnames: [`${id}.example`], status, flow_gate_mode, ab_config: null, form_version: null,
  stats_7d: { leads: 0, sold: 0, pending: 0 },
});
const pauseName = "หยุดชั่วคราว";
const adsData = (accountFor: string[], enabledFor: string[] = []) => ({
  campaigns: enabledFor.map((brand_id, n) => ({ draft_job_id: `6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e${String(n).padStart(2, "0")}`, campaign_id: null, brand_id, account: "1234567890", name: "demo-search-1", daily_budget: 100, currency: "THB", daily_budget_thb: 100, state: "enabled", updated_at: "2026-10-06T00:00:00.000Z", geo: { country: "US" }, final_url: "https://x.test/" })),
  brands: accountFor.map((brand_id) => ({ brand_id, currency: "THB", thb_per_unit: 1, committed_thb_day: 0 })),
  caps: { total_thb_day: 1000, brand_thb_day: 500 }, enabled_total_thb_day: 0,
});
const resumeName = "เปิดใช้งานต่อ";

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Map<string, Handler>;
let requests: Array<{ method: string; path: string }>;
let pauseStatus: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rowOf = async (domain: string) => (await screen.findByRole("button", { name: new RegExp(domain.replace(".", "\\.")) })).closest("tr")!;
const posts = (path: string) => requests.filter((r) => r.method === "POST" && r.path === path);
/** Pause is a menu item of the live row: Resume is the primary button of a paused row, so only a live row can pause. */
const pauseFromMenu = async (row: HTMLElement) => {
  fireEvent.click(within(row).getByRole("button", { name: "จัดการ" }));
  fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: pauseName }));
};
const menuLabels = async (row: HTMLElement) => {
  fireEvent.click(within(row).getByRole("button", { name: "จัดการ" }));
  const labels = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent);
  fireEvent.mouseDown(document.body);
  return labels;
};

beforeEach(() => {
  requests = [];
  pauseStatus = 200;
  routes = new Map<string, Handler>([
    ["GET /api/upgrade-all/latest", () => json({ upgrade: null })],
    // A Google Ads read that answered: no brand has an account here.
    ["GET /api/ads/campaigns", () => json(adsData([]))],
    ["GET /api/lifecycle/brands", () => json({ brands: rows })],
    ["GET /api/brands", () => json({ brands: [runtimeRow("b-live", "live", "param"), runtimeRow("b-paused", "paused", "signed_cookie")], generated_at: "2026-10-06T00:00:00Z" })],
    ["GET /api/funnel", () => json({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-07T00:00:00.000Z", rows: [] })],
    ["POST /api/brands/b-live/pause", () => (pauseStatus === 200 ? json({ ok: true }) : json({ error: "internal" }, pauseStatus))],
    ["POST /api/brands/b-paused/resume", () => json({ ok: true })],
  ]);
  for (const row of rows) {
    routes.set(`GET /api/brands/${row.brand_id}/checklist`, () => json({ brand_id: row.brand_id, checklist: [] }));
    routes.set(`GET /api/brands/${row.brand_id}/installs`, () => json({ brand_id: row.brand_id, installs: [] }));
    // Served, so a failed revisions load does not add a second alert next to the toast under test.
    routes.set(`GET /api/brands/${row.brand_id}/revisions`, () => json({ brand_id: row.brand_id, current_revision_id: null, rollback_target_revision_id: null, revisions: [] }));
  }
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ method, path: input });
    const handler = routes.get(`${method} ${input.startsWith("/api/funnel?") ? "/api/funnel" : input}`);
    if (!handler) throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
    return handler(init);
  }));
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("brand row basics", () => {
  it("shows seven stage dots and the Google Ads chip on each row", async () => {
    render(<BrandLifecycle me={owner} />);
    const live = await rowOf("live.example");
    const dots = live.querySelector('[role="img"]')!;
    expect(dots.querySelectorAll(".stage-dot")).toHaveLength(7);
    expect(dots.getAttribute("aria-label")).toContain("สร้าง: เสร็จ");
    // The harness has no spend rows, so no Google Ads account is connected to the live brand. The paused brand reads paused.
    await waitFor(() => expect(live.querySelector('[data-col="ads"]')!.textContent).toBe("ยังไม่เชื่อม"));
    expect((await rowOf("paused.example")).querySelector('[data-col="ads"]')!.textContent).toBe("หยุดชั่วคราว");
  });

  it("pauses from the row menu after a confirm, without selecting the row", async () => {
    render(<BrandLifecycle me={owner} />);
    const live = await rowOf("live.example");
    await pauseFromMenu(live);
    await answerConfirm(false);
    expect(posts("/api/brands/b-live/pause")).toHaveLength(0);
    await pauseFromMenu(live);
    await answerConfirm(true);
    await waitFor(() => expect(posts("/api/brands/b-live/pause")).toHaveLength(1));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("หยุดแบรนด์แล้ว"));
  });

  it("a click on the row action does not select the row", async () => {
    render(<BrandLifecycle me={owner} />);
    const paused = await rowOf("paused.example");
    const pick = within(paused).getByRole("button", { name: /paused\.example/ });
    fireEvent.click(within(paused).getByRole("button", { name: resumeName }));
    await answerConfirm(false);
    expect(pick.getAttribute("aria-current")).toBeNull();
  });

  it("lets an Employee resume a paused brand and shows Pause of a live one disabled with the reason", async () => {
    render(<BrandLifecycle me={{ ...owner, role: "employee" }} />);
    const live = await rowOf("live.example");
    fireEvent.click(within(live).getByRole("button", { name: "จัดการ" }));
    const pause = within(await screen.findByRole("menu")).getByRole("menuitem", { name: pauseName });
    expect(pause.getAttribute("aria-disabled")).toBe("true");
    expect(pause.getAttribute("title")).toBe("เฉพาะเจ้าของหยุดแบรนด์ได้");
    fireEvent.click(pause);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts("/api/brands/b-live/pause")).toHaveLength(0);
    expect(within(await rowOf("paused.example")).getByRole("button", { name: resumeName })).toBeTruthy();
  });

  it("shows a failed pause as an error toast with the API error, after one request", async () => {
    pauseStatus = 500;
    render(<BrandLifecycle me={owner} />);
    await pauseFromMenu(await rowOf("live.example"));
    await answerConfirm(true);
    expect(within(await screen.findByRole("alert")).getByText("เกิดข้อผิดพลาด (500)")).toBeTruthy();
    expect(posts("/api/brands/b-live/pause")).toHaveLength(1);
  });

  it("a second Pause chosen while its request is in flight sends nothing", async () => {
    let release!: () => void;
    routes.set("POST /api/brands/b-live/pause", () => new Promise<Response>((resolve) => { release = () => resolve(json({ ok: true })); }));
    render(<BrandLifecycle me={owner} />);
    const live = await rowOf("live.example");
    await pauseFromMenu(live);
    await answerConfirm(true);
    await waitFor(() => expect(posts("/api/brands/b-live/pause")).toHaveLength(1));
    await pauseFromMenu(live);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts("/api/brands/b-live/pause")).toHaveLength(1);
    release();
    await screen.findByText("หยุดแบรนด์แล้ว");
    expect(posts("/api/brands/b-live/pause")).toHaveLength(1);
  });

  it("keeps the Resume button off while its request is in flight, so a second click sends nothing", async () => {
    let release!: () => void;
    routes.set("POST /api/brands/b-paused/resume", () => new Promise<Response>((resolve) => { release = () => resolve(json({ ok: true })); }));
    render(<BrandLifecycle me={owner} />);
    const button = within(await rowOf("paused.example")).getByRole("button", { name: resumeName }) as HTMLButtonElement;
    fireEvent.click(button);
    await answerConfirm(true);
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts("/api/brands/b-paused/resume")).toHaveLength(1);
    release();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(posts("/api/brands/b-paused/resume")).toHaveLength(1);
  });

  it("gives a second toast with the same text its own full countdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<BrandLifecycle me={owner} />);
    const live = await rowOf("live.example");
    const pause = async (count: number) => {
      await pauseFromMenu(live);
      await answerConfirm(true);
      await waitFor(() => expect(posts("/api/brands/b-live/pause")).toHaveLength(count));
      await screen.findByText("หยุดแบรนด์แล้ว");
    };
    await pause(1);
    act(() => { vi.advanceTimersByTime(3000); });
    await pause(2);
    // The first toast's 5 s ran out 2 s ago; the second one, shown 3 s ago, is still up.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("หยุดแบรนด์แล้ว")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2500); });
    expect(screen.queryByText("หยุดแบรนด์แล้ว")).toBeNull();
  });
});

describe("brand row Google Ads chip for a paused brand", () => {
  it("shows หยุดชั่วคราว for a factory-live brand that core reports as paused", async () => {
    routes.set("GET /api/brands", () => json({ brands: [runtimeRow("b-live", "paused", "param"), runtimeRow("b-paused", "paused", "signed_cookie")], generated_at: "2026-10-06T00:00:00Z" }));
    render(<BrandLifecycle me={owner} />);
    const row = await rowOf("live.example");
    await waitFor(() => expect(row.querySelector('[data-col="ads"]')!.textContent).toBe("หยุดชั่วคราว"));
  });

  it("does not show หยุดชั่วคราว while core reports the brand live", async () => {
    render(<BrandLifecycle me={owner} />);
    const row = await rowOf("live.example");
    expect(row.querySelector('[data-col="ads"]')!.textContent).not.toBe("หยุดชั่วคราว");
  });
});

describe("brand table cards", () => {
  it("brand table cells carry data-label", async () => {
    render(<BrandLifecycle me={owner} />);
    const row = await rowOf("live.example");
    const labels = [...row.querySelectorAll("td")].map((cell) => cell.getAttribute("data-label"));
    // The Brands table is compact: no cost per lead column, and no second row of stats under each brand.
    expect(labels).toEqual(["แบรนด์", "ระยะ", "ค่าโฆษณา", "ลีด", "Google Ads", ""]);
    expect(row.nextElementSibling?.className ?? "").not.toContain("stats");
  });

  it("brand table cells carry data-label without the owner-only cells for a non-owner", async () => {
    render(<BrandLifecycle me={{ ...owner, role: "employee" }} />);
    const row = await rowOf("live.example");
    const labels = [...row.querySelectorAll("td")].map((cell) => cell.getAttribute("data-label"));
    expect(labels).toEqual(["แบรนด์", "ระยะ", "ลีด", "Google Ads", ""]);
  });
});
