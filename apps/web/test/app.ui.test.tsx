import type { AlertsReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";
import { navigate } from "../src/client/router";

// Exercise the shell's navigation without triggering unrelated screen requests.
vi.mock("../src/client/screens/BrandLifecycle", () => ({
  BrandLifecycle: ({ wizardRequest, routeBrandId, wizardRoute, onSelectBrand, onNewBrand }: { wizardRequest: number; routeBrandId?: string | null; wizardRoute?: boolean; onSelectBrand?: (id: string) => void; onNewBrand?: () => void }) => (
    <>
      <h1>Brands screen: {wizardRequest} {routeBrandId ?? "-"}</h1>
      <p>wizardRoute {String(wizardRoute)}</p>
      <button type="button" onClick={() => onSelectBrand?.("brand_new")}>Pick brand_new</button>
      <button type="button" onClick={() => onNewBrand?.()}>New brand button</button>
    </>
  ),
}));
// FUS-393: Home is งานรอทำ (links only); the money page holds the button that opens a screen through onGo.
vi.mock("../src/client/screens/Home", () => ({ HomeScreen: () => <h1>หน้าแรก</h1> }));
vi.mock("../src/client/screens/Money", () => ({
  MoneyScreen: ({ onGo }: { onGo?: (target: "funnel") => void }) => (
    <>
      <h1>เงิน</h1>
      <button type="button" onClick={() => onGo?.("funnel")}>Money link to funnel</button>
    </>
  ),
}));
vi.mock("../src/client/screens/Templates", () => ({ TemplatesScreen: ({ selectedId }: { selectedId?: string | null }) => <h1>Templates screen {selectedId ?? "-"}</h1> }));
vi.mock("../src/client/screens/Funnel", () => ({ FunnelScreen: () => <h1>Funnel screen</h1> }));
vi.mock("../src/client/screens/Conversions", () => ({ ConversionsScreen: ({ me }: { me: { role: string } }) => <h1>Conversions screen {me.role}</h1> }));
vi.mock("../src/client/screens/Alerts", () => ({ AlertsScreen: () => <h1>Alerts screen</h1> }));
vi.mock("../src/client/screens/Mailing", () => ({ MailingScreen: () => <h1>Mailing screen</h1> }));
vi.mock("../src/client/screens/Audit", () => ({ AuditScreen: () => <h1>Audit screen</h1> }));
vi.mock("../src/client/screens/Users", () => ({ UsersScreen: () => <h1>Users screen</h1> }));
vi.mock("../src/client/screens/BuilderKeys", () => ({ BuilderKeysScreen: () => <h1>Builder keys screen</h1> }));
vi.mock("../src/client/traffic/RealtimeTab", () => ({ RealtimeTab: () => <h1>Realtime screen</h1> }));
vi.mock("../src/client/screens/Traffic", () => ({ TrafficScreen: () => <h1>Traffic screen</h1> }));
vi.mock("../src/client/screens/ClientErrors", () => ({ ClientErrorsScreen: () => <h1>Client errors screen</h1> }));
vi.mock("../src/client/screens/Leads", () => ({ LeadsScreen: () => <h1>Leads screen</h1> }));
vi.mock("../src/client/screens/Suppressions", () => ({ SuppressionsScreen: () => <h1>Suppressions screen</h1> }));
vi.mock("../src/client/screens/Settings", () => ({ SettingsScreen: () => <h1>Settings screen</h1> }));
vi.mock("../src/client/screens/NotifySettings", () => ({ NotifySettingsScreen: () => <h1>Notify settings screen</h1> }));
vi.mock("../src/client/screens/Deploys", () => ({ DeploysScreen: () => <h1>Deploys screen</h1> }));
vi.mock("../src/client/screens/Campaigns", () => ({ CampaignsScreen: ({ me }: { me: { role: string } }) => <h1>Campaigns screen {me.role}</h1> }));
vi.mock("../src/client/screens/BrandTimeline", () => ({ BrandTimelineScreen: ({ brandId }: { brandId: string }) => <h1>Timeline screen {brandId}</h1> }));
vi.mock("../src/client/screens/SignIn", () => ({ SignIn: () => <h1>Sign in screen</h1> }));
vi.mock("../src/client/screens/System", () => ({ SystemScreen: () => <h1>System screen</h1> }));
vi.mock("../src/client/screens/AdkitTerminal", () => ({ AdkitTerminalScreen: () => <h1>AdKit Terminal screen</h1> }));
vi.mock("../src/client/screens/AdAllocation", () => ({ AdAllocationScreen: () => <h1>Ad allocation screen</h1> }));

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
  // The count, prefs and brand-list reads are not under test here; a failed count shows no badge.
  vi.spyOn(api, "navCounts").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "mePrefs").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "lifecycleBrands").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "brands").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "signOut").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const nav = () => screen.getByRole("navigation", { name: "เมนูหลัก" });
