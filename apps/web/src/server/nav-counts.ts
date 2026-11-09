import type { AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";
import { lifecycleBrandRows, readBrandChecklists } from "./lifecycle.js";
import { brandHealth, matchesBrandChip } from "../client/brand-health.js";
import { checklistFlags } from "../client/home-metrics.js";
import type { BrandChecklists } from "../client/api.js";
import { coreNotificationRequest } from "./alerts-state.js";

export async function handleNavCountsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/nav/counts" || request.method !== "GET") return undefined;
  const [brands, checklist, templates, alerts] = await Promise.all([
    lifecycleBrandRows(env, ctx), readBrandChecklists(env, ctx),
    env.FACTORY.prepare("SELECT COUNT(*) AS n FROM template_versions v JOIN templates t ON t.template_id=v.template_id WHERE v.status='certified' AND t.archived_at IS NULL").first<{ n: number }>(),
    coreNotificationRequest(env, ctx, "/admin/alerts/open-count"),
  ]);
  if (brands.core_error || !checklist.ok || !alerts.ok) return Response.json({ error: "unavailable" }, { status: 502 });
  const entries = await checklist.json() as BrandChecklists;
  const count = brands.brands.filter(brand => matchesBrandChip(brandHealth(brand, undefined,
    { checklistFailing: checklistFlags(entries.brands[brand.brand_id]).checklistFailing }), brand, "needs-fix")).length;
  const { alerts_open } = await alerts.json() as { alerts_open: number };
  return Response.json({ brands_need_fix: count, templates_awaiting: templates?.n ?? 0, alerts_open }, { headers: { "cache-control": "no-store" } });
}
