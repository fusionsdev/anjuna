import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { api } from "../src/client/api";

// Only the section list and the route behind each entry are under test; each screen is a heading.
vi.mock("../src/client/screens/BrandLifecycle", () => ({ BrandLifecycle: () => <h1>Brands screen</h1> }));
vi.mock("../src/client/screens/Settings", () => ({ SettingsScreen: () => <h1>Settings screen</h1> }));
vi.mock("../src/client/screens/NotifySettings", () => ({ NotifySettingsScreen: () => <h1>Notify screen</h1> }));
vi.mock("../src/client/screens/Users", () => ({ UsersScreen: () => <h1>Users screen</h1> }));
vi.mock("../src/client/screens/Mailing", () => ({ MailingScreen: () => <h1>Mailing screen</h1> }));
vi.mock("../src/client/screens/Audit", () => ({ AuditScreen: () => <h1>Audit screen</h1> }));
vi.mock("../src/client/screens/BuilderKeys", () => ({ BuilderKeysScreen: () => <h1>Builder keys screen</h1> }));
vi.mock("../src/client/screens/Suppressions", () => ({ SuppressionsScreen: () => <h1>Suppressions screen</h1> }));

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const employee = { id: "employee", email: "employee@example.test", role: "employee" as const };

beforeEach(() => {
  vi.spyOn(api, "alerts").mockRejectedValue(new Error("alerts are not under test"));
  for (const name of ["navCounts", "mePrefs", "lifecycleBrands", "brands"] as const) vi.spyOn(api, name).mockRejectedValue(new Error("not under test"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const sections = () => within(screen.getByRole("navigation", { name: "หมวดตั้งค่า" }));

describe("Settings section list", () => {
  it("lists the eight sections for an owner in the order of the design, one link each with its own URL", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/settings");
    render(<App />);
    await screen.findByRole("heading", { name: "Settings screen" });
    const links = sections().getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["ทั่วไป", "ช่องทางแจ้งเตือน", "จัดสรรค่าโฆษณา", "ผู้ใช้", "รายชื่ออีเมล", "อีเมลที่บล็อก", "ประวัติการแก้ไข", "คีย์ Builder"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/settings", "/notify-settings", "/ad-allocation", "/users", "/mailing", "/suppressions", "/audit", "/builder-keys"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null, null, null, null, null, null]);
    // The old tab strip is gone from this group.
    expect(screen.queryByRole("navigation", { name: "หมวดย่อย" })).toBeNull();
  });

  it("opens a section on click, moves the current mark and keeps the URL", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/settings");
    render(<App />);
    await screen.findByRole("heading", { name: "Settings screen" });
    fireEvent.click(sections().getByRole("link", { name: "ช่องทางแจ้งเตือน" }));
    expect(await screen.findByRole("heading", { name: "Notify screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/notify-settings");
    expect(sections().getByRole("link", { name: "ช่องทางแจ้งเตือน" }).getAttribute("aria-current")).toBe("page");
    expect(document.querySelectorAll('.settings-sections [aria-current="page"]')).toHaveLength(1);
    fireEvent.click(sections().getByRole("link", { name: "คีย์ Builder" }));
    expect(await screen.findByRole("heading", { name: "Builder keys screen" })).toBeTruthy();
    expect(window.location.pathname).toBe("/builder-keys");
  });

  it("lays the screen out beside the list in one shell, so the list can sit at the left", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/users");
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Users screen" });
    const shell = screen.getByRole("navigation", { name: "หมวดตั้งค่า" }).parentElement!;
    expect(shell.classList.contains("settings-shell")).toBe(true);
    expect(shell.contains(heading)).toBe(true);
  });

  it("gives an employee three sections and no ช่องทางแจ้งเตือน", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/mailing");
    render(<App />);
    await screen.findByRole("heading", { name: "Mailing screen" });
    expect(sections().getAllByRole("link").map((a) => a.textContent)).toEqual(["รายชื่ออีเมล", "ประวัติการแก้ไข", "คีย์ Builder"]);
    expect(sections().queryByRole("link", { name: "ช่องทางแจ้งเตือน" })).toBeNull();
  });

  it("shows an employee the owner-only card, not the notify screen, on /notify-settings", async () => {
    vi.spyOn(api, "me").mockResolvedValue(employee);
    window.history.replaceState(null, "", "/notify-settings");
    render(<App />);
    expect(await screen.findByText("สำหรับ Owner เท่านั้น")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Notify screen" })).toBeNull();
    expect(sections().queryByRole("link", { name: "ช่องทางแจ้งเตือน" })).toBeNull();
  });

  it("leaves the other groups on their section tabs", async () => {
    vi.spyOn(api, "me").mockResolvedValue(owner);
    window.history.replaceState(null, "", "/brands");
    render(<App />);
    await screen.findByRole("heading", { name: "Brands screen" });
    expect(screen.getByRole("navigation", { name: "หมวดย่อย" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "หมวดตั้งค่า" })).toBeNull();
  });
});
