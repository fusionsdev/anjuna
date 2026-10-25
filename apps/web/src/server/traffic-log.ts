/**
 * Traffic report and client error log API (FUS-379), proxied to core's read-only admin routes.
 *   GET /api/traffic/report?period=                              -> TrafficReportResponse
 *   GET /api/traffic/report.csv?period=                          -> CSV of the recent events
 *   GET /api/client-errors?period=&brand_id=&error_type=&cursor= -> ClientErrorsResponse
 * Employee and owner both read these; core nulls `error_message` for an employee.
 */
// spec traffic
import {
  ClientErrorsQuery,
  TRAFFIC_RECENT_COLUMNS,
  TrafficReportQuery,
  TrafficReportResponse,
  authorize,
  type AdminRequestContext,
} from "@anjuna/contracts";
import type { z } from "zod";
import { callCore, type CoreResult } from "./core.js";
import { csvRows } from "./csv.js";
import type { Env } from "./env.js";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fromCore = (r: CoreResult): Response => json(r.status, r.body);
const invalid = (error: z.ZodError, requestId: string): Response =>
  json(422, {
    error: "invalid",
    request_id: requestId,
    issues: error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });

export function trafficCsv(body: TrafficReportResponse): string {
  return csvRows(TRAFFIC_RECENT_COLUMNS, body.recent);
}

export async function handleTrafficLogRoute(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  ctx: AdminRequestContext,
): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const rid = ctx.request_id;

  if (path === "/api/traffic/report" || path === "/api/traffic/report.csv") {
    const g = authorize("trafficReport", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const q = TrafficReportQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    const result = await callCore(env, ctx, { endpoint: "trafficReport", query: url.searchParams });
    if (path === "/api/traffic/report" || result.status !== 200) return fromCore(result);
    return new Response(trafficCsv(TrafficReportResponse.parse(result.body)), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        // The period is one of three enum values, so it is safe in a file name.
        "content-disposition": `attachment; filename="traffic-${q.data.period}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/api/client-errors") {
    const g = authorize("clientErrors", ctx.actor_role);
    if (!g.ok) return json(403, { ...g.error, request_id: rid });
    const q = ClientErrorsQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!q.success) return invalid(q.error, rid);
    return fromCore(await callCore(env, ctx, { endpoint: "clientErrors", query: url.searchParams }));
  }

  return undefined;
}
