import { AlertStateRow, NotificationLogRow, adminContextToHeaders, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";
import { authorizePanel } from "./panel-roles.js";
import { z } from "zod";

const Count = z.strictObject({ alerts_open: z.number().int().nonnegative() });
const Delivery = z.strictObject({ status: z.enum(["sent", "failed"]), response_code: z.number().int().min(100).max(599).nullable() });
const Log = z.strictObject({ rows: z.array(NotificationLogRow).max(100) });
export async function coreNotificationRequest(env: Env, ctx: AdminRequestContext, path: string, method: "GET" | "POST" = "GET"): Promise<Response> {
  try {
    if (!env.CORE) throw new Error("unavailable");
    const response = await env.CORE.fetch(new Request("https://core.internal" + path, { method, headers: adminContextToHeaders(ctx) }));
    if (!response.ok) return Response.json({ error: "request_failed" }, { status: [403,404,409,422].includes(response.status) ? response.status : 502 });
    const schema = path.includes("/open-count") ? Count : method === "GET" ? Log : /\/(ack|close)$/.test(path) ? AlertStateRow : Delivery;
    return Response.json(schema.parse(await response.json()), { headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "unavailable" }, { status: 502 }); }
}
export async function handleAlertStateRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (request.method === "GET" && path === "/api/alerts/log") return coreNotificationRequest(env, ctx, "/admin/alerts/log" + url.search);
  if (request.method !== "POST") return undefined;
  if (/^\/api\/alerts\/log\/[^/]+\/retry$/.test(path)) {
    if (!authorizePanel("viewSettings", ctx.actor_role).ok) return Response.json({ error: "forbidden" }, { status: 403 });
    return coreNotificationRequest(env, ctx, path.replace("/api/", "/admin/"), "POST");
  }
  if (/^\/api\/alerts\/[^/]+\/(ack|close)$/.test(path)) return coreNotificationRequest(env, ctx, path.replace("/api/", "/admin/"), "POST");
  return undefined;
}
