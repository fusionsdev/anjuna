import { NotifySettings, type AdminRequestContext } from "@anjuna/contracts";
import type { Env } from "./env.js";
import { authorizePanel } from "./panel-roles.js";
import { coreNotificationRequest } from "./alerts-state.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function readSettings(db: D1Database): Promise<NotifySettings> {
  const value = { telegram: { enabled: false, chat_ids: [] }, routing: {}, digest: { enabled: false, time: "09:00" } };
  const { results } = await db.prepare("SELECT key,value_json FROM panel_settings WHERE key IN ('notify.telegram','notify.routing','notify.digest')").all<{ key: string; value_json: string }>();
  for (const row of results) Object.assign(value, { [row.key.slice(7)]: JSON.parse(row.value_json) });
  return NotifySettings.parse(value);
}
export async function handleNotifySettingsRoute(request: Request, env: Env, path: string, ctx: AdminRequestContext): Promise<Response | undefined> {
  if (!(path === "/api/settings/notify" && ["GET", "PUT"].includes(request.method)) && !(path === "/api/settings/notify/test" && request.method === "POST")) return undefined;
  if (!authorizePanel("viewSettings", ctx.actor_role).ok) return json({ error: "forbidden" }, 403);
  if (path.endsWith("/test")) return coreNotificationRequest(env, ctx, "/admin/notifications/test", "POST");
  if (request.method === "GET") return json(await readSettings(env.FACTORY));
  const text = await request.text();
  if (text.length > 65_536) return json({ error: "too_large" }, 413);
  let input: unknown;
  try { input = JSON.parse(text); } catch { return json({ error: "invalid" }, 422); }
  const parsed = NotifySettings.safeParse(input);
  if (!parsed.success) return json({ error: "invalid" }, 422);
  const before = await readSettings(env.FACTORY);
  const at = new Date().toISOString();
  await env.FACTORY.batch([
    ...Object.entries(parsed.data).map(([key, value]) => env.FACTORY.prepare(
      "INSERT INTO panel_settings(key,value_json,updated_by,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
    ).bind("notify." + key, JSON.stringify(value), ctx.actor_id, at)),
    env.FACTORY.prepare("INSERT INTO audit_log(actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?1,?2,'settings.notify','panel_setting','notify',?3,?4,?5)")
      .bind(ctx.actor_id, ctx.actor_role, JSON.stringify(before), JSON.stringify(parsed.data), at),
  ]);
  return json(parsed.data);
}
