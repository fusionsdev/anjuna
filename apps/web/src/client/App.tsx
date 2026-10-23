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
import { NotFound } from "./screens/NotFound";
import { TemplatesScreen } from "./screens/Templates";
import { UsersScreen } from "./screens/Users";
import { navigate, parseRoute, routePath, useRoute, viewPath, type View } from "./router";
import { AppShell, pageTitle } from "./components/AppShell";
import { SidebarNav, type NavItem } from "./components/SidebarNav";
import { Spinner } from "./components/Spinner";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardRequest, setWizardRequest] = useState(() => (parseRoute(window.location.pathname).view === "new-brand" ? 1 : 0));
  const route = useRoute();
  const view = route.view;
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
  useEffect(() => { document.title = me ? `${pageTitle[view]} · Control Panel` : "Control Panel"; }, [me, view]);

  if (loading) return <div className="center"><Spinner /></div>;
  if (!me) return <SignIn onSignedIn={refresh} />;

  const open = (id: Exclude<View, "not-found">) => {
    if (id === "new-brand") setWizardRequest((count) => count + 1);
    navigate(viewPath(id));
  };
  const nav: (NavItem & { show: boolean })[] = [
    { id: "home", label: "หน้าแรก", show: true },
    { id: "brands", label: "แบรนด์", show: true },
    { id: "new-brand", label: "สร้างแบรนด์ใหม่", show: true },
    { id: "templates", label: "เทมเพลต", show: true },
    { id: "funnel", label: "ฟันเนล", show: true, gap: true },
    { id: "alerts", label: "การแจ้งเตือน", show: true, badge: alertCount !== null ? { count: alertCount, label: `${alertCount} รายการที่ต้องจัดการ` } : null },
    { id: "mailing", label: "รายชื่ออีเมล", show: true },
    { id: "audit", label: "ประวัติการแก้ไข", show: true, gap: true },
    { id: "users", label: "ผู้ใช้", show: me.role === "owner" },
    { id: "builder-keys", label: "คีย์ Builder", show: true },
  ];
  const items: NavItem[] = nav.filter((n) => n.show);

  return (
    <AppShell
      me={me}
      title={pageTitle[view]}
      onSignOut={async () => {
        await api.signOut().catch(() => undefined);
        setMe(null);
      }}
      nav={<SidebarNav items={items} current={view} onOpen={open} />}
    >
      {view === "home" && <HomeScreen me={me} onGo={open} />}
      {(view === "brands" || view === "new-brand") && (
        <BrandLifecycle
          me={me}
          wizardRequest={wizardRequest}
          wizardRoute={view === "new-brand"}
          routeBrandId={route.view === "brands" ? route.brandId : null}
          onSelectBrand={(id) => navigate(routePath({ view: "brands", brandId: id }), { replace: window.location.pathname === "/brands/new" })}
          onWizardClosed={() => { if (window.location.pathname === "/brands/new") navigate("/brands", { replace: true }); }}
          onNewBrand={() => open("new-brand")}
        />
      )}
      {view === "templates" && (
        <TemplatesScreen
          me={me}
          selectedId={route.view === "templates" ? route.templateId : null}
          onSelect={(id) => navigate(routePath({ view: "templates", templateId: id }))}
        />
      )}
      {view === "builder-keys" && <BuilderKeysScreen me={me} />}
      {view === "funnel" && <FunnelScreen />}
      {view === "alerts" && <AlertsScreen />}
      {view === "mailing" && <MailingScreen />}
      {view === "audit" && <AuditScreen me={me} />}
      {view === "users" && (me.role === "owner"
        ? <UsersScreen me={me} />
        : <NotFound title="สำหรับ Owner เท่านั้น (Owner only)" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้ (An employee account cannot open this page.)" />)}
      {view === "not-found" && <NotFound title="ไม่พบหน้านี้ (Page not found)" hint={route.view === "not-found" ? route.path : undefined} />}
    </AppShell>
  );
}
