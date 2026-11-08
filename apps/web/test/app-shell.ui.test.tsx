import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/client/components/AppShell";
import { SidebarNav, type NavItem } from "../src/client/components/SidebarNav";

afterEach(cleanup);

const me = { id: "u1", email: "owner@example.test", role: "owner" as const, account: "aduplift" };
const items: NavItem[] = [
  { id: "home", label: "หน้าแรก" },
  { id: "alerts", label: "การแจ้งเตือน", badge: { count: 3, label: "3 รายการที่ต้องจัดการ" } },
];

function renderShell(onSignOut = vi.fn(), onOpen = vi.fn()) {
  render(
    <AppShell me={me} title="หน้าแรก" onSignOut={onSignOut} nav={<SidebarNav items={items} current="home" onOpen={onOpen} />}>
      <p>body</p>
    </AppShell>,
  );
  return { onSignOut, onOpen };
}

describe("AppShell", () => {
  it("shows the page title, tenant badge and user menu in the header", () => {
    const { onSignOut } = renderShell();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("หน้าแรก")).toBeTruthy();
    expect(within(header).getByText("aduplift")).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: /owner@example.test/ }));
    expect(screen.getByText("Owner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ออกจากระบบ (Sign out)" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the mobile drawer with the menu button and Escape", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "เมนู (Menu)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".shell")?.getAttribute("data-drawer")).toBe("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns focus to the menu button when Escape closes the drawer", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "เมนู (Menu)" });
    fireEvent.click(toggle);
    screen.getByRole("link", { name: "หน้าแรก" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
  });

  it("marks the closed sidebar inert on a mobile viewport only", () => {
    const original = window.matchMedia;
    const stub = (matches: boolean) => {
      window.matchMedia = ((query: string) => ({
        matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
    };
    try {
      stub(true);
      renderShell();
      const sidebar = () => document.querySelector("aside.sidebar")!;
      expect(sidebar().hasAttribute("inert")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "เมนู (Menu)" }));
      expect(sidebar().hasAttribute("inert")).toBe(false);
      cleanup();
      stub(false);
      renderShell();
      expect(sidebar().hasAttribute("inert")).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });

  it("moves focus to main when a nav link closes the mobile drawer", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      renderShell();
      fireEvent.click(screen.getByRole("button", { name: "เมนู (Menu)" }));
      const link = screen.getByRole("link", { name: /การแจ้งเตือน/ });
      link.focus();
      fireEvent.click(link);
      expect(document.activeElement).toBe(document.querySelector("main"));
    } finally {
      window.matchMedia = original;
    }
  });

  describe("on a mobile viewport", () => {
    const original = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((query: string) => ({
        matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => { window.matchMedia = original; });
    const mainCol = () => document.querySelector(".main-col")!;

    it("moves focus to the first nav link and makes the page behind inert while the drawer is open", () => {
      renderShell();
      const toggle = screen.getByRole("button", { name: "เมนู (Menu)" });
      expect(mainCol().hasAttribute("inert")).toBe(false);
      fireEvent.click(toggle);
      expect(document.activeElement).toBe(screen.getByRole("link", { name: "หน้าแรก" }));
      expect(mainCol().hasAttribute("inert")).toBe(true);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(mainCol().hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(toggle);
    });

    it("returns focus to the menu button when the scrim closes the drawer", () => {
      renderShell();
      const toggle = screen.getByRole("button", { name: "เมนู (Menu)" });
      fireEvent.click(toggle);
      fireEvent.click(document.querySelector(".shell-scrim")!);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(mainCol().hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(toggle);
    });
  });

  it("does not mark the page behind inert on a desktop viewport", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "เมนู (Menu)" }));
    expect(document.querySelector(".main-col")!.hasAttribute("inert")).toBe(false);
  });

  it("returns focus to the user menu button when Escape closes the user menu", () => {
    renderShell();
    const userButton = screen.getByRole("button", { name: /owner@example.test/ });
    fireEvent.click(userButton);
    screen.getByRole("button", { name: "ออกจากระบบ (Sign out)" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "ออกจากระบบ (Sign out)" })).toBeNull();
    expect(document.activeElement).toBe(userButton);
  });

  it("closes the user menu on a pointerdown outside it", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /owner@example.test/ }));
    expect(screen.getByRole("button", { name: "ออกจากระบบ (Sign out)" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "ออกจากระบบ (Sign out)" }));
    expect(screen.queryByRole("button", { name: "ออกจากระบบ (Sign out)" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "ออกจากระบบ (Sign out)" })).toBeNull();
  });

  it("closes the drawer when a nav link is used", () => {
    const { onOpen } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "เมนู (Menu)" }));
    fireEvent.click(screen.getByRole("link", { name: /การแจ้งเตือน/ }));
    expect(onOpen).toHaveBeenCalledWith("alerts");
    expect(screen.getByRole("button", { name: "เมนู (Menu)" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SidebarNav", () => {
  it("marks the current page and shows the badge", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getByRole("link", { name: "หน้าแรก" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByLabelText("3 รายการที่ต้องจัดการ").textContent).toBe("3");
  });

  it("marks a grouped item current on every view it lists and opens its target view", () => {
    const onOpen = vi.fn();
    const grouped: NavItem[] = [
      { id: "home", label: "หน้าแรก" },
      { id: "traffic", label: "ทราฟฟิก", activeFor: ["traffic", "funnel", "errors"] },
      { id: "settings", label: "ตั้งค่า", activeFor: ["settings", "mailing"], target: "mailing" },
    ];
    const { rerender } = render(<SidebarNav items={grouped} current="funnel" onOpen={onOpen} />);
    const nav = screen.getByRole("navigation", { name: "เมนูหลัก" });
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null]);
    rerender(<SidebarNav items={grouped} current="mailing" onOpen={onOpen} />);
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("aria-current"))).toEqual([null, null, "page"]);
    rerender(<SidebarNav items={grouped} current="not-found" onOpen={onOpen} />);
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    const settings = within(nav).getByRole("link", { name: "ตั้งค่า" });
    expect(settings.getAttribute("href")).toBe("/mailing");
    fireEvent.click(settings);
    expect(onOpen).toHaveBeenCalledWith("mailing");
  });

  it("leaves a ctrl-click or middle-click to the browser", () => {
    const { onOpen } = renderShell();
    const link = screen.getByRole("link", { name: "หน้าแรก" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true); // default not prevented
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/");
  });
});
