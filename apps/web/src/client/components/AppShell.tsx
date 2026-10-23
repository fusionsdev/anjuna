import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Me } from "../api";
import type { View } from "../router";

export const pageTitle: Record<View, string> = {
  home: "หน้าแรก", brands: "แบรนด์", "new-brand": "สร้างแบรนด์ใหม่", templates: "เทมเพลต", funnel: "ฟันเนล",
  alerts: "การแจ้งเตือน", mailing: "รายชื่ออีเมล", audit: "ประวัติการแก้ไข", users: "ผู้ใช้", "builder-keys": "คีย์ Builder",
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
  const userMenu = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The closed drawer is inert, so focus inside it would be lost: send it back to the button that opened it.
      if (drawer) menuButton.current?.focus();
      setDrawer(false);
      setMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => { if (!userMenu.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);
  return (
    <div className="shell" data-drawer={drawer ? "open" : "closed"}>
      <aside className="sidebar" id="sidebar" inert={mobile && !drawer} onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a.nav")) return;
        // The closed drawer is inert and the clicked link sits inside it, so focus would fall to body: move it to the page.
        if (drawer) main.current?.focus();
        setDrawer(false);
      }}>
        <div className="brandmark"><i aria-hidden="true" />Anjuna</div>
        {nav}
      </aside>
      {drawer && <div className="scrim shell-scrim" onClick={() => setDrawer(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button type="button" className="menu-btn" ref={menuButton} aria-label="เมนู (Menu)" aria-controls="sidebar" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>☰</button>
          <span className="topbar-title">{title}</span>
          {me.account && <span className="pill p-blue env-badge">{me.account}</span>}
          <div className="user-menu" ref={userMenu}>
            <button type="button" className="btn" aria-controls="user-pop" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{me.email}</button>
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
