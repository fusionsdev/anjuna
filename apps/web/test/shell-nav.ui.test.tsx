import type { AlertsReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { resetAlertSession } from "../src/client/alerts-session";
import { api } from "../src/client/api";
import { Chip } from "../src/client/components/Chip";
import { SourceChip } from "../src/client/components/SourceChip";
import { SIDEBAR_ENTRIES } from "../src/client/nav-groups";

vi.mock("../src/client/screens/Home", () => ({ HomeScreen: () => <h1>หน้าแรก</h1> }));

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { id: "staff", email: "staff@example.test", role: "employee" as const };
const healthy: AlertsReportResponse = {
  generated_at: "2026-11-10T00:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, samples: [] } },
  reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, brands: [] } },
  click_risk: { state: "ok", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [] } },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "me").mockResolvedValue(owner);
  vi.spyOn(api, "alerts").mockResolvedValue(healthy);
  vi.spyOn(api, "navCounts").mockResolvedValue({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 2, tasks_open: 7 });
  vi.spyOn(api, "mePrefs").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "brands").mockRejectedValue(new Error("unavailable"));
});
afterEach(() => {
  cleanup();
  resetAlertSession();
  vi.restoreAllMocks();
});

const nav = () => screen.getByRole("navigation", { name: "เมนูหลัก" });
/** The menu as a reader sees it: link names in order, "|" for each divider. */
const outline = () => [...nav().children].map((el) => (el.getAttribute("role") === "separator" ? "|" : el.querySelector("span")?.textContent));

