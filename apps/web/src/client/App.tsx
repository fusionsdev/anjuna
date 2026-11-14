import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, type NavCounts } from "./api";
import { resetAlertSession } from "./alerts-session";
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
import { RealtimeTab } from "./traffic/RealtimeTab";
import { ClientErrorsScreen } from "./screens/ClientErrors"; // spec traffic
import { roleAtLeast } from "@anjuna/contracts";
import { PANEL_ROLE_TABLE } from "../server/panel-roles";
import { brandChipFromSearch, navigate, parseRoute, routePath, templateStatusFromSearch, useRoute, useSearch, viewPath, withSearchParam, type View } from "./router";
import { AppShell, pageTitle } from "./components/AppShell";
import { SidebarNav, type NavItem } from "./components/SidebarNav";
import { SectionTabs } from "./components/SectionTabs";
import { SettingsSections } from "./components/SettingsSections";
import { NotifySettingsScreen } from "./screens/NotifySettings";
import { Spinner } from "./components/Spinner";
import { NAV_GROUPS, SIDEBAR_ENTRIES, activeTabId, groupOfView, sidebarEntryOf, visibleTabs, type SidebarBadge } from "./nav-groups";
import { Breadcrumb } from "./components/Breadcrumb";
import { MoneyScreen } from "./screens/Money";
import { SystemScreen } from "./screens/System";
import { BrandScopeProvider, useBrandScope } from "./useBrandScope";
import { ScopeSubtitle } from "./components/ScopeSubtitle";
import { scopeFromSearch, scopeToSearch } from "./brand-scope";

/** The pages that show brand data. Each carries the scope chip, and each filters its rows by the scope (PLAN A9). */
const SCOPED_VIEWS: ReadonlySet<string> = new Set(["home", "money", "brands", "campaigns", "realtime", "traffic", "funnel", "leads", "conversions", "alerts"]);

