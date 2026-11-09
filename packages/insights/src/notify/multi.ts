import { NotifySettings, type AlertStateRow } from "@anjuna/contracts";
import type { AlertsReport, Notifier } from "../alerts.js";
import { bangkokTime, formatDigest, formatNotice, panelHost, type DigestNumbers, type Notice, type NotificationMessage } from "./format.js";
import type { DeliveryResult, NotificationChannel } from "./telegram.js";

export const defaultNotifySettings = (): NotifySettings => ({ telegram: { enabled: false, chat_ids: [] }, routing: {}, digest: { enabled: false, time: "09:00" } });
export async function readNotifyConfig(factory: D1Database): Promise<{ settings: NotifySettings; host: string }> {
  const { results } = await factory.prepare("SELECT key, value_json FROM panel_settings WHERE key IN ('notify.telegram','notify.routing','notify.digest','general','general.panel_host')").all<{ key: string; value_json: string }>();
  const values: Record<string, unknown> = {};
  for (const row of results) { try { values[row.key] = JSON.parse(row.value_json); } catch { /* invalid persisted config stays disabled */ } }
  const defaults = defaultNotifySettings();
  const parsed = NotifySettings.safeParse({ telegram: values["notify.telegram"] ?? defaults.telegram,
    routing: values["notify.routing"] ?? defaults.routing, digest: values["notify.digest"] ?? defaults.digest });
  const general = values.general as { panel_host?: unknown } | undefined;
  return { settings: parsed.success ? parsed.data : defaults, host: panelHost(values["general.panel_host"] ?? general?.panel_host) };
}
export function inQuietHours(at: string, quiet: { from: string; to: string } | null): boolean {
  if (!quiet || quiet.from === quiet.to) return false;
  const time = bangkokTime(at);
  return quiet.from < quiet.to ? time >= quiet.from && time < quiet.to : time >= quiet.from || time < quiet.to;
}
export function reportNotices(report: AlertsReport): Notice[] {
  const notices: Notice[] = [];
  const add = (rule: string, brand: string, level: Notice["level"], metric: string) => notices.push({ key: `${rule}:${brand}`, rule, brand, level, metric });
  add("conversion_stalled", "all", report.conversion_stalled.state, `${report.conversion_stalled.detail.stuck_count} รายการ`);
  for (const row of report.brands_without_postbacks.detail.brands) add("brands_without_postbacks", row.brand, "alert", `${row.leads} ลีด`);
  for (const row of report.submit_error_rate.detail.samples) add("submit_error_rate", row.brand,
    row.rate >= report.submit_error_rate.detail.alert_at ? "alert" : "warn", `${(row.rate * 100).toFixed(1)}%`);
  for (const row of report.reject_rate.detail.brands) add("reject_rate", row.brand,
    row.rate >= report.reject_rate.detail.alert_at ? "alert" : "warn", `${(row.rate * 100).toFixed(1)}%`);
  for (const row of report.click_risk.detail.hostnames) add("click_risk", row.hostname, "alert", `${(row.rate * 100).toFixed(1)}%`);
  return notices;
}
const RULES = ["conversion_stalled", "brands_without_postbacks", "submit_error_rate", "reject_rate", "click_risk"];

/** Add brand attribution without changing the existing report contract or alert thresholds. */
export async function loadReportNotices(db: D1Database, report: AlertsReport): Promise<Notice[]> {
  const notices = reportNotices(report).filter(n => n.rule !== "conversion_stalled" && n.rule !== "click_risk");
  if (report.conversion_stalled.state !== "ok") {
    const cutoff = new Date(Date.parse(report.generated_at) - report.conversion_stalled.detail.max_hours * 3_600_000).toISOString();
    const { results } = await db.prepare("SELECT l.brand,COUNT(*) AS n FROM conversion_uploads c JOIN leads l ON l.lead_id=c.lead_id WHERE c.status='pending' AND c.created_at < ?1 GROUP BY l.brand").bind(cutoff).all<{ brand: string; n: number }>();
    for (const row of results) notices.push({ key: "conversion_stalled:" + row.brand, rule: "conversion_stalled", brand: row.brand, level: "alert", metric: row.n + " รายการ" });
  }
  const risks = report.click_risk.detail.hostnames;
  if (risks.length) {
    const { results } = await db.prepare(`SELECT r.value AS hostname, COALESCE((SELECT MIN(b.brand_id) FROM brand_runtime b,json_each(b.hostnames) h
      WHERE lower(h.value)=lower(r.value) OR lower(h.value)='www.' || lower(r.value)),r.value) AS brand FROM json_each(?1) r`)
      .bind(JSON.stringify(risks.map(row => row.hostname))).all<{ hostname: string; brand: string }>();
    const brands = new Map(results.map(row => [row.hostname, row.brand]));
    const grouped = new Map<string, { high: number; visits: number }>();
    for (const row of risks) {
      const brand = brands.get(row.hostname) ?? row.hostname;
      const totals = grouped.get(brand) ?? { high: 0, visits: 0 };
      totals.high += row.high_risk; totals.visits += row.visits; grouped.set(brand, totals);
    }
    for (const [brand, totals] of grouped) notices.push({ key: "click_risk:" + brand, rule: "click_risk", brand, level: "alert", metric: (totals.high * 100 / totals.visits).toFixed(1) + "%" });
  }
  return notices;
}

export class MultiNotifier implements Notifier {
  constructor(private readonly db: D1Database, readonly settings: NotifySettings,
    private readonly telegram: NotificationChannel | null, readonly host = "app.aduplift.ai") {}