describe("sidebar", () => {
  it("shows the four items with a closing divider, the same for owner and employee", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(within(nav()).getAllByRole("link")).toHaveLength(4);
    expect(outline()).toEqual(["งานรอทำ", "แบรนด์", "เงิน", "ระบบ", "|"]);
    cleanup();
    vi.mocked(api.me).mockResolvedValue(employee);
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(outline()).toEqual(["งานรอทำ", "แบรนด์", "เงิน", "ระบบ", "|"]);
  });

  it("gives every item a lucide icon", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    for (const link of within(nav()).getAllByRole("link")) expect(link.querySelector("svg"), link.textContent ?? "").toBeTruthy();
    expect(SIDEBAR_ENTRIES).toHaveLength(4);
  });

  it("shows the brands and งานรอทำ badges GET /api/nav/counts returns", async () => {
    render(<App />);
    // The brands badge counts the rows the Brands page opens on, so its label names no subset.
    expect((await screen.findByLabelText("3 แบรนด์")).textContent).toBe("3");
    expect(screen.getByLabelText("3 แบรนด์").closest("a")?.textContent).toBe("แบรนด์3");
    // FUS-393: the งานรอทำ badge is tasks_open, the row count of the page (task-rows.ts).
    expect(screen.getByLabelText("7 เรื่องรอทำ").closest("a")?.textContent).toBe("งานรอทำ7");
    expect(nav().querySelectorAll("b")).toHaveLength(2);
  });

  it("shows no badge for a count of 0", async () => {
    vi.mocked(api.navCounts).mockResolvedValue({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 0, tasks_open: 0 });
    render(<App />);
    await waitFor(() => expect(api.navCounts).toHaveBeenCalled());
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(nav().querySelectorAll("b")).toHaveLength(0);
  });

  it("hides every badge when the counts call fails, without counting alerts another way", async () => {
    vi.mocked(api.navCounts).mockRejectedValue(new Error("not served yet"));
    vi.mocked(api.alerts).mockResolvedValue({ ...healthy, conversion_stalled: { state: "alert", detail: { max_hours: 6, stuck_count: 5, oldest_created_at: "2026-11-09T00:00:00.000Z" } } });
    render(<App />);
    await waitFor(() => expect(api.navCounts).toHaveBeenCalled());
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(nav().querySelectorAll("b")).toHaveLength(0);
    expect(api.alerts).not.toHaveBeenCalled();
  });

  it("reads the counts again only on returning to งานรอทำ, which reads its rows again", async () => {
    render(<App />);
    await screen.findByLabelText("3 แบรนด์");
    expect(api.navCounts).toHaveBeenCalledTimes(1);
    fireEvent.click(within(nav()).getByRole("link", { name: /เงิน/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/money"));
    expect(api.navCounts).toHaveBeenCalledTimes(1);
    fireEvent.click(within(nav()).getByRole("link", { name: /งานรอทำ/ }));
    await screen.findByRole("heading", { name: "หน้าแรก" });
    await waitFor(() => expect(api.navCounts).toHaveBeenCalledTimes(2));
  });

  it("counts under the saved scope, and under a ?scope= link while the link decides the scope", async () => {
    render(<App />);
    await screen.findByLabelText("3 แบรนด์");
    expect(vi.mocked(api.navCounts).mock.calls).toEqual([[null]]);
    cleanup();
    vi.mocked(api.navCounts).mockClear();
    window.history.replaceState(null, "", "/?scope=all");
    render(<App />);
    await screen.findByLabelText("3 แบรนด์");
    expect(vi.mocked(api.navCounts).mock.calls).toEqual([["all"]]);
    cleanup();
    vi.mocked(api.navCounts).mockClear();
    window.history.replaceState(null, "", "/?scope=brand-a,%20brand-b");
    render(<App />);
    await screen.findByLabelText("3 แบรนด์");
    expect(vi.mocked(api.navCounts).mock.calls).toEqual([["brand-a,brand-b"]]);
  });

  it("reads the counts again after an alert acknowledge or close, without leaving the page", async () => {
    window.history.replaceState(null, "", "/alerts");
    vi.mocked(api.alerts).mockResolvedValue({ ...healthy, brands_without_postbacks: { state: "alert", detail: { window_hours: 24, brands: [{ brand: "brand-a", leads: 4 }] } } });
    vi.mocked(api.navCounts).mockResolvedValueOnce({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 1, tasks_open: 7 }).mockResolvedValue({ brands_need_fix: 2, templates_awaiting: 4, alerts_open: 0, tasks_open: 7 });
    const action = vi.spyOn(api, "alertAction").mockResolvedValue({ alert_key: "brands_without_postbacks:brand-a", state: "alert", first_seen: "2026-11-10T00:00:00.000Z", last_sent: null, acknowledged_by: null, acknowledged_at: null, closed_at: "2026-11-10T01:00:00.000Z", updated_at: "2026-11-10T01:00:00.000Z" });
    render(<App />);
    expect((await screen.findByLabelText("3 แบรนด์")).textContent).toBe("3");
    fireEvent.click(await screen.findByRole("button", { name: /^ปิด ยังไม่ได้ผลจากผู้ซื้อ/ }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("brands_without_postbacks:brand-a", "close"));
    expect((await screen.findByLabelText("2 แบรนด์")).textContent).toBe("2");
    expect(window.location.pathname).toBe("/alerts");
    expect(api.navCounts).toHaveBeenCalledTimes(2);
  });

  it("reads the counts again after a brand scope change is saved", async () => {
    vi.mocked(api.mePrefs).mockResolvedValue({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: {} });
    const save = vi.spyOn(api, "saveMePrefs").mockImplementation(async (body) => body);
    vi.mocked(api.navCounts).mockResolvedValueOnce({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 2, tasks_open: 7 }).mockResolvedValue({ brands_need_fix: 5, templates_awaiting: 4, alerts_open: 2, tasks_open: 7 });
    render(<App />);
    expect((await screen.findByLabelText("3 แบรนด์")).textContent).toBe("3");
    fireEvent.click(await screen.findByRole("button", { name: /แบรนด์ที่ใช้งาน/ }));
    const dialog = await screen.findByRole("dialog", { name: "ขอบเขตแบรนด์" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "ซ่อนแบรนด์ที่ไม่ได้ใช้แล้ว" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // The server counts under the saved scope, so the badge follows the new one.
    expect((await screen.findByLabelText("5 แบรนด์")).textContent).toBe("5");
    expect(api.navCounts).toHaveBeenCalledTimes(2);
  });

  it("links the logo to Home", async () => {
    window.history.replaceState(null, "", "/alerts");
    render(<App />);
    await screen.findAllByRole("link", { name: "Anjuna" });
    const side = within(document.querySelector<HTMLElement>("aside.sidebar")!);
    expect(side.getByRole("link", { name: "Anjuna" }).getAttribute("href")).toBe("/");
  });
});

describe("Chip and SourceChip", () => {
  it.each(["success", "warning", "danger", "info", "neutral", "accent"] as const)("renders the %s tone", (tone) => {
    render(<Chip tone={tone}>ข้อความ</Chip>);
    const chip = screen.getByText("ข้อความ");
    expect(chip.className).toContain(`chip-${tone}`);
    expect(chip.querySelector(".chip-dot")).toBeNull();
  });

  it("draws a dot only when asked", () => {
    render(<Chip tone="success" dot>ใช้งาน</Chip>);
    expect(screen.getByText("ใช้งาน").querySelector(".chip-dot")).toBeTruthy();
  });

  it("names the data source with an icon", () => {
    render(<SourceChip>D1 · brands</SourceChip>);
    const chip = screen.getByText("D1 · brands");
    expect(chip.className).toBe("source-chip");
    expect(chip.querySelector("svg")).toBeTruthy();
  });
});
