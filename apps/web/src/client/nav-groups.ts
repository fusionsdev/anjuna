import { roleAtLeast } from "@anjuna/contracts";
import { ListTodo, Settings, Store, Wallet, type LucideIcon } from "lucide-react";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import type { Me } from "./api";
import type { View } from "./router";

type ShownView = Exclude<View, "not-found">;

/** One sub-page inside a page group. `minRole` hides the tab from a lower role, and `alsoFor` keeps it selected on views it owns without a tab. */
export type NavTab = { id: ShownView; label: string; minRole?: Me["role"]; alsoFor?: ShownView[] };
export type NavGroupId = "money" | "settings";
export type NavGroup = { id: NavGroupId; label: string; tabs: NavTab[] };

/** The two pages that hold several screens as section tabs. Every route keeps its own URL. */
export const NAV_GROUPS: Record<NavGroupId, NavGroup> = {
  money: {
    id: "money",
    label: "เงิน",
    tabs: [
      { id: "traffic", label: "ทราฟฟิก" },
      { id: "realtime", label: "เรียลไทม์" },
      { id: "funnel", label: "ฟันเนล" },
      { id: "leads", label: "ลีด" },
      { id: "conversions", label: "คอนเวอร์ชัน" },
      { id: "campaigns", label: "แคมเปญ" },
    ],
  },
  settings: {
    id: "settings",
    label: "ตั้งค่า",
    tabs: [
      { id: "settings", label: "ทั่วไป", minRole: PANEL_ROLE_TABLE.viewSettings },
      { id: "notify-settings", label: "ช่องทางแจ้งเตือน", minRole: PANEL_ROLE_TABLE.viewSettings },
      { id: "ad-allocation", label: "แบ่งค่าโฆษณา", minRole: PANEL_ROLE_TABLE.adAllocation },
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

/** Every view the group owns, hidden tabs included. */
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

/** One card of the ระบบ page. `minRole` hides the card from a lower role, the same gate its screen or settings tab has. */
export type SystemCard = { id: ShownView; label: string; desc: string; minRole?: Me["role"]; tag?: string };

/** The ระบบ page: the screens the owner does not open every day. Order follows the approved mockup. */
export const SYSTEM_CARDS: SystemCard[] = [
  { id: "templates", label: "เทมเพลต", desc: "เทมเพลตทั้งหมด และผลเช็กความซ้ำ ตัวที่รออนุมัติจะขึ้นที่ \"งานรอทำ\"" },
  { id: "adkit-terminal", label: "AdKit Terminal", desc: "สั่งงาน AdKit โดยตรง ใช้ตอนที่หน้าอื่นทำไม่ได้", minRole: PANEL_ROLE_TABLE.useTerminal, tag: "เจ้าของ" },
  { id: "mailing", label: "อีเมล", desc: "รายชื่ออีเมลของลีดที่ยินยอมรับข่าวสาร และสถานะการส่งเข้า listmonk" },
  { id: "builder-keys", label: "คีย์ Builder", desc: "คีย์ที่ให้เครื่องมือข้างนอกส่งเทมเพลตเข้ามา" },
  { id: "notify-settings", label: "ช่องทางแจ้งเตือน", desc: "เลือกว่าจะแจ้งเตือนไปที่ไหน และต้องมีลีดกี่รายก่อนเตือน", minRole: PANEL_ROLE_TABLE.viewSettings },
  { id: "ad-allocation", label: "แบ่งค่าโฆษณา", desc: "แบ่งค่าโฆษณาก้อนรวมให้แต่ละแบรนด์", minRole: PANEL_ROLE_TABLE.adAllocation },
  { id: "users", label: "ผู้ใช้", desc: "ใครเข้าแผงควบคุมได้บ้าง และทำอะไรได้แค่ไหน", minRole: "owner" },
  { id: "audit", label: "ประวัติการแก้ไข", desc: "ใครแก้อะไร เมื่อไหร่" },
  { id: "settings", label: "ตั้งค่าทั่วไป", desc: "ค่าของทุกแบรนด์ เช่น AID เกต ช่วงยอดเงิน และคีย์เวิร์ด", minRole: PANEL_ROLE_TABLE.viewSettings },
  { id: "errors", label: "ข้อผิดพลาดฝั่งเว็บ", desc: "ข้อผิดพลาดที่เกิดบนเว็บแบรนด์ ตอนคนเปิดหน้าหรือกรอกฟอร์ม" },
  { id: "deploys", label: "ประวัติการติดตั้ง", desc: "ติดตั้งเว็บแบรนด์ไปเมื่อไหร่ และสำเร็จหรือไม่" },
];

/** The cards this role may open. */
export function visibleSystemCards(role: Me["role"]): SystemCard[] {
  return SYSTEM_CARDS.filter((card) => !card.minRole || roleAtLeast(role, card.minRole));
}

export type SidebarBadge = "brands_need_fix" | "tasks_open";
export type SidebarEntryId = "home" | "brands" | "money" | "system";

/** One row of the sidebar. Its link opens the view named by `id`, and every view in `views` marks it current. */
export type SidebarEntry = { id: SidebarEntryId; label: string; icon: LucideIcon; views: readonly ShownView[]; badge?: SidebarBadge };

/** Four rows. Every older URL belongs to one of them, so a deep link still marks a row. */
export const SIDEBAR_ENTRIES: SidebarEntry[] = [
  // The open alerts are rows of งานรอทำ, so /alerts marks it.
  { id: "home", label: "งานรอทำ", icon: ListTodo, views: ["home", "alerts"], badge: "tasks_open" },
  { id: "brands", label: "แบรนด์", icon: Store, views: ["brands", "new-brand", "brand-timeline"], badge: "brands_need_fix" },
  { id: "money", label: "เงิน", icon: Wallet, views: ["money", ...groupViews(NAV_GROUPS.money)] },
  { id: "system", label: "ระบบ", icon: Settings, views: ["system", ...new Set([...SYSTEM_CARDS.map((card) => card.id), ...groupViews(NAV_GROUPS.settings)])] },
];

/** The sidebar row a view belongs to, or null for not-found. */
export function sidebarEntryOf(view: View): SidebarEntry | null {
  return SIDEBAR_ENTRIES.find((entry) => (entry.views as readonly View[]).includes(view)) ?? null;
}
