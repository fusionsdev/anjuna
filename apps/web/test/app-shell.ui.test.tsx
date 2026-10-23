import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("leaves a ctrl-click or middle-click to the browser", () => {
    const { onOpen } = renderShell();
    const link = screen.getByRole("link", { name: "หน้าแรก" });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true); // default not prevented
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/");
  });
});
