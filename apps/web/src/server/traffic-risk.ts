/**
 * Click risk panel API (FUS-372), proxied to core's read-only admin routes.
 *   GET /api/traffic/risk?period=                    -> TrafficRiskResponse (employee and owner)
 *   GET /api/traffic/risk/export?period=&hostname=   -> CSV of high-risk visits (owner only)
 * The score is observe-only: nothing here changes what a visitor sees.
 */
import {
  RISK_EXPORT_COLUMNS,
  TrafficRiskExportResponse,
  authorize,
  type AdminRequestContext,
} from "@anjuna/contracts";
import { callCore, type CoreResult } from "./core.js";
import { csvRows } from "./csv.js";
import type { Env } from "./env.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);

export { csvCell } from "./csv.js";

export function riskCsv(body: TrafficRiskExportResponse): string {
  return csvRows(
    RISK_EXPORT_COLUMNS,
    body.rows.map((row) => ({ ...row, signals: row.signals.join(";") })),
  );
}

export async function handleTrafficRiskRoute(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  ctx: AdminRequestContext,
): Promise<Response | null> {
  if (request.method !== "GET") return null;

  if (path === "/api/traffic/risk") {
    const g = authorize("trafficRisk", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: ctx.request_id });
    return fromCore(await callCore(env, ctx, { endpoint: "trafficRisk", query: url.searchParams }));
  }

  if (path === "/api/traffic/risk/export") {
    // Owner only: the export carries gclids for a Google Ads refund request.
    const g = authorize("trafficRiskExport", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: ctx.request_id });
    const result = await callCore(env, ctx, { endpoint: "trafficRiskExport", query: url.searchParams });
    if (result.status !== 200) return fromCore(result);
    const body = TrafficRiskExportResponse.parse(result.body);
    const period = url.searchParams.get("period") || "7d";
    const hostname = url.searchParams.get("hostname");
    // Both values passed the contract schema in core, so they are safe in a file name.
    const name = `click-risk-${period}${hostname ? `-${hostname}` : ""}.csv`;
    return new Response(riskCsv(body), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-export-truncated": body.truncated ? "true" : "false",
      },
    });
  }

  return null;
}
