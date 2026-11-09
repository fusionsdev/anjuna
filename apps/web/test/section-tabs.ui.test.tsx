import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionTabs } from "../src/client/components/SectionTabs";
import { NAV_GROUPS, activeTabId, groupOfView, groupViews, visibleTabs } from "../src/client/nav-groups";
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

  it("lists the tab sets of the brief for an owner", () => {
    expect(labels("brands", "owner")).toEqual(["แบรนด์", "แคมเปญ", "ประวัติการติดตั้ง"]);
    expect(labels("traffic", "owner")).toEqual(["ทราฟฟิก", "ฟันเนล", "ข้อผิดพลาดฝั่งเว็บ"]);
    expect(labels("leads", "owner")).toEqual(["ลีด", "คอนเวอร์ชัน"]);
    expect(labels("settings", "owner")).toEqual(["ตั้งค่า", "ผู้ใช้", "รายชื่ออีเมล", "อีเมลที่บล็อก", "ประวัติการแก้ไข", "คีย์ Builder", "AdKit Terminal"]);
  });

  it("leaves the owner-only tabs out for an employee", () => {
    expect(labels("settings", "employee")).toEqual(["รายชื่ออีเมล", "ประวัติการแก้ไข", "คีย์ Builder"]);
    for (const group of ["brands", "traffic", "leads"] as const) expect(labels(group, "employee")).toEqual(labels(group, "owner"));
  });

  it("maps every screen to a group except Home, Templates, Alerts and not-found", () => {
    // A Record forces a new view to be listed here, so a screen added later cannot silently miss the menu.
    const grouped: Record<View, string | null> = {
      home: null, templates: null, alerts: null, "not-found": null,
      brands: "brands", "new-brand": "brands", "brand-timeline": "brands", deploys: "brands", campaigns: "brands",
      traffic: "traffic", funnel: "traffic", errors: "traffic",
      leads: "leads", conversions: "leads",
      settings: "settings", users: "settings", mailing: "settings", suppressions: "settings", audit: "settings", "builder-keys": "settings",
      "adkit-terminal": "settings",
    };
    for (const [view, group] of Object.entries(grouped)) expect(groupOfView(view as View)?.id ?? null, view).toBe(group);
  });

  it("shows the AdKit Terminal tab to the owner only (T13-6)", () => {
    expect(labels("settings", "owner")).toContain("AdKit Terminal");
    expect(labels("settings", "employee")).not.toContain("AdKit Terminal");
  });

  it("selects the Brands tab on the wizard and the brand timeline, which have no tab of their own", () => {
    expect(activeTabId(NAV_GROUPS.brands, "new-brand")).toBe("brands");
    expect(activeTabId(NAV_GROUPS.brands, "brand-timeline")).toBe("brands");
    expect(activeTabId(NAV_GROUPS.brands, "deploys")).toBe("deploys");
    expect(activeTabId(NAV_GROUPS.traffic, "home")).toBeNull();
  });

  it("makes the sidebar item current on every view of its group", () => {
    expect(groupViews(NAV_GROUPS.traffic)).toEqual(["traffic", "funnel", "errors"]);
    expect(groupViews(NAV_GROUPS.leads)).toEqual(["leads", "conversions"]);
    expect([...groupViews(NAV_GROUPS.brands)].sort()).toEqual(["brand-timeline", "brands", "campaigns", "deploys", "new-brand"]);
    expect([...groupViews(NAV_GROUPS.settings)].sort()).toEqual(["adkit-terminal", "audit", "builder-keys", "mailing", "settings", "suppressions", "users"]);
  });
});
