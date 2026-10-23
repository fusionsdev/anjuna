import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Me } from "../api";
import type { View } from "../router";

export const pageTitle: Record<View, string> = {
  home: "หน้าแรก", brands: "แบรนด์", "new-brand": "สร้างแบรนด์ใหม่", templates: "เทมเพลต", funnel: "ฟันเนล",
  alerts: "การแจ้งเตือน", deploys: "ประวัติการติดตั้ง", mailing: "รายชื่ออีเมล", audit: "ประวัติการแก้ไข", users: "ผู้ใช้", "builder-keys": "คีย์ Builder",
  leads: "ลีด (Leads)", suppressions: "อีเมลที่บล็อก (Suppressions)",
  "not-found": "ไม่พบหน้านี้",
};

const MOBILE_QUERY = "(max-width: 767px)";

/** True while the viewport is at the mobile breakpoint. jsdom has no matchMedia, so it reads false there. */
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

export function AppShell({ me, title, nav, onSignOut, children }: { me: Me; title: string; nav: ReactNode; onSignOut: () => void; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const mobile = useMobileViewport();
  const menuButton = useRef<HTMLButtonElement>(null);
  const userButton = useRef<HTMLButtonElement>(null);
  const userMenu = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  // Where focus lands after the drawer closes. The page behind is inert while the drawer is open, so the move runs after the commit.
  const afterClose = useRef<"menu" | "main">("menu");
  const drawerWasOpen = useRef(false);
  const closeDrawer = (focus: "menu" | "main" = "menu") => { afterClose.current = focus; setDrawer(false); };
  useEffect(() => {
    if (drawer) sidebar.current?.querySelector<HTMLElement>("a.nav")?.focus();
    else if (drawerWasOpen.current) (afterClose.current === "main" ? main : menuButton).current?.focus();
    drawerWasOpen.current = drawer;
  }, [drawer]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawer) closeDrawer();
      else if (menu) userButton.current?.focus();
      setMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, menu]);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => { if (!userMenu.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);
  return (
    <div className="shell" data-drawer={drawer ? "open" : "closed"}>
      <aside className="sidebar" id="sidebar" ref={sidebar} inert={mobile && !drawer} onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a.nav")) return;
        // The closed drawer is inert and the clicked link sits inside it, so focus would fall to body: move it to the page.
        closeDrawer("main");
      }}>
        <div className="brandmark"><i aria-hidden="true" />Anjuna</div>
        {nav}
      </aside>
      {drawer && <div className="scrim shell-scrim" onClick={() => closeDrawer()} />}
      <div className="main-col" inert={mobile && drawer}>
        <header className="topbar">
          <button type="button" className="menu-btn" ref={menuButton} aria-label="เมนู (Menu)" aria-controls="sidebar" aria-expanded={drawer} onClick={() => (drawer ? closeDrawer() : setDrawer(true))}>☰</button>
          <span className="topbar-title">{title}</span>
          {me.account && <span className="pill p-blue env-badge">{me.account}</span>}
          <div className="user-menu" ref={userMenu}>
            <button type="button" className="btn" ref={userButton} aria-controls="user-pop" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{me.email}</button>
            {menu && (
              <div className="user-pop" id="user-pop">
                <div className="who"><div>{me.email}</div><div>{me.role === "owner" ? "Owner" : "พนักงาน"}</div></div>
                <button type="button" className="nav signout" onClick={onSignOut}>ออกจากระบบ (Sign out)</button>
              </div>
            )}
          </div>
        </header>
        <main className="content" ref={main} tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
