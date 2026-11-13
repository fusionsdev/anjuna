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
  vi.spyOn(api, "navCounts").mockResolvedValue({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 2 });
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
  it("shows 9 items to the owner with a divider before ทราฟฟิก, before AdKit Terminal and at the end", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(within(nav()).getAllByRole("link")).toHaveLength(9);
    expect(outline()).toEqual(["หน้าแรก", "แบรนด์", "เทมเพลต", "แคมเปญ", "|", "ทราฟฟิก", "ลีดและคอนเวอร์ชัน", "การแจ้งเตือน", "|", "AdKit Terminal", "ตั้งค่า", "|"]);
    expect(within(nav()).getAllByRole("separator")).toHaveLength(3);
  });

  it("shows 8 items to an employee: AdKit Terminal is hidden and the divider moves above ตั้งค่า", async () => {
    vi.mocked(api.me).mockResolvedValue(employee);
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(within(nav()).getAllByRole("link")).toHaveLength(8);
    expect(within(nav()).queryByRole("link", { name: /AdKit Terminal/ })).toBeNull();
    expect(outline()).toEqual(["หน้าแรก", "แบรนด์", "เทมเพลต", "แคมเปญ", "|", "ทราฟฟิก", "ลีดและคอนเวอร์ชัน", "การแจ้งเตือน", "|", "ตั้งค่า", "|"]);
  });

  it("gives every item a lucide icon and tags AdKit Terminal owner", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    for (const link of within(nav()).getAllByRole("link")) expect(link.querySelector("svg"), link.textContent ?? "").toBeTruthy();
    const adkit = within(nav()).getByRole("link", { name: /AdKit Terminal/ });
    expect(adkit.querySelector(".nav-tag")?.textContent).toBe("owner");
    expect(SIDEBAR_ENTRIES).toHaveLength(9);
  });

  it("shows the badge counts GET /api/nav/counts returns", async () => {
    render(<App />);
    // The brands badge counts the rows the Brands page opens on, so its label names no subset.
    expect((await screen.findByLabelText("3 แบรนด์")).textContent).toBe("3");
    expect(screen.getByLabelText("4 เทมเพลตรออนุมัติ").textContent).toBe("4");
    expect(screen.getByLabelText("2 รายการที่ต้องจัดการ").textContent).toBe("2");
    expect(screen.getByLabelText("3 แบรนด์").closest("a")?.textContent).toBe("แบรนด์3");
  });

  it("shows no badge for a count of 0", async () => {
    vi.mocked(api.navCounts).mockResolvedValue({ brands_need_fix: 0, templates_awaiting: 0, alerts_open: 0 });
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

  it("hides only the alerts badge when the server could not count alerts", async () => {
    vi.mocked(api.navCounts).mockResolvedValue({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: null });
    render(<App />);
    expect((await screen.findByLabelText("3 แบรนด์")).textContent).toBe("3");
    expect(screen.getByLabelText("4 เทมเพลตรออนุมัติ").textContent).toBe("4");
    expect(screen.queryByLabelText(/รายการที่ต้องจัดการ/)).toBeNull();
  });

  it("does not read the counts again on a page change", async () => {
    render(<App />);
    await screen.findByLabelText("2 รายการที่ต้องจัดการ");
    fireEvent.click(within(nav()).getByRole("link", { name: /การแจ้งเตือน/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/alerts"));
    fireEvent.click(within(nav()).getByRole("link", { name: /หน้าแรก/ }));
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(api.navCounts).toHaveBeenCalledTimes(1);
  });

  it("reads the alerts badge again after an acknowledge or close, without leaving the page", async () => {
    window.history.replaceState(null, "", "/alerts");
    vi.mocked(api.alerts).mockResolvedValue({ ...healthy, brands_without_postbacks: { state: "alert", detail: { window_hours: 24, brands: [{ brand: "brand-a", leads: 4 }] } } });
    vi.mocked(api.navCounts).mockResolvedValueOnce({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 1 }).mockResolvedValue({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 0 });
    const action = vi.spyOn(api, "alertAction").mockResolvedValue({ alert_key: "brands_without_postbacks:brand-a", state: "alert", first_seen: "2026-11-10T00:00:00.000Z", last_sent: null, acknowledged_by: null, acknowledged_at: null, closed_at: "2026-11-10T01:00:00.000Z", updated_at: "2026-11-10T01:00:00.000Z" });
    render(<App />);
    expect((await screen.findByLabelText("1 รายการที่ต้องจัดการ")).textContent).toBe("1");
    fireEvent.click(await screen.findByRole("button", { name: /^ปิด แบรนด์ไม่มีโพสต์แบ็ก/ }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("brands_without_postbacks:brand-a", "close"));
    // The badge goes away with the count of 0, on the same page.
    await waitFor(() => expect(screen.queryByLabelText(/รายการที่ต้องจัดการ/)).toBeNull());
    expect(window.location.pathname).toBe("/alerts");
    expect(api.navCounts).toHaveBeenCalledTimes(2);
  });

  it("reads the counts again after a brand scope change is saved", async () => {
    vi.mocked(api.mePrefs).mockResolvedValue({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: {} });
    const save = vi.spyOn(api, "saveMePrefs").mockImplementation(async (body) => body);
    vi.mocked(api.navCounts).mockResolvedValueOnce({ brands_need_fix: 3, templates_awaiting: 4, alerts_open: 2 }).mockResolvedValue({ brands_need_fix: 5, templates_awaiting: 4, alerts_open: 2 });
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
