import type { AlertsReportResponse } from "@anjuna/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

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
vi.mock("../src/client/screens/Home", () => ({
  HomeScreen: ({ onGo }: { onGo?: (target: "funnel" | "new-brand") => void }) => (
    <>
      <h1>หน้าแรก</h1>
      <button type="button" onClick={() => onGo?.("funnel")}>Home link to funnel</button>
      <button type="button" onClick={() => onGo?.("new-brand")}>Home link to new brand</button>
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
  // The count, prefs and brand-list reads are not under test here; a failed count falls back to the alerts report.
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

describe("Console rail", () => {
  it("starts at Home and shows the nine menu items and the signed-in user", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "หน้าแรก", "แบรนด์", "เทมเพลต", "แคมเปญ", "ทราฟฟิก", "ลีดและคอนเวอร์ชัน", "การแจ้งเตือน", "AdKit Terminal", "ตั้งค่า",
    ]);
    expect(within(nav).getByRole("link", { name: "หน้าแรก" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "หมวดย่อย" })).toBeNull();
    const user = document.querySelector<HTMLElement>(".sidebar-user")!;
    expect(within(user).getByText("owner@example.test")).toBeTruthy();
    expect(within(user).getByText("Owner")).toBeTruthy();
    // A count of zero shows no badge.
    await waitFor(() => expect(api.alerts).toHaveBeenCalled());
    expect(screen.queryByLabelText(/รายการที่ต้องจัดการ/)).toBeNull();
  });

  it.each([
    ["แบรนด์", "Brands screen: 0 -", "/brands"],
    ["เทมเพลต", "Templates screen -", "/templates"],
    ["แคมเปญ", "Campaigns screen owner", "/campaigns"],
    ["ทราฟฟิก", "Traffic screen", "/traffic"],
    ["ลีดและคอนเวอร์ชัน", "Leads screen", "/leads"],
    ["การแจ้งเตือน", "Alerts screen", "/alerts"],
    ["ตั้งค่า", "Settings screen", "/settings"],
  ])("keeps %s reachable and can return Home", async (label, heading, path) => {
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    const link = within(nav).getByRole("link", { name: new RegExp(`^${label}(?: |$)`) });
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(path);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    fireEvent.click(within(nav).getByRole("link", { name: "หน้าแรก" }));
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it.each([
    ["/deploys", "ประวัติการติดตั้ง", "Deploys screen"],
    ["/traffic", "ฟันเนล", "Funnel screen"],
    ["/funnel", "ข้อผิดพลาดฝั่งเว็บ", "Client errors screen"],
    ["/errors", "ทราฟฟิก", "Traffic screen"],
    ["/leads", "คอนเวอร์ชัน", "Conversions screen owner"],
    ["/conversions", "ลีด", "Leads screen"],
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

  it("opens the screen a Home link asks for", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Home link to funnel" }));
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    // Funnel is a tab of the Traffic item, so the sidebar marks Traffic and the tab strip marks Funnel.
    expect(screen.getByRole("navigation", { name: "เมนูหลัก" }).querySelector('[aria-current="page"]')?.textContent).toBe("ทราฟฟิก");
    expect(screen.getByRole("link", { name: "ฟันเนล" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the brand wizard from Home and repeats the existing request action", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Home link to new brand" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 1 -" })).toBeTruthy();
    expect(window.location.pathname).toBe("/brands/new");
    fireEvent.click(screen.getByRole("button", { name: "New brand button" }));
    expect(await screen.findByRole("heading", { name: "Brands screen: 2 -" })).toBeTruthy();
  });

  it("has no menu item or tab for the new brand wizard, only the button", async () => {
    window.history.replaceState(null, "", "/brands/new");
    render(<App />);
    await screen.findByRole("heading", { name: "Brands screen: 1 -" });
    expect(screen.queryByRole("link", { name: "สร้างแบรนด์ใหม่" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("แบรนด์");
    const tabs = screen.getByRole("navigation", { name: "หมวดย่อย" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["แบรนด์", "ประวัติการติดตั้ง"]);
    expect(within(tabs).getByRole("link", { name: "แบรนด์" }).getAttribute("aria-current")).toBe("page");
  });

  it("counts warn and alert categories, not affected leads or healthy categories", async () => {
    vi.mocked(api.alerts).mockResolvedValue(attention);
    render(<App />);
    const badge = await screen.findByLabelText("3 รายการที่ต้องจัดการ");
    expect(badge.textContent).toBe("3");
    expect(badge.closest("a")?.textContent).toBe("การแจ้งเตือน3");
  });

  it("hides the badge when the report is unavailable and reloads on navigation", async () => {
    vi.mocked(api.alerts).mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(attention);
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    await waitFor(() => expect(api.alerts).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/รายการที่ต้องจัดการ/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "เทมเพลต" }));
    expect(await screen.findByLabelText("3 รายการที่ต้องจัดการ")).toBeTruthy();
  });

  it("ignores an older report that resolves after a navigation refresh", async () => {
    let finish!: (report: AlertsReportResponse) => void;
    vi.mocked(api.alerts).mockReturnValueOnce(new Promise<AlertsReportResponse>((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "เทมเพลต" }));
    await waitFor(() => expect(api.alerts).toHaveBeenCalledTimes(2));
    await act(async () => { finish(attention); });
    expect(screen.queryByLabelText("3 รายการที่ต้องจัดการ")).toBeNull();
  });

  it("hides the owner-only tabs from employees and keeps the Settings item for the tabs they may open", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    render(<App />);
    await screen.findByRole("heading", { name: "หน้าแรก" });
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "หน้าแรก", "แบรนด์", "เทมเพลต", "แคมเปญ", "ทราฟฟิก", "ลีดและคอนเวอร์ชัน", "การแจ้งเตือน", "ตั้งค่า",
    ]);
    expect(within(nav).getByRole("link", { name: "ตั้งค่า" }).getAttribute("href")).toBe("/mailing");
    expect(screen.getByText("พนักงาน")).toBeTruthy();
    fireEvent.click(within(nav).getByRole("link", { name: "ตั้งค่า" }));
    expect(await screen.findByRole("heading", { name: "Mailing screen" })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "หมวดตั้งค่า" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["รายชื่ออีเมล", "ประวัติการแก้ไข", "คีย์ Builder"]);
  });

  it("shows an owner all eight Settings sections in order", async () => {
    window.history.replaceState(null, "", "/mailing");
    render(<App />);
    const tabs = await screen.findByRole("navigation", { name: "หมวดตั้งค่า" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["ทั่วไป", "ช่องทางแจ้งเตือน", "จัดสรรค่าโฆษณา", "ผู้ใช้", "รายชื่ออีเมล", "อีเมลที่บล็อก", "ประวัติการแก้ไข", "คีย์ Builder"]);
  });

  it("preserves initial template deep links", async () => {
    window.history.replaceState(null, "", "/#templates/tv-test");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Templates screen tv-test" })).toBeTruthy();
    expect(window.location.pathname).toBe("/templates/tv-test");
    expect(screen.getByRole("link", { name: "เทมเพลต" }).getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["/brands", "Brands screen: 0 -", "แบรนด์"],
    ["/brands/brand_abc", "Brands screen: 0 brand_abc", "แบรนด์"],
    ["/brands/new", "Brands screen: 1 -", "แบรนด์"],
    ["/brands/brand_abc/timeline", "Timeline screen brand_abc", "แบรนด์"],
    ["/deploys", "Deploys screen", "แบรนด์"],
    ["/templates/tv-1", "Templates screen tv-1", "เทมเพลต"],
    ["/traffic", "Traffic screen", "ทราฟฟิก"],
    ["/funnel", "Funnel screen", "ทราฟฟิก"],
    ["/errors", "Client errors screen", "ทราฟฟิก"],
    ["/leads", "Leads screen", "ลีดและคอนเวอร์ชัน"],
    ["/conversions", "Conversions screen owner", "ลีดและคอนเวอร์ชัน"],
    ["/conversions?period=30d&status=dead", "Conversions screen owner", "ลีดและคอนเวอร์ชัน"],
    ["/alerts", "Alerts screen", "การแจ้งเตือน"],
    ["/settings", "Settings screen", "ตั้งค่า"],
    ["/users", "Users screen", "ตั้งค่า"],
    ["/mailing", "Mailing screen", "ตั้งค่า"],
    ["/suppressions", "Suppressions screen", "ตั้งค่า"],
    ["/audit", "Audit screen", "ตั้งค่า"],
    ["/builder-keys", "Builder keys screen", "ตั้งค่า"],
    ["/campaigns", "Campaigns screen owner", "แคมเปญ"],
  ])("deep link %s renders its screen", async (path, heading, label) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    // The Alerts link name carries its badge count once the report loads, so match the label as a prefix.
    expect(within(nav).getByRole("link", { name: new RegExp(`^${label}`) }).getAttribute("aria-current")).toBe("page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("link", { name: "ทราฟฟิก" }));
    expect(window.location.pathname).toBe("/traffic");
    expect(await screen.findByRole("heading", { name: "Traffic screen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "ฟันเนล" }));
    expect(window.location.pathname).toBe("/funnel");
    expect(await screen.findByRole("heading", { name: "Funnel screen" })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(await screen.findByRole("heading", { name: "Traffic screen" })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    });
    expect(await screen.findByRole("heading", { name: "หน้าแรก" })).toBeTruthy();
  });

  it("titles the browser tab with the current page and follows navigation", async () => {
    window.history.replaceState(null, "", "/funnel");
    render(<App />);
    await screen.findByRole("heading", { name: "Funnel screen" });
    expect(document.title).toBe("ฟันเนล · Control Panel");
    fireEvent.click(screen.getByRole("link", { name: "หน้าแรก" }));
    await screen.findByRole("heading", { name: "หน้าแรก" });
    expect(document.title).toBe("หน้าแรก · Control Panel");
    fireEvent.click(screen.getByRole("link", { name: "ลีดและคอนเวอร์ชัน" }));
    await screen.findByRole("heading", { name: "Leads screen" });
    await waitFor(() => expect(document.title).toBe("ลีด · Control Panel"));
    fireEvent.click(screen.getByRole("link", { name: "คอนเวอร์ชัน" }));
    await screen.findByRole("heading", { name: "Conversions screen owner" });
    await waitFor(() => expect(document.title).toBe("คอนเวอร์ชัน · Control Panel"));
  });

  it("gives an employee the Conversions page, with the role passed to the screen", async () => {
    vi.mocked(api.me).mockResolvedValue({ ...owner, role: "employee" });
    window.history.replaceState(null, "", "/conversions");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Conversions screen employee" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "คอนเวอร์ชัน" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "ลีดและคอนเวอร์ชัน" }).getAttribute("aria-current")).toBe("page");
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