/** Hands the shell the `?scope=` value of a link's scope while it applies, null once the saved scope applies again. */
function ScopeLink({ onChange }: { onChange: (scope: string | null) => void }) {
  const { scope, fromUrl } = useBrandScope();
  const value = fromUrl ? scopeToSearch(scope) : null;
  useEffect(() => onChange(value), [value, onChange]);
  return null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardRequest, setWizardRequest] = useState(() => (parseRoute(window.location.pathname).view === "new-brand" ? 1 : 0));
  const route = useRoute();
  const view = route.view;
  // The list filters a Home card opens live in the query string: `/brands?chip=` and `/templates?status=`.
  const search = useSearch();
  // Sidebar badge counts. A count the panel could not read is null and shows no badge.
  const [counts, setCounts] = useState<Record<SidebarBadge, number | null>>({ brands_need_fix: null, tasks_open: null });

  // The Alerts screen bumps this after an acknowledge or close, so the badge reads the count again without a page change.
  const [countsTick, setCountsTick] = useState(0);
  const refreshCounts = useCallback(() => setCountsTick((tick) => tick + 1), []);
  // The scope of a `?scope=` link, sent with the counts read so the badges count what the pages show. ScopeLink keeps it current.
  const [linkScope, setLinkScope] = useState<string | null>(() => {
    const scope = scopeFromSearch(window.location.search);
    return scope ? scopeToSearch(scope) : null;
  });
  // The row count งานรอทำ reported while it is open. It wins over a server count, so the badge equals the rows on screen.
  const homeCount = useRef<number | null>(null);
  const onHomeCounted = useCallback((count: number) => {
    homeCount.current = count;
    setCounts((prev) => (prev.tasks_open === count ? prev : { ...prev, tasks_open: count }));
  }, []);
  // Opening งานรอทำ from another page reads the counts again, as the page reads its rows again.
  const lastView = useRef(view);
  useEffect(() => {
    if (view !== "home") homeCount.current = null;
    else if (lastView.current !== "home") refreshCounts();
    lastView.current = view;
  }, [view, refreshCounts]);

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
    const unknown: Record<SidebarBadge, number | null> = { brands_need_fix: null, tasks_open: null };
    if (!me) {
      setCounts(unknown);
      return;
    }
    let cancelled = false;
    const set = (next: Record<SidebarBadge, number | null>) => { if (!cancelled) setCounts(next); };
    // A failed read hides every badge: a count from other inputs would differ from the page it opens. The open งานรอทำ page's own count stays.
    api.navCounts(linkScope).then(
      (c: NavCounts) => set({ brands_need_fix: c.brands_need_fix, tasks_open: homeCount.current ?? c.tasks_open }),
      () => set({ ...unknown, tasks_open: homeCount.current }),
    );
    return () => { cancelled = true; };
    // Other page changes do not refetch: each call costs several core reads. Screens call refreshCounts after a write instead.
  }, [me, countsTick, linkScope]);
  // A page under a sidebar item names the item too, e.g. "ฟันเนล · เงิน · Control Panel".
  useEffect(() => {
    const entry = sidebarEntryOf(view);
    const group = entry && entry.id !== view ? ` · ${entry.label}` : "";
    document.title = me ? `${pageTitle[view]}${group} · Control Panel` : "Control Panel";
  }, [me, view]);

  if (loading) return <div className="center"><Spinner /></div>;
  if (!me) return <SignIn onSignedIn={refresh} />;

  const open = (id: Exclude<View, "not-found">) => {
    if (id === "new-brand") setWizardRequest((count) => count + 1);
    navigate(viewPath(id));
  };
  // Four items. Each marks itself current on every view it owns, so an older URL such as /funnel still selects เงิน.
  const badgeLabel: Record<SidebarBadge, (count: number) => string> = {
    // The count of rows the Brands page opens on (its default chip under the saved scope), so the label names no subset.
    brands_need_fix: (count) => `${count} แบรนด์`,
    // The rows of งานรอทำ, counted by the same task-rows.ts code the page renders.
    tasks_open: (count) => `${count} เรื่องรอทำ`,
  };
  const items: NavItem[] = SIDEBAR_ENTRIES.map((entry) => {
    const count = entry.badge ? counts[entry.badge] : null;
    return {
      id: entry.id, label: entry.label, icon: entry.icon, activeFor: [...entry.views],
      badge: entry.badge && count !== null && count > 0 ? { count, label: badgeLabel[entry.badge](count) } : null,
    };
  });
  const group = groupOfView(view);
  const entry = sidebarEntryOf(view);

  return (
    <BrandScopeProvider onSaved={refreshCounts}>
    <ScopeLink onChange={setLinkScope} />
    <AppShell
      me={me}
      onSignOut={async () => {
        await api.signOut().catch(() => undefined);
        resetAlertSession();
        setMe(null);
      }}
      nav={<SidebarNav items={items} current={view} onOpen={open} />}
      onCreateBrand={() => open("new-brand")}
    >
      {/* A page under a sidebar item names the item above it; the item's own page needs no trail. */}
      {entry && entry.id !== view && <Breadcrumb parent={{ id: entry.id, label: entry.label }} current={pageTitle[view]} onOpen={open} />}
      <div className={group?.id === "settings" ? "settings-shell" : "page-body"}>
      {group && (group.id === "settings"
        ? <SettingsSections tabs={visibleTabs(group, me.role)} active={activeTabId(group, view)} onSelect={open} />
        : <SectionTabs tabs={visibleTabs(group, me.role)} active={activeTabId(group, view)} onSelect={open} />)}
      {SCOPED_VIEWS.has(view) && <div className="scope-bar"><ScopeSubtitle /></div>}
      {view === "home" && <HomeScreen me={me} onCounted={onHomeCounted} />}
      {/* The money tabs sit below the money page; on each tab's own page they sit on top. */}
      {view === "money" && <><MoneyScreen me={me} onGo={open} onCountsChanged={refreshCounts} /><SectionTabs tabs={visibleTabs(NAV_GROUPS.money, me.role)} active={null} onSelect={open} /></>}
      {view === "system" && <SystemScreen me={me} onOpen={open} />}
      {(view === "brands" || view === "new-brand") && (
        <BrandLifecycle
          me={me}
          wizardRequest={wizardRequest}
          wizardRoute={view === "new-brand"}
          routeBrandId={route.view === "brands" ? route.brandId : null}
          onSelectBrand={(id) => navigate(routePath({ view: "brands", brandId: id }) + window.location.search, { replace: window.location.pathname === "/brands/new" })}
          onWizardClosed={() => { if (window.location.pathname === "/brands/new") navigate("/brands", { replace: true }); }}
          onNewBrand={() => open("new-brand")}
          routeChip={brandChipFromSearch(search)}
          // A chip click replaces the history entry: Back leaves the list, and returning to it restores the chip from the URL.
          onChip={(chip) => navigate(withSearchParam("chip", chip === "all" ? null : chip), { replace: true })}
          onCountsChanged={refreshCounts}
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
          onSelect={(id) => navigate(routePath({ view: "templates", templateId: id }) + window.location.search)}
          status={templateStatusFromSearch(search)}
          onStatus={(status) => navigate(withSearchParam("status", status === "all" ? null : status), { replace: true })}
          onCountsChanged={refreshCounts}
        />
      )}
      {view === "builder-keys" && <BuilderKeysScreen me={me} />}
      {view === "funnel" && <FunnelScreen />}
      {/* spec traffic */}
      {view === "realtime" && <RealtimeTab />}
      {view === "traffic" && <TrafficScreen />}
      {view === "errors" && <ClientErrorsScreen me={me} />}
      {view === "conversions" && <ConversionsScreen me={me} />}
      {view === "alerts" && <AlertsScreen me={me} onChanged={refreshCounts} />}
      {view === "mailing" && <MailingScreen />}
      {/* spec leads */}
      {/* The list stays mounted and holds its filter while a lead is open in the right panel. The filter query string stays in the URL. */}
      {route.view === "leads" && (
        <LeadsScreen
          me={me}
          selectedId={route.leadId}
          onSelect={(id) => navigate(routePath({ view: "leads", leadId: id }) + window.location.search)}
          onClose={() => navigate(routePath({ view: "leads", leadId: null }) + window.location.search)}
        />
      )}
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
      {/* Owner only: the section is not in the list for an employee, and the server answers 403 to one as well. */}
      {view === "notify-settings" && (roleAtLeast(me.role, PANEL_ROLE_TABLE.viewSettings)
        ? <NotifySettingsScreen />
        : <NotFound title="สำหรับ Owner เท่านั้น" hint="บัญชีพนักงานเปิดหน้านี้ไม่ได้" />)}
      {view === "not-found" && <NotFound title="ไม่พบหน้านี้ (Page not found)" hint={route.view === "not-found" ? route.path : undefined} />}
      </div>
    </AppShell>
    </BrandScopeProvider>
  );
}
