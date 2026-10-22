import type { AlertsReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

// Exercise the shell's navigation without triggering unrelated screen requests.
vi.mock("../src/client/screens/BrandLifecycle", () => ({
  BrandLifecycle: ({ wizardRequest }: { wizardRequest: number }) => <h1>Brands screen: {wizardRequest}</h1>,
}));
vi.mock("../src/client/screens/Home", () => ({
  HomeScreen: ({ onGo }: { onGo?: (target: "funnel") => void }) => (
    <>
      <h1>หน้าแรก</h1>
      <button type="button" onClick={() => onGo?.("funnel")}>Home link to funnel</button>
    </>
  ),
}));
vi.mock("../src/client/screens/Templates", () => ({ TemplatesScreen: () => <h1>Templates screen</h1> }));
vi.mock("../src/client/screens/Funnel", () => ({ FunnelScreen: () => <h1>Funnel screen</h1> }));
vi.mock("../src/client/screens/Alerts", () => ({ AlertsScreen: () => <h1>Alerts screen</h1> }));
vi.mock("../src/client/screens/Mailing", () => ({ MailingScreen: () => <h1>Mailing screen</h1> }));
vi.mock("../src/client/screens/Audit", () => ({ AuditScreen: () => <h1>Audit screen</h1> }));
vi.mock("../src/client/screens/Users", () => ({ UsersScreen: () => <h1>Users screen</h1> }));
vi.mock("../src/client/screens/BuilderKeys", () => ({ BuilderKeysScreen: () => <h1>Builder keys screen</h1> }));
vi.mock("../src/client/screens/SignIn", () => ({ SignIn: () => <h1>Sign in screen</h1> }));

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const healthy: AlertsReportResponse = {
  generated_at: "2026-10-22T00:00:00.000Z",
  conversion_stalled: { state: "ok", detail: { max_hours: 6, stuck_count: 0, oldest_created_at: null } },
  brands_without_postbacks: { state: "ok", detail: { window_hours: 24, brands: [] } },
  submit_error_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, samples: [] } },
  reject_rate: { state: "ok", detail: { window_hours: 24, warn_at: 0.1, alert_at: 0.3, brands: [] } },
  click_risk: { state: "ok", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [] } },
};
const attention: AlertsReportResponse = {
  ...healthy,
  conversion_stalled: { state: "alert", detail: { max_hours: 6, stuck_count: 12, oldest_created_at: "2026-10-20T00:00:00.000Z" } },
  brands_without_postbacks: { state: "warn", detail: { window_hours: 24, brands: [{ brand: "test", leads: 4 }] } },
  click_risk: { state: "alert", detail: { window_hours: 24, alert_at: 0.2, min_visits: 50, hostnames: [{ hostname: "floatsme.com", visits: 100, high_risk: 31, rate: 0.31 }] } },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(api, "me").mockResolvedValue(owner);
  vi.spyOn(api, "alerts").mockResolvedValue(healthy);
  vi.spyOn(api, "signOut").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("Console rail", () => {
  it("starts at Home and displays the mockup navigation and signed-in user", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("button").map((button) => button.querySelector("span")?.textContent)).toEqual([
      "หน้าแรก", "แบรนด์", "สร้างแบรนด์ใหม่", "เทมเพลต", "ฟันเนล", "การแจ้งเตือน", "รายชื่ออีเมล", "ประวัติการแก้ไข", "ผู้ใช้", "คีย์ Builder",
    ]);
    expect(within(nav).getByRole("button", { name: "หน้าแรก" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(owner.email)).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(await screen.findByLabelText("0 รายการที่ต้องจัดการ")).toHaveProperty("textContent", "0");
  });

  it.each([
    ["แบรนด์", "Brands screen: 0"],
    ["เทมเพลต", "Templates screen"],
    ["ฟันเนล", "Funnel screen"],
    ["การแจ้งเตือน", "Alerts screen"],
    ["รายชื่ออีเมล", "Mailing screen"],
    ["ประวัติการแก้ไข", "Audit screen"],
    ["ผู้ใช้", "Users screen"],
    ["คีย์ Builder", "Builder keys screen"],
  ])("keeps %s reachable and can return Home", async (label, heading) => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    const button = within(nav).getByRole("button", { name: new RegExp(`^${label}(?: |$)`) });
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(button.getAttribute("aria-current")).toBe("page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    fireEvent.click(within(nav).getByRole("button", { name: "หน้าแรก" }));
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("opens the screen a Home link asks for", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Home link to funnel" }));
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ฟันเนล" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the brand wizard from Home and repeats the existing request action", async () => {
    render(<App />);
    const create = await screen.findByRole("button", { name: "สร้างแบรนด์ใหม่" });
    fireEvent.click(create);
    expect(await screen.findByRole("heading", { name: "Brands screen: 1" })).toBeTruthy();
    fireEvent.click(create);
    expect(await screen.findByRole("heading", { name: "Brands screen: 2" })).toBeTruthy();
  });

  it("counts warn and alert categories, not affected leads or healthy categories", async () => {
    vi.mocked(api.alerts).mockResolvedValue(attention);
    render(<App />);
    const badge = await screen.findByLabelText("3 รายการที่ต้องจัดการ");
    expect(badge.textContent).toBe("3");
    expect(badge.closest("button")?.textContent).toBe("การแจ้งเตือน3");
  });

  it("hides the badge when the report is unavailable and reloads on navigation", async () => {
    vi.mocked(api.alerts).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(attention);
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    await waitFor(() => expect(api.alerts).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/รายการที่ต้องจัดการ/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ฟันเนล" }));
    expect(await screen.findByLabelText("3 รายการที่ต้องจัดการ")).toBeTruthy();
  });

  it("ignores an older report that resolves after a navigation refresh", async () => {
    let finish!: (report: AlertsReportResponse) => void;
    vi.mocked(api.alerts).mockReturnValueOnce(new Promise<AlertsReportResponse>((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "ฟันเนล" }));
    await screen.findByLabelText("0 รายการที่ต้องจัดการ");
    await act(async () => { finish(attention); });
    expect(screen.getByLabelText("0 รายการที่ต้องจัดการ")).toBeTruthy();
    expect(screen.queryByLabelText("3 รายการที่ต้องจัดการ")).toBeNull();
  });

  it("hides owner-only Users from employees", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(screen.queryByRole("button", { name: /^ผู้ใช้$/ })).toBeNull();
    expect(screen.getByText("พนักงาน")).toBeTruthy();
    expect(screen.getByRole("button", { name: "คีย์ Builder" })).toBeTruthy();
  });

  it("preserves initial template deep links", async () => {
    window.history.replaceState(null, "", "/#templates/tv-test");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Templates screen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "เทมเพลต" }).getAttribute("aria-current")).toBe("page");
  });

  it("signs out through the existing API and removes the rail", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "ออกจากระบบ (Sign out)" }));
    expect(await screen.findByRole("heading", { name: "Sign in screen" })).toBeTruthy();
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
