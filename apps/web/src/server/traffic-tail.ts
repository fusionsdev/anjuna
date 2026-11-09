import { adminContextToHeaders, authorize, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";

/** Timeout covers connection only. A healthy SSE stream is allowed to live indefinitely. */
export async function handleTrafficTailRoute(request: Request, env: Env, url: URL, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/traffic/tail" || request.method !== "GET") return undefined;
  if (!authorize("trafficReport", ctx.actor_role).ok) return new Response("forbidden", { status: 403 });
  if (!env.CORE) return new Response("unavailable", { status: 503 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const headers = new Headers(adminContextToHeaders(ctx));
  const lastId = request.headers.get("last-event-id");
  if (lastId) headers.set("last-event-id", lastId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("connect timeout")); }, 5000);
    });
    const upstream = env.CORE.fetch(new Request(`https://core.internal/admin/traffic/tail${url.search}`, { headers, signal: controller.signal }));
    // Service bindings need not honour AbortSignal; discard a response that resolves after timeout.
    void upstream.then(res => { if (controller.signal.aborted) void res.body?.cancel(); }, () => {});
    const response = await Promise.race([upstream, timeout]);
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      return new Response("unavailable", { status: response.status === 422 ? 422 : 503 });
    }
    return new Response(response.body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  } catch { return new Response("unavailable", { status: 503 }); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
