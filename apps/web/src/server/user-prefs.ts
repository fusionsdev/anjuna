import { UserPrefs, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";

const defaults = (): UserPrefs => ({ brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: {} });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function handleUserPrefsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (path !== "/api/me/prefs" || !["GET", "PUT"].includes(request.method)) return undefined;
  if (request.method === "GET") {
    const { results } = await env.AUTH.prepare("SELECT key,value_json FROM user_prefs WHERE user_id=?1 AND key IN ('brand_scope','saved_views')").bind(ctx.actor_id).all<{ key: string; value_json: string }>();
    const value = defaults();
    for (const row of results) Object.assign(value, { [row.key]: JSON.parse(row.value_json) });
    return json(UserPrefs.parse(value));
  }
  const text = await request.text();
  if (text.length > 65_536) return json({ error: "too_large" }, 413);
  let input: unknown;
  try { input = JSON.parse(text); } catch { return json({ error: "invalid" }, 422); }
  const parsed = UserPrefs.safeParse(input);
  if (!parsed.success) return json({ error: "invalid" }, 422);
  const at = new Date().toISOString();
  await env.AUTH.batch(Object.entries(parsed.data).map(([key, value]) => env.AUTH.prepare(
    "INSERT INTO user_prefs(user_id,key,value_json,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  ).bind(ctx.actor_id, key, JSON.stringify(value), at)));
  return json(parsed.data);
}