const crumbs = () => screen.getByRole("navigation", { name: "ตำแหน่งหน้านี้" });

describe("Console rail", () => {
  it("starts at งานรอทำ and shows the four menu items, the create button and the signed-in user", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
    expect(within(nav()).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual(["งานรอทำ", "แบรนด์", "เงิน", "ระบบ"]);
    expect(within(nav()).getByRole("link", { name: "งานรอทำ" }).getAttribute("aria-current")).toBe("page");
    // The create button is not a menu item: it sits above the menu and opens the wizard.
    const create = screen.getByRole("link", { name: "+ สร้างแบรนด์ใหม่" });
    expect(nav().contains(create)).toBe(false);
    expect(create.getAttribute("href")).toBe("/brands/new");
    expect(screen.queryByRole("navigation", { name: "หมวดย่อย" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "ตำแหน่งหน้านี้" })).toBeNull();
    const user = document.querySelector<HTMLElement>(".sidebar-user")!;
    expect(within(user).getByText("owner@example.test")).toBeTruthy();
    expect(within(user).getByText("Owner")).toBeTruthy();
    // A failed count shows no badge.
    await waitFor(() => expect(api.navCounts).toHaveBeenCalled());
    expect(nav().querySelectorAll("b")).toHaveLength(0);
  });

  it.each([
    ["แบรนด์", "Brands screen: 0 -", "/brands"],
    ["เงิน", "เงิน", "/money"],
    ["ระบบ", "System screen", "/system"],
  ])("keeps %s reachable and can return to งานรอทำ", async (label, heading, path) => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    const link = within(nav()).getByRole("link", { name: new RegExp(`^${label}(?: |$)`) });
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(path);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(nav().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    fireEvent.click(within(nav()).getByRole("link", { name: "งานรอทำ" }));
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it.each([
    ["/realtime", "ทราฟฟิก", "Traffic screen"],
    ["/traffic", "ฟันเนล", "Funnel screen"],
    ["/funnel", "ลีด", "Leads screen"],
    ["/leads", "คอนเวอร์ชัน", "Conversions screen owner"],
    ["/conversions", "แคมเปญ", "Campaigns screen owner"],
    ["/campaigns", "เรียลไทม์", "Realtime screen"],
    ["/settings", "ผู้ใช้", "Users screen"],
    ["/users", "รายชื่ออีเมล", "Mailing screen"],
    ["/mailing", "อีเมลที่บล็อก", "Suppressions screen"],
    ["/suppressions", "ประวัติการแก้ไข", "Audit screen"],
    ["/audit", "คีย์ Builder", "Builder keys screen"],
    ["/builder-keys", "ทั่วไป", "Settings screen"],
    ["/settings", "ช่องทางแจ้งเตือน", "Notify settings screen"],
  ])("from %s the tab %s opens its screen and becomes the only selected tab", async (start, label, heading) => {
    window.history.replaceState(null, "", start);
    render(<App />);
    const tabs = await screen.findByRole("navigation", { name: /^หมวด(?:ย่อย|ตั้งค่า)$/ });
    fireEvent.click(within(tabs).getByRole("link", { name: label }));
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
    expect(tabs.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("lists the เงิน tabs on the money page with none selected, and each opens its own URL", async () => {
    window.history.replaceState(null, "", "/money");
    render(<App />);
    await screen.findByRole("heading", { name: "เงิน" });
    const tabs = screen.getByRole("navigation", { name: "หมวดย่อย" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["ทราฟฟิก", "เรียลไทม์", "ฟันเนล", "ลีด", "คอนเวอร์ชัน", "แคมเปญ"]);
    expect(tabs.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    fireEvent.click(within(tabs).getByRole("link", { name: "ทราฟฟิก" }));
    expect(await screen.findByRole("heading", { name: "Traffic screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/traffic");
  });

  it("opens the screen a เงิน page link asks for", async () => {
    window.history.replaceState(null, "", "/money");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Money link to funnel" }));
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    // Funnel is a tab of the เงิน item, so the sidebar marks เงิน and the tab strip marks Funnel.
    expect(nav().querySelector('[aria-current="page"]')?.textContent).toBe("เงิน");
    expect(screen.getByRole("link", { name: "ฟันเนล" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the brand wizard from the sidebar create button and repeats the existing request action", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    fireEvent.click(screen.getByRole("link", { name: "+ สร้างแบรนด์ใหม่" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 1 -" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
    fireEvent.click(screen.getByRole("button", { name: "New brand button" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 2 -" })).toBeTruthy();
  });

  it("marks แบรนด์ on the wizard route, and the sidebar create button opens the wizard again", async () => {
    window.history.replaceState(null, "", "/brands/new");
    render(<App />);
    await screen.findByRole("heading", { name: "Brands screen: 1 -" });
    expect(nav().querySelector('[aria-current="page"]')?.textContent).toBe("แบรนด์");
    expect(screen.queryByRole("navigation", { name: "หมวดย่อย" })).toBeNull();
    expect(crumbs().textContent).toBe("แบรนด์สร้างแบรนด์ใหม่");
    fireEvent.click(screen.getByRole("link", { name: "+ สร้างแบรนด์ใหม่" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 2 -" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
  });

  it.each(["/system", "/funnel", "/alerts", "/brands/brand_abc/timeline"])("shows the create button on %s and opens the wizard from it", async (path) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "+ สร้างแบรนด์ใหม่" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 1 -" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
  });

  it("does not read the alerts report for a badge when the counts call fails", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    await waitFor(() => expect(api.navCounts).toHaveBeenCalledTimes(1));
    fireEvent.click(within(nav()).getByRole("link", { name: "ระบบ" }));
    await screen.findByRole("heading", { name: "System screen" });
    expect(nav().querySelectorAll("b")).toHaveLength(0);
    expect(api.alerts).not.toHaveBeenCalled();
    expect(api.navCounts).toHaveBeenCalledTimes(1);
  });

  it("shows an employee the same four items and only the Settings sections they may open", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(within(nav()).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual(["งานรอทำ", "แบรนด์", "เงิน", "ระบบ"]);
    expect(within(nav()).getByRole("link", { name: "ระบบ" }).getAttribute("href")).toBe("/system");
    expect(screen.getByText("พนักงาน")).toBeTruthy();
    act(() => navigate("/mailing"));
    expect(await screen.findByRole("heading", { name: "Mailing screen" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "หมวดตั้งค่า" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["รายชื่ออีเมล", "ประวัติการแก้ไข", "คีย์ Builder"]);
  });

  it("shows an owner all eight Settings sections in order", async () => {
    window.history.replaceState(null, "", "/mailing");
    render(<App />);
    const tabs = await screen.findByRole("navigation", { name: "หมวดตั้งค่า" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["ทั่วไป", "ช่องทางแจ้งเตือน", "แบ่งค่าโฆษณา", "ผู้ใช้", "รายชื่ออีเมล", "อีเมลที่บล็อก", "ประวัติการแก้ไข", "คีย์ Builder"]);
  });

  it("preserves initial template deep links", async () => {
    window.history.replaceState(null, "", "/#templates/tv-test");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Templates screen tv-test" })).toBeTruthy();
    expect(window.location.pathname).toBe("/templates/tv-test");
    expect(within(nav()).getByRole("link", { name: "ระบบ" }).getAttribute("aria-current")).toBe("page");
  });

  // Every older URL renders its screen, marks the sidebar item of its group, and names that group in the breadcrumb.
  it.each([
    ["/", "หน้าแรก", "งานรอทำ", null],
    ["/alerts", "Alerts screen", "งานรอทำ", "การแจ้งเตือน"],
    ["/brands", "Brands screen: 0 -", "แบรนด์", null],
    ["/brands/brand_abc", "Brands screen: 0 brand_abc", "แบรนด์", null],
    ["/brands/new", "Brands screen: 1 -", "แบรนด์", "สร้างแบรนด์ใหม่"],
    ["/brands/brand_abc/timeline", "Timeline screen brand_abc", "แบรนด์", "ไทม์ไลน์แบรนด์"],
    ["/money", "เงิน", "เงิน", null],
    ["/realtime", "Realtime screen", "เงิน", "เรียลไทม์"],
    ["/traffic", "Traffic screen", "เงิน", "ทราฟฟิก"],
    ["/funnel", "Funnel screen", "เงิน", "ฟันเนล"],
    ["/leads", "Leads screen", "เงิน", "ลีด"],
    ["/conversions", "Conversions screen owner", "เงิน", "คอนเวอร์ชัน"],
    ["/conversions?period=30d&status=dead", "Conversions screen owner", "เงิน", "คอนเวอร์ชัน"],
    ["/campaigns", "Campaigns screen owner", "เงิน", "แคมเปญ"],
    ["/system", "System screen", "ระบบ", null],
    ["/templates", "Templates screen -", "ระบบ", "เทมเพลต"],
    ["/templates/tv-1", "Templates screen tv-1", "ระบบ", "เทมเพลต"],
    ["/adkit-terminal", "AdKit Terminal screen", "ระบบ", "AdKit Terminal"],
    ["/deploys", "Deploys screen", "ระบบ", "ประวัติการติดตั้ง"],
    ["/errors", "Client errors screen", "ระบบ", "ข้อผิดพลาดฝั่งเว็บ"],
    ["/settings", "Settings screen", "ระบบ", "ตั้งค่าทั่วไป"],
    ["/notify-settings", "Notify settings screen", "ระบบ", "ช่องทางแจ้งเตือน"],
    ["/ad-allocation", "Ad allocation screen", "ระบบ", "แบ่งค่าโฆษณา"],
    ["/users", "Users screen", "ระบบ", "ผู้ใช้"],
    ["/mailing", "Mailing screen", "ระบบ", "รายชื่ออีเมล"],
    ["/suppressions", "Suppressions screen", "ระบบ", "อีเมลที่บล็อก"],
    ["/audit", "Audit screen", "ระบบ", "ประวัติการแก้ไข"],
    ["/builder-keys", "Builder keys screen", "ระบบ", "คีย์ Builder"],
  ])("deep link %s renders its screen under its sidebar item", async (path, heading, label, page) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    const item = within(nav()).getByRole("link", { name: new RegExp(`^${label}`) });
    expect(item.getAttribute("aria-current")).toBe("page");
    expect(nav().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    if (page === null) {
      expect(screen.queryByRole("navigation", { name: "ตำแหน่งหน้านี้" })).toBeNull();
      return;
    }
    expect(within(crumbs()).getByRole("link", { name: label }).getAttribute("href")).toBe(item.getAttribute("href"));
    expect(crumbs().querySelector('[aria-current="page"]')?.textContent).toBe(page);
  });

  it("goes back to the group page from the breadcrumb", async () => {
    window.history.replaceState(null, "", "/deploys");
    render(<App />);
    await screen.findByRole("heading", { name: "Deploys screen" });
    fireEvent.click(within(crumbs()).getByRole("link", { name: "ระบบ" }));
    expect(await screen.findByRole("heading", { name: "System screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/system");
  });

  it("back from /brands/new to /brands turns wizardRoute off", async () => {
    window.history.replaceState(null, "", "/brands");
    render(<App />);
    await screen.findByText("wizardRoute false");
    fireEvent.click(screen.getByRole("button", { name: "New brand button" }));
    expect(await screen.findByText("wizardRoute true")).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(window.location.pathname).toBe("/brands");
    expect(await screen.findByText("wizardRoute false")).toBeTruthy();
  });

  it("forward to /brands/new turns wizardRoute on", async () => {
    window.history.replaceState(null, "", "/brands");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New brand button" }));
    await screen.findByText("wizardRoute true");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    await screen.findByText("wizardRoute false");
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(window.location.pathname).toBe("/brands/new");
    expect(await screen.findByText("wizardRoute true")).toBeTruthy();
  });

  it("replaces /brands/new when the wizard selects the new brand, so back skips the wizard", async () => {
    window.history.replaceState(null, "", "/brands");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New brand button" }));
    await screen.findByText("wizardRoute true");
    fireEvent.click(screen.getByRole("button", { name: "Pick brand_new" }));
    expect(window.location.pathname).toBe("/brands/brand_new");
    expect(await screen.findByText("wizardRoute false")).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(window.location.pathname).toBe("/brands");
  });

  it("changes the URL on navigation and follows the back button", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    fireEvent.click(within(nav()).getByRole("link", { name: "เงิน" }));
    expect(window.location.pathname).toBe("/money");
    expect(await screen.findByRole("heading", { name: "เงิน" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "ฟันเนล" }));
    expect(window.location.pathname).toBe("/funnel");
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(await screen.findByRole("heading", { name: "เงิน" })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("titles the browser tab with the current page and its sidebar item, and follows navigation", async () => {
    window.history.replaceState(null, "", "/funnel");
    render(<App />);
    await screen.findByRole("heading", { name: "Funnel screen" });
    expect(document.title).toBe("ฟันเนล · เงิน · Control Panel");
    fireEvent.click(within(nav()).getByRole("link", { name: "งานรอทำ" }));
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(document.title).toBe("งานรอทำ · Control Panel");
    fireEvent.click(within(nav()).getByRole("link", { name: "เงิน" }));
    await screen.findByRole("heading", { name: "เงิน" });
    await waitFor(() => expect(document.title).toBe("เงิน · Control Panel"));
    fireEvent.click(screen.getByRole("link", { name: "ลีด" }));
    await screen.findByRole("heading", { name: "Leads screen" });
    await waitFor(() => expect(document.title).toBe("ลีด · เงิน · Control Panel"));
    fireEvent.click(screen.getByRole("link", { name: "คอนเวอร์ชัน" }));
    await screen.findByRole("heading", { name: "Conversions screen owner" });
    await waitFor(() => expect(document.title).toBe("คอนเวอร์ชัน · เงิน · Control Panel"));
  });

  it("gives an employee the Conversions page, with the role passed to the screen", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    window.history.replaceState(null, "", "/conversions");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Conversions screen employee" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "คอนเวอร์ชัน" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav()).getByRole("link", { name: "เงิน" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows Page not found for an unknown path and marks no nav item", async () => {
    window.history.replaceState(null, "", "/nope");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "ไม่พบหน้านี้ (Page not found)" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("link", { name: "กลับหน้าแรก (Back to Home)" }));
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("tells an Employee who opens /users that the page is Owner only", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    window.history.replaceState(null, "", "/users");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "สำหรับ Owner เท่านั้น (Owner only)" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Users screen" })).toBeNull();
  });

  it("opens the list for a malformed template hash", async () => {
    window.history.replaceState(null, "", "/#templates/%");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Templates screen -" })).toBeTruthy();
  });

  it("signs out through the existing API and removes the rail", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "ออกจากระบบ" }));
    expect(await screen.findByRole("heading", { name: "Sign in screen" })).toBeTruthy();
    expect(api.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
