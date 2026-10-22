import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api";
import { AlertsScreen } from "./screens/Alerts";
import { AuditScreen } from "./screens/Audit";
import { BrandLifecycle } from "./screens/BrandLifecycle";
import { FunnelScreen } from "./screens/Funnel";
import { HomeScreen } from "./screens/Home";
import { MailingScreen } from "./screens/Mailing";
import { SignIn } from "./screens/SignIn";
import { BuilderKeysScreen } from "./screens/BuilderKeys";
import { TemplatesScreen } from "./screens/Templates";
import { UsersScreen } from "./screens/Users";

type View = "home" | "brands" | "new-brand" | "templates" | "funnel" | "alerts" | "mailing" | "audit" | "users" | "builder-keys";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardRequest, setWizardRequest] = useState(0);
  const [view, setView] = useState<View>(() => (window.location.hash.startsWith("#templates") ? "templates" : "home"));
  const [alertCount, setAlertCount] = useState<number | null>(null);

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
  useEffect(() => {
    if (!me) {
      setAlertCount(null);
      return;
    }
    let cancelled = false;
    api.alerts().then((report) => {
      const count = [report.conversion_stalled, report.brands_without_postbacks, report.submit_error_rate, report.reject_rate, report.click_risk]
        .filter(({ state }) => state === "warn" || state === "alert").length;
      if (!cancelled) setAlertCount(count);
    }).catch(() => {
      // An unavailable report must not look like zero active alerts.
      if (!cancelled) setAlertCount(null);
    });
    return () => { cancelled = true; };
  }, [me, view]);
  // A dashboard_url opened in a tab that already holds the panel changes only the hash.
  useEffect(() => {
    const onHash = () => { if (window.location.hash.startsWith("#templates")) setView("templates"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (loading) return <div className="center muted">กำลังโหลด…</div>;
  if (!me) return <SignIn onSignedIn={refresh} />;

  const open = (id: View) => {
    if (id === "new-brand") {
      setView("brands");
      setWizardRequest((count) => count + 1);
    } else setView(id);
  };
  const nav: { id: View; label: string; show: boolean; gap?: boolean }[] = [
    { id: "home", label: "หน้าแรก", show: true },
    { id: "brands", label: "แบรนด์", show: true },
    { id: "new-brand", label: "สร้างแบรนด์ใหม่", show: true },
    { id: "templates", label: "เทมเพลต", show: true },
    { id: "funnel", label: "ฟันเนล", show: true, gap: true },
    { id: "alerts", label: "การแจ้งเตือน", show: true },
    { id: "mailing", label: "รายชื่ออีเมล", show: true },
    { id: "audit", label: "ประวัติการแก้ไข", show: true, gap: true },
    { id: "users", label: "ผู้ใช้", show: me.role === "owner" },
    { id: "builder-keys", label: "คีย์ Builder", show: true },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brandmark"><i aria-hidden="true" />Anjuna</div>
        <nav aria-label="เมนูหลัก">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <button
                key={n.id}
                type="button"
                className={`nav${n.gap ? " navgap" : ""}`}
                aria-current={view === n.id ? "page" : undefined}
                onClick={() => open(n.id)}
              >
                <span>{n.label}</span>
                {n.id === "alerts" && alertCount !== null && <b aria-label={`${alertCount} รายการที่ต้องจัดการ`}>{alertCount}</b>}
              </button>
            ))}
        </nav>
        <div className="me">
          <div className="who">
            <div>{me.email}</div>
            <div>{me.role === "owner" ? "Owner" : "พนักงาน"}</div>
          </div>
          <button
            type="button"
            className="nav signout"
            onClick={async () => {
              await api.signOut().catch(() => undefined);
              setMe(null);
            }}
          >
            ออกจากระบบ (Sign out)
          </button>
        </div>
      </aside>
      <main className="content">
        {view === "home" && <HomeScreen me={me} onGo={open} />}
        {view === "brands" && <BrandLifecycle me={me} wizardRequest={wizardRequest} />}
        {view === "templates" && <TemplatesScreen me={me} />}
        {view === "builder-keys" && <BuilderKeysScreen me={me} />}
        {view === "funnel" && <FunnelScreen />}
        {view === "alerts" && <AlertsScreen />}
        {view === "mailing" && <MailingScreen />}
        {view === "audit" && <AuditScreen me={me} />}
        {view === "users" && me.role === "owner" && <UsersScreen me={me} />}
      </main>
    </div>
  );
}
