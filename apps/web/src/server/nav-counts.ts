import { ALERT_STATES_PAGE_MAX, AlertStatesResponse, TEMPLATE_VERSION_REVIEW_STATUS, UserPrefs, roleAtLeast, type AdminRequestContext, type AlertStateRow, type AlertsReportResponse, type BrandSummary, type ConversionsReportResponse, type FunnelReportResponse, type SpendReportResponse, type TemplateVersionStatusName } from "@anjuna/contracts";
import type { Env } from "./env.js";
import { callCore } from "./core.js";
import { lifecycleBrandRows, readBrandChecklists } from "./lifecycle.js";
import { coreNotificationRequest } from "./alerts-state.js";
import { DEFAULT_SCOPE, scopeFromPrefs, scopeFromSearch, type BrandScope } from "../client/brand-scope.js";
import { scopeAlerts } from "../client/home-metrics.js";
import { awaitingApproval, listedInBrands, scopeTest } from "../client/task-counts.js";
import { hostnameBrand, openAlertCount } from "../client/alert-incidents.js";
import { CLICK_PERIOD, DEAD_PERIOD, clickRange, clickTotals, taskRows } from "../client/task-rows.js";
import type { ChecklistEntry } from "../client/task-counts.js";

/** The brand scope the user saved (GET /api/me/prefs). The client passes a `?scope=` link's scope instead while one is active. */
async function savedScope(env: Env, ctx: AdminRequestContext): Promise<BrandScope> {
  const row = await env.AUTH.prepare("SELECT value_json FROM user_prefs WHERE user_id=?1 AND key='brand_scope'").bind(ctx.actor_id).first<{ value_json: string }>();
  if (!row) return DEFAULT_SCOPE;
  try {
    const parsed = UserPrefs.shape.brand_scope.safeParse(JSON.parse(row.value_json));
    return parsed.success ? scopeFromPrefs(parsed.data) : DEFAULT_SCOPE;
  } catch {
    return DEFAULT_SCOPE;
  }
}

/** Every stored alert state, read page by page like the Alerts screen. Null when a page fails, is malformed, or the cursor does not move. */
async function alertStates(env: Env, ctx: AdminRequestContext): Promise<Map<string, AlertStateRow> | null> {
  const rows = new Map<string, AlertStateRow>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: String(ALERT_STATES_PAGE_MAX) });
    if (cursor !== null) query.set("cursor", cursor);
    const response = await coreNotificationRequest(env, ctx, `/admin/alerts/state?${query}`);
    if (!response.ok) return null;
    const parsed = AlertStatesResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;
    const body = parsed.data;
    for (const row of body.rows) {
      const held = rows.get(row.alert_key);
      if (!held || held.updated_at <= row.updated_at) rows.set(row.alert_key, row);
    }
    if (body.next_cursor === null) return rows;
    if (body.next_cursor === cursor) return null;
    cursor = body.next_cursor;
  }
  return null;
}

/**
 * GET /api/nav/counts: each badge is the row count of the page it opens, computed with the predicates that page filters with.
 * brands_need_fix: the rows /brands opens on (chip ทั้งหมด) under the saved scope. The wire name stays for the client contract.
 * templates_awaiting: the versions under /templates?status=awaiting_approval.
 * alerts_open: the เปิดอยู่ count of /alerts, from the same report, stored states, domains and scope the screen reads.
 *   Null when the report or a state page fails, so the client hides that badge and keeps the other two.
 * tasks_open: the rows of งานรอทำ, built by taskRows (task-rows.ts) from the same reads the page makes: the alerts report and
 *   states, the brands under the scope, the batch checklist, the templates, the dead conversions and, for the owner, today's
 *   spend and funnel clicks. Null when one fails, a failed checklist read included.
 * `?scope=` (all, active or brand ids, as in a link) replaces the saved scope, so the badge matches a page opened from such a link.
 * A failed factory or core brand read answers 502: the brands badge cannot be counted.
 */
