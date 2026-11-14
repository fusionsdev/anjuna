import { LogOut, Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Me } from "../api";
import { isPlainLeftClick, navigate, viewPath, type View } from "../router";
import { useBrandScope } from "../useBrandScope";
import { useStackLabels } from "../stack-labels";
import { useShortcuts } from "../useShortcuts";
import { BrandScopeControl } from "./BrandScopeControl";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

export const pageTitle: Record<View, string> = {
  home: "งานรอทำ", brands: "แบรนด์", "new-brand": "สร้างแบรนด์ใหม่", templates: "เทมเพลต", funnel: "ฟันเนล",
  conversions: "คอนเวอร์ชัน", alerts: "การแจ้งเตือน", deploys: "ประวัติการติดตั้ง", mailing: "รายชื่ออีเมล", audit: "ประวัติการแก้ไข", users: "ผู้ใช้",
  "builder-keys": "คีย์ Builder", leads: "ลีด", suppressions: "อีเมลที่บล็อก",
  settings: "ตั้งค่าทั่วไป",
  "notify-settings": "ช่องทางแจ้งเตือน",
  "ad-allocation": "แบ่งค่าโฆษณา",
  "brand-timeline": "ไทม์ไลน์แบรนด์", // spec timeline
  realtime: "เรียลไทม์", traffic: "ทราฟฟิก", errors: "ข้อผิดพลาดฝั่งเว็บ", // spec traffic
  campaigns: "แคมเปญ", // T13 Part B
  "adkit-terminal": "AdKit Terminal", // T13-6
  money: "เงิน", system: "ระบบ", // FUS-393
  "not-found": "ไม่พบหน้านี้",
};

const MOBILE_QUERY = "(max-width: 1023px)";

/** True while the viewport is under the 1024px breakpoint, where the sidebar becomes a drawer. jsdom has no matchMedia, so it reads false there. */
function useMobileViewport() {
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

/**
 * Sidebar (232px) with the logo, the create-brand button, the brand scope button, the menu and the user block;
 * a 56px top bar and a drawer under 1024px.
 */
export function AppShell({ me, nav, onSignOut, onCreateBrand, children }: { me: Me; nav: ReactNode; onSignOut: () => void; onCreateBrand: () => void; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [help, setHelp] = useState(false);
  const mobile = useMobileViewport();
  const scope = useBrandScope();
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  // Where focus lands after the drawer closes. The page behind is inert while the drawer is open, so the move runs after the commit.
  const afterClose = useRef<"menu" | "main">("menu");
  const drawerWasOpen = useRef(false);
  const scopeOpen = useRef(scope.open);
  scopeOpen.current = scope.open;
  const closeDrawer = (focus: "menu" | "main" = "menu") => { afterClose.current = focus; setDrawer(false); scope.setOpen(false); };
  useEffect(() => {
    if (drawer) sidebar.current?.querySelector<HTMLElement>("a.nav")?.focus();
    else if (drawerWasOpen.current) (afterClose.current === "main" ? main : menuButton).current?.focus();
    drawerWasOpen.current = drawer;
  }, [drawer]);
  // The scope control lives in the sidebar, so on a phone "แก้ไข" opens the drawer that holds it.
  useEffect(() => { if (mobile && scope.open && !drawer) setDrawer(true); }, [mobile, scope.open, drawer]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drawer) return;
      // The first Escape closes the scope popover; the drawer stays.
      if (scopeOpen.current) return;
      closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);
  useStackLabels(main);
  useShortcuts({ go: (view) => navigate(viewPath(view)), toggleHelp: () => setHelp((open) => !open) });
  const goHome = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    navigate(viewPath("home"));
  };
  return (
    <div className="shell" data-drawer={drawer ? "open" : "closed"}>
      <aside className="sidebar" id="sidebar" ref={sidebar} inert={mobile && !drawer} onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a.nav, a.brandmark, a.sidebar-create")) return;
        // The closed drawer is inert and the clicked link sits inside it, so focus would fall to body: move it to the page.
        closeDrawer("main");
      }}>
        <div className="sidebar-head">
          <a href={viewPath("home")} className="brandmark" onClick={goHome}><i aria-hidden="true">A</i>Anjuna</a>
          <button type="button" className="sidebar-close" aria-label="ปิดเมนู" onClick={() => closeDrawer()}><X size={20} aria-hidden="true" /></button>
        </div>
        {/* The app passes the open action, so a second click on the button opens the wizard again like the Brands page button does. */}
        <a href={viewPath("new-brand")} className="btn pri sidebar-create" onClick={(e) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          onCreateBrand();
        }}>+ สร้างแบรนด์ใหม่</a>
        <div className="sidebar-scope"><BrandScopeControl /></div>
        {nav}
        <div className="sidebar-user">
          <div className="user-block">
            <span className="avatar" aria-hidden="true">{me.email.slice(0, 1)}</span>
            <div className="user-meta">
              <p className="user-email" title={me.email}>{me.email}</p>
              <p className="user-role">{me.role === "owner" ? "Owner" : "พนักงาน"}{me.account ? ` · ${me.account}` : ""}</p>
            </div>
          </div>
          <button type="button" className="signout" onClick={onSignOut}><LogOut size={18} aria-hidden="true" />ออกจากระบบ</button>
        </div>
      </aside>
      {drawer && <div className="scrim shell-scrim" onClick={() => closeDrawer()} />}
      <div className="main-col" inert={mobile && drawer}>
        <header className="mobile-bar">
          <button type="button" className="menu-btn" ref={menuButton} aria-label="เปิดเมนู" aria-controls="sidebar" aria-expanded={drawer} onClick={() => (drawer ? closeDrawer() : setDrawer(true))}><Menu size={20} aria-hidden="true" /></button>
          <a href={viewPath("home")} className="brandmark" onClick={goHome}><i aria-hidden="true">A</i>Anjuna</a>
        </header>
        <main className="content" ref={main} tabIndex={-1}>{children}</main>
      </div>
      <ShortcutsOverlay open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
