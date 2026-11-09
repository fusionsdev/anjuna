import { BrandId, TrafficTailEvent } from "@anjuna/contracts";
import type { Env } from "../env.js";

export function classifyUserAgent(ua: string): TrafficTailEvent["user_agent_family"] {
  if (/AdsBot-Google/i.test(ua)) return "adsbot";
  if (/Googlebot/i.test(ua)) return "googlebot";
  if (/bot|crawl|spider|headless|puppeteer|phantom|slurp|bingpreview/i.test(ua)) return "other-bot";
  return ua ? "browser" : "unknown";
}
export async function tailSessionRef(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
export async function pushTail(env: Env, event: TrafficTailEvent): Promise<void> {
  if (!env.TRAFFIC_TAIL) return;
  try {
    const stub = env.TRAFFIC_TAIL.get(env.TRAFFIC_TAIL.idFromName("tail"));
    const response = await stub.fetch("https://tail.internal/internal/traffic-tail/push", { method: "POST", body: JSON.stringify(TrafficTailEvent.parse(event)), signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
  } catch { console.warn("traffic_tail_unavailable"); }
}
export async function subscribeTail(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const brands = url.searchParams.getAll("brand").flatMap(b => b.split(",")).filter(Boolean);
  if (brands.length > 500 || brands.some(b => !BrandId.safeParse(b).success)) return Response.json({ error: "invalid" }, { status: 422 });
  if (!env.TRAFFIC_TAIL) return new Response("unavailable", { status: 503 });
  try {
    const target = new URL("https://tail.internal/sse");
    if (brands.length) target.searchParams.set("brand", brands.join(","));
    const headers = new Headers();
    const lastId = request.headers.get("last-event-id");
    if (lastId) headers.set("last-event-id", lastId);
    return await env.TRAFFIC_TAIL.get(env.TRAFFIC_TAIL.idFromName("tail")).fetch(target, { headers, signal: request.signal });
  } catch { return new Response("unavailable", { status: 503 }); }
}
