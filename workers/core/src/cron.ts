/**
 * Scheduled handlers (CO-7, FA-5). Exact cron strings dispatch mailing, alert checks and the daily digest.
 * Anything else is ignored, so a trigger added later cannot run the wrong job.
 */
import {
  InMemorySubmitErrorCounts,
  runAlerts,
  type AlertsReport,
  type Notifier,
  type SubmitErrorCountsSource,
  reportNotices,
  RULE_TEXT,
} from "@anjuna/insights";
import { DEFAULT_THB_PER_USD, FX_THB_PER_USD_KEY } from "@anjuna/contracts";
import { ListmonkClient, brandListIds, syncOutbox, syncSuppressions } from "@anjuna/mailing";
import type { Env } from "./env.js";
import { fallbackListMap } from "./listmonk-config.js";
import { createNotifier } from "./traffic-tail/alerts.js";
import { loadSpendReport } from "./spend.js";

export const MAILING_CRON = "*/5 * * * *";
export const ALERTS_CRON = "*/15 * * * *";
export const DIGEST_CRON = "0 2 * * *";
/** Batches of 50 per run; a larger backlog continues on the next trigger. */
export const MAX_OUTBOX_BATCHES = 5;

export interface CronDeps {
  listmonk?: ListmonkClient;
  notifier?: Notifier;
  submitErrorCounts?: SubmitErrorCountsSource;
}

export interface MailingRunResult {
  ran: boolean;
  reason?: "not_configured" | "invalid_list_map";
  batches?: number;
}

/** Outbox -> listmonk, then listmonk -> suppressions. Throws on a listmonk outage so the run shows as failed. */
export async function runMailing(env: Env, deps: CronDeps = {}): Promise<MailingRunResult> {
  const listmonk = deps.listmonk ??
    (env.LISTMONK_URL && env.LISTMONK_USER && env.LISTMONK_TOKEN
      ? new ListmonkClient(env.LISTMONK_URL, env.LISTMONK_USER, env.LISTMONK_TOKEN)
      : null);
  if (!listmonk) {
    console.warn("mailing cron skipped: LISTMONK_URL, LISTMONK_USER and LISTMONK_TOKEN are not all set");
    return { ran: false, reason: "not_configured" };
  }
  // Each brand sends to its own list (brand_runtime.listmonk_list_id, created at install); the map covers brands without one.
  const listMap = fallbackListMap(env.LISTMONK_LIST_MAP);
  if (!listMap) {
    console.error("mailing cron skipped: LISTMONK_LIST_MAP, when set, must be a JSON object of brand_id -> positive list id");
    return { ran: false, reason: "invalid_list_map" };
  }

  let batches = 0;
  while (batches < MAX_OUTBOX_BATCHES) {
    batches++;
    if ((await syncOutbox(env.LEADS, listmonk, { listMap })) === 0) break;
  }
  await syncSuppressions(env.LEADS, listmonk, [...new Set([...Object.values(listMap), ...await brandListIds(env.LEADS)])]);
  return { ran: true, batches };
}

/** Runs the five alerts as of `scheduledTime`; the notifier only hears about warn/alert states. */
export async function runAlertsCron(env: Env, scheduledTime: number, deps: CronDeps = {}): Promise<AlertsReport> {
  const report = await runAlerts(
    env.LEADS,
    // Submit error counts come from Analytics Engine later; until then this source is empty (state ok).
    { submitErrorCounts: deps.submitErrorCounts ?? new InMemorySubmitErrorCounts([]) },
    { now: new Date(scheduledTime).toISOString() },
  );
  const states = [
    report.conversion_stalled.state,
    report.brands_without_postbacks.state,
    report.submit_error_rate.state,
    report.reject_rate.state,
    report.click_risk.state,
  ];
  if (deps.notifier) {
    if (states.some((state) => state !== "ok")) await deps.notifier.notify(report);
  } else {
    // Clear acknowledged/closed incidents on recovery, including all-ok reports.
    await (await createNotifier(env)).notify(report);
  }
  return report;
}

/** Same UTC day boundaries and FX setting as the panel. Digest summarizes the completed previous day. */
export async function runDigest(env: Env, scheduledTime: number): Promise<void> {
  const notifier = await createNotifier(env);
  const now = new Date(scheduledTime);
  if (!notifier.digestDue(now.toISOString())) return;
  const spend = await loadSpendReport(env, "yesterday", now);
  const from = `${spend.from}T00:00:00.000Z`;
  const to = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [leads, sold, fx, report] = await Promise.all([
    env.LEADS.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?1 AND created_at < ?2").bind(from, to).first<{ n: number }>(),
    env.LEADS.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(payout),0) AS revenue FROM postback_events WHERE event_type='soldLead' AND created_at >= ?1 AND created_at < ?2").bind(from, to).first<{ n: number; revenue: number }>(),
    env.FACTORY.prepare("SELECT value_json FROM panel_settings WHERE key=?1").bind(FX_THB_PER_USD_KEY).first<{ value_json: string }>(),
    runAlerts(env.LEADS, { submitErrorCounts: new InMemorySubmitErrorCounts([]) }, { now: now.toISOString() }),
  ]);
  let rate: number = DEFAULT_THB_PER_USD;
  try { const value = JSON.parse(fx?.value_json ?? "null") as unknown; if (typeof value === "number" && Number.isFinite(value) && value > 0) rate = value; } catch { /* default matches panel */ }
  const cost = spend.totals.cost_by_currency.USD + spend.totals.cost_by_currency.THB / rate;
  const count = leads?.n ?? 0;
  const fixes = reportNotices(report).filter(n => n.level !== "ok").sort((a, b) => Number(b.level === "alert") - Number(a.level === "alert"));
  const first = fixes[0];
  await notifier.digest({ spend: cost, leads: count, cpl: count ? cost / count : 0, sold: sold?.n ?? 0,
    profit: (sold?.revenue ?? 0) - cost, top_fix: first ? `${RULE_TEXT[first.rule]} · ${first.brand}` : "ไม่มี" }, now.toISOString());
}

/** B-01 retention: expired duplicate snapshots are cleared even if their token is never claimed. */
export async function purgeExpiredApplicants(env: Env, scheduledTime: number): Promise<void> {
  await env.LEADS.prepare("UPDATE continuations SET applicant_json = NULL WHERE applicant_json IS NOT NULL AND expires_at <= ?1")
    .bind(new Date(scheduledTime).toISOString()).run();
}

export async function handleScheduled(
  controller: { cron: string; scheduledTime: number },
  env: Env,
  deps: CronDeps = {},
): Promise<void> {
  switch (controller.cron) {
    case MAILING_CRON:
      await purgeExpiredApplicants(env, controller.scheduledTime);
      await runMailing(env, deps);
      return;
    case ALERTS_CRON:
      await runAlertsCron(env, controller.scheduledTime, deps);
      await runDigest(env, controller.scheduledTime);
      return;
    case DIGEST_CRON:
      await runDigest(env, controller.scheduledTime);
      return;
    default:
      console.warn(`ignoring unknown cron trigger ${JSON.stringify(controller.cron)}`);
  }
}
