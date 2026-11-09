import { AlertStateRow, NotificationLogRow, type AdminRequestContext } from "@anjuna/contracts";
import { InMemorySubmitErrorCounts, formatDigest, formatNotice, loadReportNotices, runAlerts, type Notice, type NotificationMessage } from "@anjuna/insights";
import type { Env } from "../env.js";
import { createNotifier } from "../traffic-tail/alerts.js";
import { loadDigestNumbers } from "../cron.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
async function currentNotices(env: Env): Promise<Notice[]> {
  const report = await runAlerts(env.LEADS, { submitErrorCounts: new InMemorySubmitErrorCounts([]) }, { now: new Date().toISOString() });
  const notices = (await loadReportNotices(env.LEADS, report)).filter(n => n.level !== "ok");
  const { results } = await env.LEADS.prepare("SELECT alert_key,state FROM alert_state WHERE alert_key LIKE 'adsbot:%' AND state<>'ok'").all<{ alert_key: string; state: "warn" | "alert" }>();
  return [...notices, ...results.map(row => ({ key: row.alert_key, rule: "adsbot", brand: row.alert_key.slice(7), level: row.state, metric: "ตรวจพบการเข้าชม" }))];
}
async function audit(env: Env, ctx: AdminRequestContext, action: string, key: string, before: unknown, after: unknown): Promise<void> {
  await env.FACTORY.prepare("INSERT INTO audit_log(actor_id,actor_role,action,entity_type,entity_id,before_json,after_json,created_at) VALUES (?1,?2,?3,'alert',?4,?5,?6,?7)")
    .bind(ctx.actor_id, ctx.actor_role, action, key, JSON.stringify(before), JSON.stringify(after), new Date().toISOString()).run();
}
export async function handleAlertStateRoute(request: Request, env: Env, ctx: AdminRequestContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/admin/notifications/test" && request.method === "POST") {
    if (ctx.actor_role !== "owner") return json({ error: "forbidden" }, 403);
    const notifier = await createNotifier(env);
    const target = notifier.settings.telegram.chat_ids[0];
    if (!target || !notifier.settings.telegram.enabled || !env.TELEGRAM_BOT_TOKEN) return json({ error: "not_configured" }, 409);
    const at = new Date().toISOString();
    const result = await notifier.sendDirect("test:panel", { text: "🟠 ทดสอบการแจ้งเตือน", url: `https://${notifier.host}/alerts` }, at, [target]);
    await audit(env, ctx, "notification.test", "test:panel", null, result[0]);
    return json(result[0]);
  }
  if (path === "/admin/alerts/open-count" && request.method === "GET") {
    const [notices, states] = await Promise.all([currentNotices(env), env.LEADS.prepare("SELECT alert_key,acknowledged_at,closed_at FROM alert_state").all<{ alert_key: string; acknowledged_at: string | null; closed_at: string | null }>()]);
    const hidden = new Set(states.results.filter(row => row.acknowledged_at || row.closed_at).map(row => row.alert_key));
    return json({ alerts_open: notices.filter(n => !hidden.has(n.key)).length });
  }
  if (path === "/admin/alerts/log" && request.method === "GET") {
    const raw = url.searchParams.get("limit") ?? "100";
    if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return json({ error: "invalid" }, 422);
    const { results } = await env.LEADS.prepare("SELECT * FROM notification_log ORDER BY sent_at DESC,id DESC LIMIT ?1").bind(Number(raw)).all();
    return json({ rows: results.map(row => NotificationLogRow.parse(row)) });
  }
  const retry = path.match(/^\/admin\/alerts\/log\/([^/]+)\/retry$/);
  if (retry && request.method === "POST") {
    if (ctx.actor_role !== "owner") return json({ error: "forbidden" }, 403);
    let id: string;
    try { id = decodeURIComponent(retry[1]!); } catch { return json({ error: "invalid" }, 422); }
    const row = await env.LEADS.prepare("SELECT * FROM notification_log WHERE id=?1").bind(id).first<NotificationLogRow>();
    if (!row) return json({ error: "not_found" }, 404);
    const notifier = await createNotifier(env);
    if (!env.TELEGRAM_BOT_TOKEN || !notifier.settings.telegram.enabled || !notifier.settings.telegram.chat_ids.includes(row.target)) return json({ error: "not_configured" }, 409);
    if (row.status !== "failed") return json({ error: "already_sent" }, 409);
    const at = new Date().toISOString();
    let message: NotificationMessage;
    if (/^digest:\d{4}-\d{2}-\d{2}$/.test(row.alert_key)) {
      // A retry log has a new sent_at. Anchor all attempts to the first delivery of this digest key.
      const originalAt = await env.LEADS.prepare("SELECT MIN(sent_at) AS at FROM notification_log WHERE alert_key=?1")
        .bind(row.alert_key).first<string>("at");
      if (!originalAt || !Number.isFinite(Date.parse(originalAt))) return json({ error: "invalid_digest" }, 409);
      message = formatDigest(await loadDigestNumbers(env, new Date(originalAt)), originalAt, notifier.host);
    } else {
      const notice = (await currentNotices(env)).find(n => n.key === row.alert_key);
      if (!notice && row.alert_key !== "test:panel") return json({ error: "alert_resolved" }, 409);
      message = notice ? formatNotice(notice, at, notifier.host) : { text: "🟠 ทดสอบการแจ้งเตือน", url: `https://${notifier.host}/alerts` };
    }
    const result = await notifier.sendDirect(row.alert_key, message, at, [row.target]);
    await audit(env, ctx, "notification.retry", row.id, { status: row.status }, result[0]);
    return json(result[0]);
  }
  const action = path.match(/^\/admin\/alerts\/([^/]+)\/(ack|close)$/);
  if (!action || request.method !== "POST") return undefined;
  let key: string;
  try { key = decodeURIComponent(action[1]!); } catch { return json({ error: "invalid" }, 422); }
  if (!key || key.length > 200) return json({ error: "invalid" }, 422);
  const before = await env.LEADS.prepare("SELECT * FROM alert_state WHERE alert_key=?1").bind(key).first<AlertStateRow>();
  const notice = (await currentNotices(env)).find(n => n.key === key);
  if (!notice) return json({ error: "not_found" }, 404);
  const at = new Date().toISOString();
  // Open a recurred incident and record the user's action in one statement, so cron cannot observe half the change.
  const saved = await env.LEADS.prepare(`INSERT INTO alert_state
    (alert_key,state,first_seen,acknowledged_by,acknowledged_at,closed_at,updated_at)
    VALUES (?1,?2,?3,CASE WHEN ?4='ack' THEN ?5 END,CASE WHEN ?4='ack' THEN ?3 END,CASE WHEN ?4='close' THEN ?3 END,?3)
    ON CONFLICT(alert_key) DO UPDATE SET
      state=excluded.state,
      first_seen=CASE WHEN alert_state.state='ok' THEN excluded.first_seen ELSE alert_state.first_seen END,
      last_sent=CASE WHEN alert_state.state='ok' THEN NULL ELSE alert_state.last_sent END,
      acknowledged_by=CASE WHEN ?4='ack' THEN excluded.acknowledged_by WHEN alert_state.state='ok' THEN NULL ELSE alert_state.acknowledged_by END,
      acknowledged_at=CASE WHEN ?4='ack' THEN excluded.acknowledged_at WHEN alert_state.state='ok' THEN NULL ELSE alert_state.acknowledged_at END,
      closed_at=CASE WHEN ?4='close' THEN excluded.closed_at WHEN alert_state.state='ok' THEN NULL ELSE alert_state.closed_at END,
      updated_at=excluded.updated_at
    WHERE alert_state.updated_at <= excluded.updated_at
    RETURNING *`).bind(key, notice.level, at, action[2], ctx.actor_id).first();
  if (!saved) return json({ error: "state_changed" }, 409);
  const after = AlertStateRow.parse(saved);
  await audit(env, ctx, "alert." + action[2], key, before, after);
  return json(after);
}
