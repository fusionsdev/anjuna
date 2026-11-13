import { ALERT_STATES_PAGE_MAX, AlertStatesResponse, TEMPLATE_VERSION_REVIEW_STATUS, UserPrefs, type AdminRequestContext, type AlertStateRow, type AlertsReportResponse, type BrandSummary, type TemplateVersionStatusName } from "@anjuna/contracts";
import type { Env } from "./env.js";
import { callCore } from "./core.js";
import { lifecycleBrandRows } from "./lifecycle.js";
import { coreNotificationRequest } from "./alerts-state.js";
import { DEFAULT_SCOPE, scopeFromPrefs, type BrandScope } from "../client/brand-scope.js";
import { scopeAlerts } from "../client/home-metrics.js";
import { awaitingApproval, listedInBrands, scopeTest } from "../client/task-counts.js";
import { hostnameBrand, openAlertCount } from "../client/alert-incidents.js";

/** The brand scope the user saved (GET /api/me/prefs). A `?scope=` link only lives in the browser, so the badge follows the saved one. */
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
 * A failed factory or core brand read answers 502: the brands badge cannot be counted.
 */
export async function handleNavCountsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/nav/counts" || request.method !== "GET") return undefined;
  const [brands, runtime, templates, report, states, scope] = await Promise.all([
    lifecycleBrandRows(env, ctx),
    callCore(env, ctx, { endpoint: "listBrands" }),
    env.FACTORY.prepare("SELECT v.status, t.archived_at IS NOT NULL AS archived FROM template_versions v JOIN templates t ON t.template_id=v.template_id").all<{ status: string; archived: number }>(),
    callCore(env, ctx, { endpoint: "alertsReport" }),
    alertStates(env, ctx),
    savedScope(env, ctx),
  ]);
  if (brands.core_error) return Response.json({ error: "unavailable" }, { status: 502 });
  // Core's brand list gives the paused status and the hostnames. Like the screens, a failed read leaves both unknown and counts on.
  const runtimeBrands = runtime.status === 200 ? (runtime.body as { brands: BrandSummary[] }).brands : [];
  const statusOf = new Map(runtimeBrands.map((brand) => [brand.brand_id, brand.status as string]));
  const brandsShown = brands.brands.filter((brand) => listedInBrands(scope, brand, statusOf.get(brand.brand_id))).length;
  const templatesAwaiting = templates.results.filter((row) => awaitingApproval({
    status: TEMPLATE_VERSION_REVIEW_STATUS[row.status as TemplateVersionStatusName] ?? "checking", archived: Boolean(row.archived),
  })).length;
  // brand_id to domain in the order the Alerts screen builds it (buildBrandLabels): the factory domain wins over core's hostname.
  const domains = new Map<string, string>();
  for (const brand of runtimeBrands) if (brand.hostnames?.[0]) domains.set(brand.brand_id, brand.hostnames[0]);
  for (const brand of brands.brands) if (brand.hostnames[0]) domains.set(brand.brand_id, brand.hostnames[0]);
  const alertsOpen = report.status === 200 && states !== null
    ? openAlertCount(scopeAlerts(report.body as AlertsReportResponse, scopeTest(scope, brands.brands, (id) => statusOf.get(id))), states, hostnameBrand(domains))
    : null;
  return Response.json({ brands_need_fix: brandsShown, templates_awaiting: templatesAwaiting, alerts_open: alertsOpen }, { headers: { "cache-control": "no-store" } });
}