export async function handleNavCountsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/nav/counts" || request.method !== "GET") return undefined;
  const owner = roleAtLeast(ctx.actor_role, "owner");
  const linkScope = scopeFromSearch(new URL(request.url).search);
  const range = clickRange(new Date());
  const [brands, runtime, templates, report, states, scope, checklistRead, deadRead, spendRead, funnelRead] = await Promise.all([
    lifecycleBrandRows(env, ctx),
    callCore(env, ctx, { endpoint: "listBrands" }),
    env.FACTORY.prepare("SELECT v.template_version_id, t.name, v.version, v.status, t.archived_at IS NOT NULL AS archived FROM template_versions v JOIN templates t ON t.template_id=v.template_id").all<{ template_version_id: string; name: string; version: number; status: string; archived: number }>(),
    callCore(env, ctx, { endpoint: "alertsReport" }),
    alertStates(env, ctx),
    linkScope ?? savedScope(env, ctx),
    // A thrown checklist read leaves tasks_open unknown and keeps the other badges.
    readBrandChecklists(env, ctx).catch(() => null),
    // The row exists when totals.dead is above 0, so one row is enough to count it.
    callCore(env, ctx, { endpoint: "conversionsReport", query: new URLSearchParams({ period: DEAD_PERIOD, status: "dead", limit: "1" }) }),
    // The click loss row is the owner's: an employee has no spend report.
    owner ? callCore(env, ctx, { endpoint: "spendReport", query: new URLSearchParams({ period: CLICK_PERIOD }) }) : null,
    owner ? callCore(env, ctx, { endpoint: "funnelReport", query: new URLSearchParams(range) }) : null,
  ]);
  if (brands.core_error) return Response.json({ error: "unavailable" }, { status: 502 });
  // Core's brand list gives the paused status and the hostnames. Like the screens, a failed read leaves both unknown and counts on.
  const runtimeBrands = runtime.status === 200 ? (runtime.body as { brands: BrandSummary[] }).brands : [];
  const statusOf = new Map(runtimeBrands.map((brand) => [brand.brand_id, brand.status as string]));
  const brandsShown = brands.brands.filter((brand) => listedInBrands(scope, brand, statusOf.get(brand.brand_id))).length;
  const templateRows = templates.results.map((row) => ({
    template_version_id: row.template_version_id, name: row.name, version: row.version,
    status: TEMPLATE_VERSION_REVIEW_STATUS[row.status as TemplateVersionStatusName] ?? "checking", archived: Boolean(row.archived),
  }));
  const templatesAwaiting = templateRows.filter(awaitingApproval).length;
  // brand_id to domain in the order the Alerts screen builds it (buildBrandLabels): the factory domain wins over core's hostname.
  const domains = new Map<string, string>();
  for (const brand of runtimeBrands) if (brand.hostnames?.[0]) domains.set(brand.brand_id, brand.hostnames[0]);
  for (const brand of brands.brands) if (brand.hostnames[0]) domains.set(brand.brand_id, brand.hostnames[0]);
  const inScope = scopeTest(scope, brands.brands, (id) => statusOf.get(id));
  const scopedReport = report.status === 200 ? scopeAlerts(report.body as AlertsReportResponse, inScope) : null;
  const alertsOpen = scopedReport && states !== null ? openAlertCount(scopedReport, states, hostnameBrand(domains)) : null;
  const checklistBody = checklistRead?.ok ? ((await checklistRead.json().catch(() => null)) as { brands?: Record<string, ChecklistEntry> } | null) : null;
  const checklists = checklistBody?.brands ?? null;
  // Null for an employee (no row) and for a failed read (tasks_open unknown below).
  const clicks = spendRead?.status === 200 && funnelRead?.status === 200
    ? clickTotals(spendRead.body as SpendReportResponse, funnelRead.body as FunnelReportResponse, inScope)
    : null;
  const tasksOpen = scopedReport && states !== null && checklists && deadRead.status === 200 && (!owner || clicks)
    ? taskRows({
      owner,
      alerts: { report: scopedReport, states, brandOfHostname: hostnameBrand(domains) },
      brands: brands.brands.filter((brand) => listedInBrands(scope, brand, statusOf.get(brand.brand_id))),
      checklists,
      templates: templateRows,
      dead: deadRead.body as ConversionsReportResponse,
      clicks,
      domains,
    }).length
    : null;
  return Response.json({ brands_need_fix: brandsShown, templates_awaiting: templatesAwaiting, alerts_open: alertsOpen, tasks_open: tasksOpen }, { headers: { "cache-control": "no-store" } });
}
