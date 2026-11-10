import { roleAtLeast } from "@anjuna/contracts";
import { Activity, Bell, Home, LayoutTemplate, Megaphone, Settings, Store, Target, Terminal, type LucideIcon } from "lucide-react";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import type { Me } from "./api";
import type { View } from "./router";

type ShownView = Exclude<View, "not-found">;

/** One sub-page inside a sidebar group. `minRole` hides the tab from a lower role, and `alsoFor` keeps it selected on views it owns without a tab. */
export type NavTab = { id: ShownView; label: string; minRole?: Me["role"]; alsoFor?: ShownView[] };
export type NavGroupId = "brands" | "traffic" | "leads" | "settings";
/** One sidebar item. Its id is also the view of its first tab. */
export type NavGroup ={ id: NavGroupId; label: string; tabs: NavTab[] };

/** The four pages that hold several screens as section tabs. Every other page stands alone. Every route keeps its own URL. */
export const NAV_GROUPS: Record<NavGroupId, NavGroup> = {
  brands: {
    id: "brands",
    label: "แบรนด์",
    // New brand is a button on the Brands screen, so /brands/new and the brand timeline select the Brands tab.
    tabs: [
      { id: "brands", label: "แบรนด์", alsoFor: ["new-brand", "brand-timeline"] },
      { id: "deploys", label: "ประวัติการติดตั้ง" },
    ],
  },
  traffic: {
    id: "traffic",
    label: "ทราฟฟิก",
    tabs: [{ id: "traffic", label: "ทราฟฟิก" }, { id: "funnel", label: "ฟันเนล" }, { id: "errors", label: "ข้อผิดพลาดฝั่งเว็บ" }],
  },
  leads: {
    id: "leads",
    label: "ลีดและคอนเวอร์ชัน",
    tabs: [{ id: "leads", label: "ลีด" }, { id: "conversions", label: "คอนเวอร์ชัน" }],
  },
  settings: {
    id: "settings",
    label: "ตั้งค่า",
    tabs: [
      { id: "settings", label: "ทั่วไป", minRole: PANEL_ROLE_TABLE.viewSettings },
      { id: "notify-settings", label: "ช่องทางแจ้งเตือน", minRole: PANEL_ROLE_TABLE.viewSettings },
      { id: "ad-allocation", label: "จัดสรรค่าโฆษณา", minRole: PANEL_ROLE_TABLE.adAllocation },
      { id: "users", label: "ผู้ใช้", minRole: "owner" },
      { id: "mailing", label: "รายชื่ออีเมล" },
      { id: "suppressions", label: "อีเมลที่บล็อก", minRole: "owner" },
      { id: "audit", label: "ประวัติการแก้ไข" },
      { id: "builder-keys", label: "คีย์ Builder" },
    ],
  },
};

/** The tabs this role may open. A tab it may not use is left out, not shown disabled. */
export function visibleTabs(group: NavGroup, role: Me["role"]): NavTab[] {
  return group.tabs.filter((tab) => !tab.minRole || roleAtLeast(role, tab.minRole));
}

/** Every view the group owns, hidden tabs included: the sidebar item is current on all of them. */
export function groupViews(group: NavGroup): ShownView[] {
  return group.tabs.flatMap((tab) => [tab.id, ...(tab.alsoFor ?? [])]);
}

export function groupOfView(view: View): NavGroup | null {
  return Object.values(NAV_GROUPS).find((group) => (groupViews(group) as View[]).includes(view)) ?? null;
}

/** The id of the tab that owns `view`, or null when the group has none (a role that cannot open it sees no tab selected). */
export function activeTabId(group: NavGroup, view: View): ShownView | null {
  return group.tabs.find((tab) => tab.id === view || tab.alsoFor?.includes(view as ShownView))?.id ?? null;
}

export type SidebarBadge = "brands_need_fix" | "templates_awaiting" | "alerts_open";
export type SidebarSection = "work" | "watch" | "owner";

/**
 * One row of the sidebar. The nine rows are flat, in three sections (work, watch, owner) that a thin divider separates.
 * `group` makes the row current on every view of that page group. `minRole` hides the row from a lower role.
 */
export type SidebarEntry = { id: ShownView; label: string; icon: LucideIcon; section: SidebarSection; group?: NavGroupId; minRole?: Me["role"]; tag?: string; badge?: SidebarBadge };

export const SIDEBAR_ENTRIES: SidebarEntry[] = [
  { id: "home", label: "หน้าแรก", icon: Home, section: "work" },
  { id: "brands", label: "แบรนด์", icon: Store, section: "work", group: "brands", badge: "brands_need_fix" },
  { id: "templates", label: "เทมเพลต", icon: LayoutTemplate, section: "work", badge: "templates_awaiting" },
  { id: "campaigns", label: "แคมเปญ", icon: Megaphone, section: "work" },
  { id: "traffic", label: "ทราฟฟิก", icon: Activity, section: "watch", group: "traffic" },
  { id: "leads", label: "ลีดและคอนเวอร์ชัน", icon: Target, section: "watch", group: "leads" },
  { id: "alerts", label: "การแจ้งเตือน", icon: Bell, section: "watch", badge: "alerts_open" },
  { id: "adkit-terminal", label: "AdKit Terminal", icon: Terminal, section: "owner", minRole: PANEL_ROLE_TABLE.useTerminal, tag: "owner" },
  { id: "settings", label: "ตั้งค่า", icon: Settings, section: "owner", group: "settings" },
];
