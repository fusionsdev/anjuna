import { roleAtLeast } from "@anjuna/contracts";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import type { Me } from "./api";
import type { View } from "./router";

type ShownView = Exclude<View, "not-found">;

/** One sub-page inside a sidebar group. `minRole` hides the tab from a lower role, and `alsoFor` keeps it selected on views it owns without a tab. */
export type NavTab = { id: ShownView; label: string; minRole?: Me["role"]; alsoFor?: ShownView[] };
export type NavGroupId = "brands" | "traffic" | "leads" | "settings";
/** One sidebar item. Its id is also the view of its first tab. */
export type NavGroup ={ id: NavGroupId; label: string; tabs: NavTab[] };

/** The four sidebar items that hold several screens. Home, Templates and Alerts stand alone. Every route keeps its own URL. */
export const NAV_GROUPS: Record<NavGroupId, NavGroup> = {
  brands: {
    id: "brands",
    label: "แบรนด์",
    // New brand is a button on the Brands screen, so /brands/new and the brand timeline select the Brands tab.
    // Campaigns (T13 Part B) is a tab here, so the sidebar keeps the redesign's 7 items.
    tabs: [
      { id: "brands", label: "แบรนด์", alsoFor: ["new-brand", "brand-timeline"] },
      { id: "campaigns", label: "แคมเปญ" },
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
      { id: "settings", label: "ตั้งค่า", minRole: PANEL_ROLE_TABLE.viewSettings },
      { id: "ad-allocation", label: "จัดสรรค่าโฆษณา", minRole: PANEL_ROLE_TABLE.adAllocation },
      { id: "users", label: "ผู้ใช้", minRole: "owner" },
      { id: "mailing", label: "รายชื่ออีเมล" },
      { id: "suppressions", label: "อีเมลที่บล็อก", minRole: "owner" },
      { id: "audit", label: "ประวัติการแก้ไข" },
      { id: "builder-keys", label: "คีย์ Builder" },
      { id: "adkit-terminal", label: "AdKit Terminal", minRole: PANEL_ROLE_TABLE.useTerminal },
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
