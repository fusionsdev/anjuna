/**
 * Campaigns screen routes (T13 Part B). Every route proxies core's campaign job API; the panel never calls AdKit.
 *
 *   GET  /api/ads/campaigns                      employee  core GET  /admin/adkit/campaigns
 *   POST /api/ads/campaigns/draft                employee  core POST /admin/adkit/campaign-jobs (campaign.draft.create)
 *   POST /api/ads/campaigns/:id/enable           owner     core POST /admin/adkit/campaign-jobs (campaign.enable)
 *   POST /api/ads/campaigns/:id/pause            owner     core POST /admin/adkit/campaign-jobs (campaign.pause)
 *   POST /api/ads/campaigns/:id/status-check     employee  core POST /admin/adkit/campaign-jobs (campaign.status_check)
 *
 * Enable is the only job that spends money. This file checks the owner role before core is called; core checks it
 * again (CAMPAIGN_JOB_ROLES) and checks the baht caps. The UI hiding the button is never the gate.
 */
import { CampaignJobCreateRequest, GoogleCampaignId, authorize, type AdminRequestContext } from "@anjuna/contracts";
import { callCore, type CoreResult } from "./core.js";
import type { Env } from "./env.js";
import { decodePathSegment } from "./lifecycle.js";
import { authorizePanel, type PanelAction } from "./panel-roles.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

const ACTIONS = {
  enable: { kind: "campaign.enable", panel: "enableCampaign" },
  pause: { kind: "campaign.pause", panel: "pauseCampaign" },
  "status-check": { kind: "campaign.status_check", panel: "checkCampaignStatus" },
} as const satisfies Record<string, { kind: CampaignJobCreateRequest["kind"]; panel: PanelAction }>;

/** Both gates: the panel action, then core's endpoint role. Null when allowed. */
function denied(ctx: AdminRequestContext, panel: PanelAction, endpoint: "listCampaigns" | "createCampaignJob"): Response | null {
  const gate = authorizePanel(panel, ctx.actor_role);
  if (!gate.ok) return json(403, { ...gate.error, request_id: ctx.request_id });
  const core = authorize(endpoint, ctx.actor_role);
  if (!core.ok) return json(403, { ...core.error, request_id: ctx.request_id });
  return null;
}

export async function handleCampaignsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/ads/campaigns" && !path.startsWith("/api/ads/campaigns/")) return undefined;
  const { method } = request;

  if (path === "/api/ads/campaigns" && method === "GET") {
    const no = denied(ctx, "viewCampaigns", "listCampaigns");
    if (no) return no;
    return fromCore(await callCore(env, ctx, { endpoint: "listCampaigns" }));
  }

  if (path === "/api/ads/campaigns/draft" && method === "POST") {
    const no = denied(ctx, "createCampaignDraft", "createCampaignJob");
    if (no) return no;
    const raw: unknown = await request.json().catch(() => null);
    // The browser sends the draft fields only; a `kind` of its own is refused, never overwritten.
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) && !("kind" in raw)
      ? CampaignJobCreateRequest.safeParse({ ...raw, kind: "campaign.draft.create" })
      : null;
    if (!body?.success) {
      const issues = body ? body.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) : [{ path: "body", message: "Expected the draft fields" }];
      return json(422, { error: "invalid", request_id: ctx.request_id, issues });
    }
    return fromCore(await callCore(env, ctx, { endpoint: "createCampaignJob", body: body.data }));
  }

  const m = path.match(/^\/api\/ads\/campaigns\/([^/]+)\/(enable|pause|status-check)$/);
  if (m && method === "POST") {
    const action = ACTIONS[m[2] as keyof typeof ACTIONS];
    const no = denied(ctx, action.panel, "createCampaignJob");
    if (no) return no;
    const raw = decodePathSegment(m[1]!);
    const id = raw === null ? null : GoogleCampaignId.safeParse(raw);
    if (!id?.success) return json(404, { error: "not_found", resource: "campaign", request_id: ctx.request_id });
    // The request body is ignored: core reads budget, brand and account from the campaign's own jobs.
    return fromCore(await callCore(env, ctx, { endpoint: "createCampaignJob", body: { kind: action.kind, campaign_id: id.data } }));
  }

  return undefined;
}
