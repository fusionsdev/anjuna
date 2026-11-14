import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionTabs } from "../src/client/components/SectionTabs";
import { NAV_GROUPS, SIDEBAR_ENTRIES, activeTabId, groupOfView, groupViews, sidebarEntryOf, visibleTabs } from "../src/client/nav-groups";
import type { View } from "../src/client/router";

afterEach(cleanup);

const tabs = [
  { id: "traffic" as const, label: "ทราฟฟิก" },
  { id: "funnel" as const, label: "ฟันเนล" },
  { id: "errors" as const, label: "ข้อผิดพลาดฝั่งเว็บ" },
];

describe("SectionTabs", () => {
  it("renders one link per tab with its own URL and marks the active one", () => {
    render(<SectionTabs tabs={tabs} active="funnel" onSelect={() => undefined} />);
    const nav = screen.getByRole("navigation", { name: "หมวดย่อย" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["ทราฟฟิก", "ฟันเนล", "ข้อผิดพลาดฝั่งเว็บ"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/traffic", "/funnel", "/errors"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("marks no tab when the active view has none", () => {
    render(<SectionTabs tabs={tabs} active={null} onSelect={() => undefined} />);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });

  it("calls onSelect with the tab id on a plain click and keeps the browser default for a modified click", () => {
    const onSelect = vi.fn();
    render(<SectionTabs tabs={tabs} active="traffic" onSelect={onSelect} />);
    const errors = screen.getByRole("link", { name: "ข้อผิดพลาดฝั่งเว็บ" });
    // React runs first at the root; this document listener reads the result, then stops jsdom from trying to navigate.
    const prevented: boolean[] = [];
    const record = (e: Event) => { prevented.push(e.defaultPrevented); e.preventDefault(); };
    document.addEventListener("click", record);
    try {
      fireEvent.click(errors);
      expect(onSelect).toHaveBeenCalledWith("errors");
      onSelect.mockClear();
      fireEvent.click(errors, { ctrlKey: true });
      fireEvent.click(errors, { button: 1 });
    } finally {
      document.removeEventListener("click", record);
    }
    expect(prevented).toEqual([true, false, false]);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("nav groups", () => {
  const labels = (group: keyof typeof NAV_GROUPS, role: "owner" | "employee") => visibleTabs(NAV_GROUPS[group], role).map((t) => t.label);

  it("lists the tab sets for an owner", () => {
    expect(labels("money", "owner")).toEqual(["ทราฟฟิก", "เรียลไทม์", "ฟันเนล", "ลีด", "คอนเวอร์ชัน", "แคมเปญ"]);
    expect(labels("settings", "owner")).toEqual(["ทั่วไป", "ช่องทางแจ้งเตือน", "แบ่งค่าโฆษณา", "ผู้ใช้", "รายชื่ออีเมล", "อีเมลที่บล็อก", "ประวัติการแก้ไข", "คีย์ Builder"]);
  });

  it("leaves the owner-only tabs out for an employee", () => {
    expect(labels("settings", "employee")).toEqual(["รายชื่ออีเมล", "ประวัติการแก้ไข", "คีย์ Builder"]);
    expect(labels("money", "employee")).toEqual(labels("money", "owner"));
  });

  it("puts every screen under one of the four sidebar items, and only not-found under none", () => {
    // A Record forces a new view to be listed here, so a screen added later cannot silently miss the menu.
    const item: Record<View, string | null> = {
      "not-found": null,
      home: "home", alerts: "home",
      brands: "brands", "new-brand": "brands", "brand-timeline": "brands",
      money: "money", realtime: "money", traffic: "money", funnel: "money", leads: "money", conversions: "money", campaigns: "money",
      system: "system", templates: "system", "adkit-terminal": "system", deploys: "system", errors: "system",
      settings: "system", "notify-settings": "system", "ad-allocation": "system", users: "system", mailing: "system", suppressions: "system", audit: "system", "builder-keys": "system",
    };
    for (const [view, id] of Object.entries(item)) expect(sidebarEntryOf(view as View)?.id ?? null, view).toBe(id);
    // No view sits under two items.
    const all = SIDEBAR_ENTRIES.flatMap((entry) => entry.views);
    expect(new Set(all).size).toBe(all.length);
  });

  it("maps the tabbed screens to their tab group and leaves the rest without tabs", () => {
    expect(groupOfView("funnel")?.id).toBe("money");
    expect(groupOfView("campaigns")?.id).toBe("money");
    expect(groupOfView("mailing")?.id).toBe("settings");
    for (const view of ["home", "alerts", "brands", "new-brand", "money", "system", "templates", "deploys", "errors", "adkit-terminal"] as const) expect(groupOfView(view), view).toBeNull();
  });

  it("selects the tab that owns a view and none for a view outside the group", () => {
    expect(activeTabId(NAV_GROUPS.money, "realtime")).toBe("realtime");
    expect(activeTabId(NAV_GROUPS.money, "money")).toBeNull();
    expect(activeTabId(NAV_GROUPS.settings, "home")).toBeNull();
  });

  it("makes the sidebar item current on every view of its tab group", () => {
    expect(groupViews(NAV_GROUPS.money)).toEqual(["traffic", "realtime", "funnel", "leads", "conversions", "campaigns"]);
    expect([...groupViews(NAV_GROUPS.settings)].sort()).toEqual(["ad-allocation", "audit", "builder-keys", "mailing", "notify-settings", "settings", "suppressions", "users"]);
  });
});
