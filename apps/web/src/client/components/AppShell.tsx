import { type ReactNode, useEffect, useState } from "react";
import type { Me } from "../api";
import type { View } from "../router";

export const pageTitle: Record<View, string> = {
  home: "หน้าแรก", brands: "แบรนด์", "new-brand": "สร้างแบรนด์ใหม่", templates: "เทมเพลต", funnel: "ฟันเนล",
  alerts: "การแจ้งเตือน", mailing: "รายชื่ออีเมล", audit: "ประวัติการแก้ไข", users: "ผู้ใช้", "builder-keys": "คีย์ Builder",
  "not-found": "ไม่พบหน้านี้",
};

export function AppShell({ me, title, nav, onSignOut, children }: { me: Me; title: string; nav: ReactNode; onSignOut: () => void; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setDrawer(false); setMenu(false); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="shell" data-drawer={drawer ? "open" : "closed"}>
      <aside className="sidebar" id="sidebar" onClick={(e) => { if ((e.target as HTMLElement).closest("a.nav")) setDrawer(false); }}>
        <div className="brandmark"><i aria-hidden="true" />Anjuna</div>
        {nav}
      </aside>
      {drawer && <div className="scrim shell-scrim" onClick={() => setDrawer(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button type="button" className="menu-btn" aria-label="เมนู (Menu)" aria-controls="sidebar" aria-expanded={drawer} onClick={() => setDrawer((v) => !v)}>☰</button>
          <span className="topbar-title">{title}</span>
          {me.account && <span className="pill p-blue env-badge">{me.account}</span>}
          <div className="user-menu">
            <button type="button" className="btn" aria-controls="user-pop" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{me.email}</button>
            {menu && (
              <div className="user-pop" id="user-pop">
                <div className="who"><div>{me.email}</div><div>{me.role === "owner" ? "Owner" : "พนักงาน"}</div></div>
                <button type="button" className="nav signout" onClick={onSignOut}>ออกจากระบบ (Sign out)</button>
              </div>
            )}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