  async notify(report: AlertsReport): Promise<void> {
    const notices = await loadReportNotices(this.db, report);
    const keys = new Set(notices.map(n => n.key));
    const { results } = await this.db.prepare("SELECT alert_key FROM alert_state WHERE state <> 'ok'").all<{ alert_key: string }>();
    for (const row of results) {
      const [rule, ...brand] = row.alert_key.split(":");
      if (RULES.includes(rule!) && !keys.has(row.alert_key)) notices.push({ key: row.alert_key, rule: rule!, brand: brand.join(":"), level: "ok", metric: "0" });
    }
    for (const notice of notices) await this.process(notice, report.generated_at);
  }

  async process(notice: Notice, at: string, cooldownMs?: number): Promise<DeliveryResult[]> {
    const before = await this.db.prepare("SELECT * FROM alert_state WHERE alert_key=?1").bind(notice.key).first<AlertStateRow>();
    const resetSend = cooldownMs === undefined && before !== null && notice.level !== "ok" &&
      (before.state === "ok" || (before.state === "warn" && notice.level === "alert"));
    await this.db.prepare(`INSERT INTO alert_state(alert_key,state,first_seen,updated_at) VALUES (?1,?2,?3,?3)
      ON CONFLICT(alert_key) DO UPDATE SET state=excluded.state,
      first_seen=CASE WHEN alert_state.state='ok' AND excluded.state<>'ok' THEN excluded.first_seen ELSE alert_state.first_seen END,
      acknowledged_by=CASE WHEN excluded.state='ok' OR alert_state.state='ok' THEN NULL ELSE alert_state.acknowledged_by END,
      acknowledged_at=CASE WHEN excluded.state='ok' OR alert_state.state='ok' THEN NULL ELSE alert_state.acknowledged_at END,
      closed_at=CASE WHEN excluded.state='ok' OR alert_state.state='ok' THEN NULL ELSE alert_state.closed_at END,
      last_sent=CASE WHEN ?4=1 AND (alert_state.state='ok' OR (alert_state.state='warn' AND excluded.state='alert')) THEN NULL ELSE alert_state.last_sent END,
      updated_at=excluded.updated_at`).bind(notice.key, notice.level, at, resetSend ? 1 : 0).run();
    if (notice.level === "ok") return [];
    const routing = this.settings.routing[notice.rule] ?? { telegram: true, repeat_hours: 6, quiet: null };
    if (!this.telegram || !this.settings.telegram.enabled || !routing.telegram || !this.settings.telegram.chat_ids.length || inQuietHours(at, routing.quiet)) return [];
    if (before?.state !== "ok" && (before?.acknowledged_at || before?.closed_at)) return [];
    const elapsed = before?.last_sent ? Date.parse(at) - Date.parse(before.last_sent) : Infinity;
    if (cooldownMs !== undefined && elapsed < cooldownMs) return [];
    const transition = !before || before.state === "ok" || (before.state === "warn" && notice.level === "alert");
    if (!transition && elapsed < (cooldownMs ?? routing.repeat_hours * 3_600_000)) return [];
    // Claim the send atomically across cron/fast-path requests. An acknowledgement made during evaluation wins.
    const claim = await this.db.prepare(`UPDATE alert_state SET last_sent=?1 WHERE alert_key=?2 AND state=?3
      AND acknowledged_at IS NULL AND closed_at IS NULL AND last_sent IS ?4`).bind(at, notice.key, notice.level, resetSend ? null : before?.last_sent ?? null).run();
    if (!claim.meta.changes) return [];
    return this.sendDirect(notice.key, formatNotice(notice, at, this.host), at);
  }

  async sendDirect(key: string, message: NotificationMessage, at: string, targets = this.settings.telegram.chat_ids): Promise<DeliveryResult[]> {
    if (!this.telegram || !this.settings.telegram.enabled) return [];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message.text));
    const bodyHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const results: DeliveryResult[] = [];
    for (const target of new Set(targets)) {
      const result = await this.telegram.send(target, message);
      await this.db.prepare(`INSERT INTO notification_log(id,channel,target,alert_key,status,response_code,body_hash,sent_at)
        VALUES (?1,'telegram',?2,?3,?4,?5,?6,?7)`).bind(crypto.randomUUID(), target, key, result.status, result.response_code, bodyHash, at).run();
      results.push(result);
    }
    return results;
  }

  digestDue(at: string): boolean {
    if (!this.settings.digest.enabled || !this.telegram || !this.settings.telegram.enabled || !this.settings.telegram.chat_ids.length) return false;
    const local = new Date(Date.parse(at) + 7 * 3_600_000).toISOString();
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const elapsed = (minutes(local.slice(11, 16)) - minutes(this.settings.digest.time) + 1440) % 1440;
    return elapsed >= 0 && elapsed < 15 && !inQuietHours(at, this.settings.routing.digest?.quiet ?? null) && this.settings.routing.digest?.telegram !== false;
  }

  async digest(values: DigestNumbers, at: string): Promise<void> {
    if (!this.digestDue(at)) return;
    const scheduled = new Date(Date.parse(at) + 7 * 3_600_000);
    if (scheduled.toISOString().slice(11, 16) < this.settings.digest.time) scheduled.setUTCDate(scheduled.getUTCDate() - 1);
    const local = scheduled.toISOString();
    const key = `digest:${local.slice(0, 10)}`;
    const claimed = await this.db.prepare(`INSERT OR IGNORE INTO alert_state(alert_key,state,first_seen,last_sent,updated_at) VALUES (?1,'ok',?2,?2,?2)`).bind(key, at).run();
    if (claimed.meta.changes) await this.sendDirect(key, formatDigest(values, at, this.host), at);
  }
}
