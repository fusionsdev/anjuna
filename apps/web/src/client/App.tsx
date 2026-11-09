import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me, type NavCounts } from "./api";
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
import { AdAllocationScreen } from "./screens/AdAllocation";
import { TrafficScreen } from "./screens/Traffic"; // spec traffic
import { ClientErrorsScreen } from "./screens/ClientErrors"; // spec traffic
import { roleAtLeast } from "@anjuna/contracts";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import { navigate, parseRoute, routePath, useRoute, viewPath, type View } from "./router";
import { AppShell, pageTitle } from "./components/AppShell";
import { SidebarNav, type NavItem } from "./components/SidebarNav";
import { SectionTabs } from "./components/SectionTabs";
import { Spinner } from "./components/Spinner";
import { NAV_GROUPS, SIDEBAR_ENTRIES, activeTabId, groupOfView, groupViews, visibleTabs, type SidebarBadge } from "./nav-groups";
import { BrandScopeProvider } from "./useBrandScope";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardRequest, setWizardRequest] = useState(() => (parseRoute(window.location.pathname).view === "new-brand" ? 1 : 0));
  const route = useRoute();
  const view = route.view;
  // Sidebar badge counts. A count the panel could not read is null and shows no badge.
  const [counts, setCounts] = useState<Record<SidebarBadge, number | null>>({ brands_need_fix: null, templates_awaiting: null, alerts_open: null });

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
    const unknown: Record<SidebarBadge, number | null> = { brands_need_fix: null, templates_awaiting: null, alerts_open: null };
    if (!me) {
      setCounts(unknown);
      return;
    }
    let cancelled = false;
    const set = (next: Record<SidebarBadge, number | null>) => { if (!cancelled) setCounts(next); };
    api.navCounts().then((c: NavCounts) => set({ brands_need_fix: c.brands_need_fix, templates_awaiting: c.templates_awaiting, alerts_open: c.alerts_open }), () =>
      // Without /api/nav/counts only the alerts badge can be filled, from the alerts report.
      api.alerts().then((report) => {
        const alerts = [report.conversion_stalled, report.brands_without_postbacks, report.submit_error_rate, report.reject_rate, report.click_risk,
          ...(report.ad_spend_unallocated ? [report.ad_spend_unallocated] : [])]
          .filter(({ state }) => state === "warn" || state === "alert").length;
        set({ ...unknown, alerts_open: alerts });
      }).catch(() => set(unknown))); // An unavailable report must not look like zero active alerts.
    return () => { cancelled = true; };
  }, [me, view]);
  useEffect(() => { document.title = me ? `${pageTitle[view]} · Control Panel` : "Control Panel"; }, [me, view]);

  if (loading) return <div className="center"><Spinner /></div>;
  if (!me) return <SignIn onSignedIn={refresh} />;

  const open = (id: Exclude<View, "not-found">) => {
    if (id === "new-brand") setWizardRequest((count) => count + 1);
    navigate(viewPath(id));
  };
  // Nine flat items. A page that holds section tabs marks its item on every view it owns and opens the first tab the role may use.
  // A thin divider sets off the watch and owner sections; an item the role may not use is left out.
  const badgeLabel: Record<SidebarBadge, (count: number) => string> = {
    brands_need_fix: (count) => `${count} แบรนด์ที่ต้องแก้`,
    templates_awaiting: (count) => `${count} เทมเพลตรออนุมัติ`,
    alerts_open: (count) => `${count} รายการที่ต้องจัดการ`,
  };
  const shown = SIDEBAR_ENTRIES.flatMap((entry) => {
    if (entry.minRole && !roleAtLeast(me.role, entry.minRole)) return [];
    const group = entry.group ? NAV_GROUPS[entry.group] : null;
    const tabs = group ? visibleTabs(group, me.role) : null;
    if (tabs && tabs.length === 0) return [];
    const count = entry.badge ? counts[entry.badge] : null;
    return [{ entry, item: {
      id: entry.id, label: entry.label, icon: entry.icon, tag: entry.tag,
      activeFor: group ? groupViews(group) : [entry.id], target: tabs?.[0]?.id ?? entry.id,
      badge: entry.badge && count !== null && count > 0 ? { count, label: badgeLabel[entry.badge](count) } : null,
    } as NavItem }];
  });
  const items: NavItem[] = shown.map(({ entry, item }, index) => ({ ...item, dividerBefore: index > 0 && shown[index - 1]!.entry.section !== entry.section }));
  const group = groupOfView(view);

  return (
    <BrandScopeProvider>
    <AppShell
      me={me}
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
      {/* T13 A3: owner only; the server answers 403 to an employee as well */}
      {view === "ad-allocation" && (roleAtLeast(me.role, PANEL_ROLE_TABLE.adAllocation)
        ? <AdAllocationScreen />
        : <NotFound title="สำหรับ Owner เท่านั้น" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้" />)}
      {view === "not-found" && <NotFound title="ไม่พบหน้านี้ (Page not found)" hint={route.view === "not-found" ? route.path : undefined} />}
    </AppShell>
    </BrandScopeProvider>
  );
}
