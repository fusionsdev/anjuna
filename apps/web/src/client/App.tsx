import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "./api";
import { AlertsScreen } from "./screens/Alerts";
import { AuditScreen } from "./screens/Audit";
import { BrandLifecycle } from "./screens/BrandLifecycle";
import { BrandTimelineScreen } from "./screens/BrandTimeline";
import { ConversionsScreen } from "./screens/Conversions";
import { DeploysScreen } from "./screens/Deploys";
import { CampaignsScreen } from "./screens/Campaigns";
import { AdkitTerminalScreen } from "./screens/AdkitTerminal";
import { FunnelScreen } from "./screens/Funnel";
import { HomeScreen } from "./screens/Home";
import { LeadDetailScreen } from "./screens/LeadDetail";
import { LeadsScreen } from "./screens/Leads";
import { MailingScreen } from "./screens/Mailing";
import { SuppressionsScreen } from "./screens/Suppressions";
import { SignIn } from "./screens/SignIn";
import { BuilderKeysScreen } from "./screens/BuilderKeys";
import { NotFound } from "./screens/NotFound";
import { TemplatesScreen } from "./screens/Templates";
import { UsersScreen } from "./screens/Users";
import { SettingsScreen } from "./screens/Settings";
import { TrafficScreen } from "./screens/Traffic"; // spec traffic
import { ClientErrorsScreen } from "./screens/ClientErrors"; // spec traffic
import { roleAtLeast } from "@anjuna/contracts";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import { navigate, parseRoute, routePath, useRoute, viewPath, type View } from "./router";
import { AppShell, pageTitle } from "./components/AppShell";
import { SidebarNav, type NavItem } from "./components/SidebarNav";
import { SectionTabs } from "./components/SectionTabs";
import { Spinner } from "./components/Spinner";
import { NAV_GROUPS, activeTabId, groupOfView, groupViews, visibleTabs, type NavGroup } from "./nav-groups";

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
  // One item per group. The settings group stays for an employee through the tabs they may open, and its link opens the first of them.
  const groupItem = (group: NavGroup): NavItem & { show: boolean } => {
    const tabs = visibleTabs(group, me.role);
    return { id: group.id, label: group.label, show: tabs.length > 0, activeFor: groupViews(group), target: tabs[0]?.id };
  };
  const nav: (NavItem & { show: boolean })[] = [
    { id: "home", label: "หน้าแรก", show: true },
    groupItem(NAV_GROUPS.brands),
    { id: "templates", label: "เทมเพลต", show: true },
    groupItem(NAV_GROUPS.traffic),
    groupItem(NAV_GROUPS.leads),
    { id: "alerts", label: "การแจ้งเตือน", show: true, badge: alertCount !== null ? { count: alertCount, label: `${alertCount} รายการที่ต้องจัดการ` } : null },
    groupItem(NAV_GROUPS.settings),
  ];
  const items: NavItem[] = nav.filter((n) => n.show);
  const group = groupOfView(view);

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
      {group && <SectionTabs tabs={visibleTabs(group, me.role)} active={activeTabId(group, view)} onSelect={open} />}
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
      {/* spec timeline */}
      {route.view === "brand-timeline" && <BrandTimelineScreen me={me} brandId={route.brandId} />}
      {view === "deploys" && <DeploysScreen me={me} />}
      {view === "campaigns" && <CampaignsScreen me={me} />}
      {view === "adkit-terminal" && <AdkitTerminalScreen me={me} />}
      {view === "templates" && (
        <TemplatesScreen
          me={me}
          selectedId={route.view === "templates" ? route.templateId : null}
          onSelect={(id) => navigate(routePath({ view: "templates", templateId: id }))}
        />
      )}
      {view === "builder-keys" && <BuilderKeysScreen me={me} />}
      {view === "funnel" && <FunnelScreen />}
      {/* spec traffic */}
      {view === "traffic" && <TrafficScreen />}
      {view === "errors" && <ClientErrorsScreen me={me} />}
      {view === "conversions" && <ConversionsScreen me={me} />}
      {view === "alerts" && <AlertsScreen />}
      {view === "mailing" && <MailingScreen />}
      {/* spec leads */}
      {/* The detail entry's history state keeps the list's filter query string for the Back button. */}
      {route.view === "leads" && (route.leadId
        ? <LeadDetailScreen me={me} leadId={route.leadId} onBack={() => {
            const search = (window.history.state as { leadsSearch?: unknown } | null)?.leadsSearch;
            navigate(routePath({ view: "leads", leadId: null }) + (typeof search === "string" && search.startsWith("?") ? search : ""));
          }} />
        : <LeadsScreen me={me} selectedId={null} onSelect={(id) => {
            const leadsSearch = window.location.search;
            const path = routePath({ view: "leads", leadId: id });
            navigate(path);
            window.history.replaceState({ leadsSearch }, "", path);
          }} />)}
      {view === "suppressions" && <SuppressionsScreen me={me} />}
      {view === "audit" && <AuditScreen me={me} />}
      {view === "users" && (me.role === "owner"
        ? <UsersScreen me={me} />
        : <NotFound title="สำหรับ Owner เท่านั้น (Owner only)" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้ (An employee account cannot open this page.)" />)}
      {/* spec settings */}
      {view === "settings" && (roleAtLeast(me.role, PANEL_ROLE_TABLE.viewSettings)
        ? <SettingsScreen me={me} />
        : <NotFound title="สำหรับ Owner เท่านั้น (Owner only)" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้ (An employee account cannot open this page.)" />)}
      {view === "not-found" && <NotFound title="ไม่พบหน้านี้ (Page not found)" hint={route.view === "not-found" ? route.path : undefined} />}
    </AppShell>
  );
}
