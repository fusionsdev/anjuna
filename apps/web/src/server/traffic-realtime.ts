import { TrafficRealtimeQuery, TrafficRealtimeResponse, adminContextToHeaders, authorize, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";

export async function handleTrafficRealtimeRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/traffic/realtime" || request.method !== "GET") return undefined;
  if (!authorize("trafficReport", ctx.actor_role).ok) return new Response("forbidden", { status: 403 });
  const query = TrafficRealtimeQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return Response.json({ error: "invalid" }, { status: 422 });
  try {
    if (!env.CORE) throw new Error("unavailable");
    const response = await env.CORE.fetch(new Request(`https://core.internal/admin/traffic/realtime${url.search}`, { headers: adminContextToHeaders(ctx) }));
    if (!response.ok) return Response.json({ error: "unavailable" }, { status: 502 });
    return Response.json(TrafficRealtimeResponse.parse(await response.json()), { headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "unavailable" }, { status: 502 }); }
}
