import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api";
import { AlertsScreen } from "./screens/Alerts";
import { AuditScreen } from "./screens/Audit";
import { BrandLifecycle } from "./screens/BrandLifecycle";
import { FunnelScreen } from "./screens/Funnel";
import { MailingScreen } from "./screens/Mailing";
import { SignIn } from "./screens/SignIn";
import { UsersScreen } from "./screens/Users";

type View = "brands" | "funnel" | "alerts" | "mailing" | "audit" | "users";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("brands");

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  if (loading) return <div className="center muted">กำลังโหลด…</div>;
  if (!me) return <SignIn onSignedIn={refresh} />;

  const nav: { id: View; label: string; show: boolean }[] = [
    { id: "brands", label: "แบรนด์ (Brands)", show: true },
    { id: "funnel", label: "รายงานฟันเนล (Funnel)", show: true },
    { id: "alerts", label: "การแจ้งเตือน (Alerts)", show: true },
    { id: "mailing", label: "สถานะเมล (Mailing)", show: true },
    { id: "audit", label: "ประวัติการเปลี่ยนแปลง (Audit log)", show: true },
    { id: "users", label: "ผู้ใช้ (Users)", show: me.role === "owner" },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark">Control Panel</div>
        <nav>
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <button key={n.id} className={view === n.id ? "nav active" : "nav"} onClick={() => setView(n.id)}>
                {n.label}
              </button>
            ))}
        </nav>
        <div className="me">
          <div className="muted small">{me.email}</div>
          <span className={`pill ${me.role}`}>{me.role === "owner" ? "Owner" : "Employee"}</span>
          <button
            className="link"
            onClick={async () => {
              await api.signOut().catch(() => undefined);
              setMe(null);
            }}
          >
            ออกจากระบบ
          </button>
        </div>
      </aside>
      <main className="content">
        {view === "brands" && <BrandLifecycle me={me} />}
        {view === "funnel" && <FunnelScreen />}
        {view === "alerts" && <AlertsScreen />}
        {view === "mailing" && <MailingScreen />}
        {view === "audit" && <AuditScreen me={me} />}
        {view === "users" && me.role === "owner" && <UsersScreen me={me} />}
      </main>
    </div>
  );
}
